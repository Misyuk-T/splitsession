import { Wakeups } from "../../core";
import type { Logger } from "../log";

/** A tab SplitSession created stays "its own" this long after its creation flow ended (`state`). */
const OWN_TAB_MS = 5_000;
const BLANK_COMMIT_WAIT_MS = 3_000;

/**
 * The tabs SplitSession creates itself: known as its own before anyone can ask (the group guard must not take a tab
 * SplitSession is placing for one a person or Chrome put into a group), and created at a committed about:blank.
 */
export class OwnTabs {
  /** `tabs.create` calls of SplitSession still under way, and the tabs it created (busy: their creation flow still runs). */
  private readonly creating = new Set<Promise<unknown>>();
  private readonly tabs = new Map<number, { busy: boolean; at: number }>();
  /** Tabs whose initial about:blank has committed (`createBlank` waits for it). */
  private readonly blankCommitted = new Set<number>();
  private readonly blankWakeups = new Wakeups();

  constructor(private readonly log: Logger) {}

  /**
   * Wraps a `tabs.create` of SplitSession's: the tab is known as its own before anyone can ask (`state`). Call `done`
   * when the tab is where SplitSession wants it (in its container, or decided plain).
   */
  track<T extends { id?: number }>(creation: Promise<T>): Promise<T> {
    const tracked = creation.then((tab) => {
      if (tab.id !== undefined)
        this.tabs.set(tab.id, { busy: true, at: Date.now() });
      return tab;
    });
    this.creating.add(tracked);
    const drop = () => void this.creating.delete(tracked);
    tracked.then(drop, drop);
    return tracked;
  }

  done(tabId: number): void {
    if (this.tabs.has(tabId))
      this.tabs.set(tabId, { busy: false, at: Date.now() });
  }

  /**
   * Whether SplitSession created this tab itself: 'busy' while it is still being set up (assigned, navigated), 'own' for a
   * few seconds afterwards, null otherwise. Waits for SplitSession's `tabs.create` calls still under way first.
   */
  async state(tabId: number): Promise<"busy" | "own" | null> {
    if (this.creating.size > 0) await Promise.allSettled([...this.creating]);
    const now = Date.now();
    for (const [id, entry] of this.tabs)
      if (!entry.busy && now - entry.at > OWN_TAB_MS) this.tabs.delete(id);
    const entry = this.tabs.get(tabId);
    return entry ? (entry.busy ? "busy" : "own") : null;
  }

  /** `webNavigation.onCommitted` of about:blank in a tab's top frame. */
  blankCommittedIn(tabId: number): void {
    this.blankCommitted.add(tabId);
    this.blankWakeups.wake();
  }

  forgetTab(tabId: number): void {
    this.tabs.delete(tabId);
    this.blankCommitted.delete(tabId);
  }

  /**
   * A new tab at about:blank (`creation`: the `tabs.create` call), returned once that initial page has COMMITTED.
   * `tabs.create` returns while the blank load is still pending; a `tabs.update({ url })` issued meanwhile starts its
   * request, and then the blank page commits over it: the tab stays blank ("unloaded") although the request succeeded.
   */
  async createBlank<T extends { id?: number }>(
    creation: Promise<T>,
  ): Promise<T> {
    const tab = await this.track(creation);
    const id = tab.id;
    if (id === undefined) return tab;
    if (!this.blankCommitted.has(id)) {
      await this.blankWakeups.until(
        () => (this.blankCommitted.has(id) ? true : null),
        BLANK_COMMIT_WAIT_MS,
        () => {
          this.log("warn", `tab ${id}: about:blank did not commit in time`);
          return null;
        },
      );
    }
    this.blankCommitted.delete(id);
    return tab;
  }
}
