import { type ContainerId, isHttpUrl, sleep } from "../core";

export interface GuardTab {
  id?: number;
  url?: string;
  pendingUrl?: string;
  groupId: number;
  /** 'unloaded': Chrome has not loaded the tab (restored lazily). */
  status?: string;
  discarded?: boolean;
}

export interface GroupGuardDeps {
  getTab(tabId: number): Promise<GuardTab | null>;
  /** Every tab that is in some group, in every window. */
  groupedTabs(): Promise<GuardTab[]>;
  /** The container a tab group stands for (its invisible title marker), or null for any other group. */
  groupContainer(groupId: number): Promise<ContainerId | null>;
  /** Resolves when the group projection has done what is queued (a tab SplitSession just assigned is regrouped by then). */
  groupsIdle(): Promise<void>;
  containerOf(tabId: number): ContainerId | null;
  /** SplitSession is putting the tab into a container right now (assignment under way, a popup child inheriting). */
  isAssigning(tabId: number): boolean;
  /** The restore holds the tab back: its request is blocked, or it shows SplitSession's waiting page. */
  isWaiting(tabId: number): boolean;
  /** Created by SplitSession: 'busy' while it is still being set up, 'own' for a few seconds after, null otherwise. */
  ownTab(tabId: number): Promise<"busy" | "own" | null>;
  containerName(id: ContainerId): string | undefined;
  /** Assigns the tab where it stands, loading nothing (a held tab goes to its address in the container). */
  assignInPlace(tabId: number, containerId: ContainerId): Promise<void>;
  /**
   * Opens `url` in a fresh tab of the container at the old tab's place (`Facet.replaceTab`) and closes the old tab.
   * Throws when nothing was created. Resolves with the new tab's ID.
   */
  move(tabId: number, containerId: ContainerId, url: string): Promise<number>;
  /** A tab SplitSession created landed in this group: into its own container's group, or out of the group. */
  placeOwn(tabId: number, containerId: ContainerId | null): Promise<void>;
  moved(newTabId: number, containerId: ContainerId, name: string): void;
  /** The periodic sweep (an alarm) runs while some group stands for a container. */
  periodic(on: boolean): void;
  log(level: "info" | "warn" | "error", message: string, data?: unknown): void;
  delay?(ms: number): Promise<void>;
  now?(): number;
}

/** After a tab joined a group: the user may still be dragging it over other groups. */
export const SETTLE_MS = 300;
/** A website tab Chrome created inside a group: a link's inheritance from its opener goes first. */
export const CREATED_SETTLE_MS = 150;
/** Tab and group events are followed by one sweep this long after the last of them. */
export const SWEEP_DEBOUNCE_MS = 1_000;
const RETRY_MS = 250;
/** Chrome refuses tab edits while the user holds a dragged tab: about this long (20 s) a check keeps waiting for the drop. */
const MAX_ATTEMPTS = 80;
const RATE_WINDOW_MS = 10_000;
const RATE_LIMIT = 10;

const dragRefusal = (error: unknown): boolean =>
  /cannot be edited|dragging/i.test(String((error as Error)?.message ?? error));

type Action = "reopened" | "assigned in place" | "regrouped" | "ungrouped";

/**
 * "The group always tells the truth" (docs/decisions.md, "Tabs inside a SplitSession group"): every tab inside a tab group
 * that carries the marker of a container is in that container. A group looks like the container; a tab in it that is
 * not would be logged in as someone else under the container's name.
 *
 * How a tab gets in, and what is done:
 * - Chrome creates it inside the group ("New tab to the right", the group's "New tab in group", a link or address opened
 *   next to a grouped tab): `tabs.onCreated` already carries the `groupId`, and no `onUpdated` follows. The new tab page
 *   has made no request: it is assigned at once, so what the user types loads in the container.
 * - The user drags it in (`tabs.onUpdated` with a new `groupId`): after `SETTLE_MS` a website is reopened in a fresh tab
 *   of the container (`move`), retried while Chrome refuses edits during the drag.
 * - Anything else (another window's tab dropped into the group, a state left over from before, a missed event): the
 *   sweep, `SWEEP_DEBOUNCE_MS` after tab and group events, at the worker's start and every 30 s while such a group exists.
 *
 * A tab that has loaded nothing (not a website, Chrome has not loaded it, it is discarded, or the restore holds it) is
 * assigned where it stands; a loaded website is reopened (`move`: its document may carry another identity and be
 * scripted by its opener; only reopening counts toward the rate limit, and what the limit holds back is swept right after the
 * window). Tabs SplitSession creates itself (a domain rule, the choose page, a drag move) are known as its
 * own (`ownTab`), and land in a group only because Chrome puts a tab created inside a group into it: they keep their
 * container and the group is fixed instead (`placeOwn`; refused while the user holds a dragged tab, it is retried after the
 * drop, and the tab stays "own" until fixed even when `ownTab` has forgotten it). Tabs SplitSession is assigning are waited for. A group without
 * the marker (the user's own, a retyped title, a deleted container) never decides anything; leaving a group keeps the
 * container. Every action is logged with the tab, the containers from and to, and the reason.
 */
export class GroupGuard {
  /** Per tab: the check running, and whether another was asked for meanwhile (it runs once more afterwards). */
  private readonly running = new Map<
    number,
    { next: { reason: string; settle: number } | null; done: Promise<void> }
  >();

  private readonly recent: number[] = [];
  private limitedAt = 0;
  private sweepTimer: ReturnType<typeof setTimeout> | null = null;
  private limitTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Tabs SplitSession created that Chrome put into another container's group and that are not yet back where they belong
   * (the group call kept being refused during a long drag). `ownTab` forgets a tab a few seconds after its creation; this
   * does not, until the tab is fixed, closed, or out of the container groups, so the sweep never mistakes it for a foreign tab.
   */
  private readonly pendingOwn = new Set<number>();
  private readonly delay: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly deps: GroupGuardDeps) {
    this.delay = deps.delay ?? sleep;
    this.now = deps.now ?? Date.now;
  }

  /** `tabs.onCreated`: a tab Chrome put into a group as it created it. */
  tabCreated(tab: GuardTab): Promise<void> {
    if (tab.id === undefined || !(tab.groupId >= 0)) return Promise.resolve();
    return this.check(
      tab.id,
      "created in the group",
      isHttpUrl(tab.pendingUrl || tab.url) ? CREATED_SETTLE_MS : 0,
    );
  }

  /** `tabs.onUpdated` reported a new `groupId` for the tab. Resolves when this change has been dealt with. */
  groupChanged(tabId: number, groupId: number): Promise<void> {
    if (groupId < 0) return Promise.resolve(); // out of a group: the tab keeps its container
    return this.check(tabId, "moved into the group", SETTLE_MS);
  }

  /** Tabs or groups changed somehow (attached from another window, a group retitled or created): one sweep soon. */
  scheduleSweep(reason = "tabs or groups changed"): void {
    if (this.sweepTimer) clearTimeout(this.sweepTimer);
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = null;
      void this.sweep(reason);
    }, SWEEP_DEBOUNCE_MS);
  }

  /**
   * Every tab in a group that stands for a container, and not in that container, is dealt with. Resolves when they all
   * have been; returns how many there were.
   */
  async sweep(reason = "periodic check"): Promise<number> {
    let tabs: GuardTab[];
    try {
      tabs = await this.deps.groupedTabs();
    } catch (error) {
      this.deps.log(
        "warn",
        "group guard: could not list the tabs",
        String(error),
      );
      return 0;
    }
    const groups = new Map<number, ContainerId | null>();
    for (const t of tabs)
      if (!groups.has(t.groupId))
        groups.set(t.groupId, await this.deps.groupContainer(t.groupId));
    this.deps.periodic([...groups.values()].some((c) => c !== null));
    const work: Array<Promise<void>> = [];
    for (const t of tabs) {
      const target = groups.get(t.groupId);
      if (
        t.id === undefined ||
        target === null ||
        target === undefined ||
        this.deps.containerOf(t.id) === target
      )
        continue;
      work.push(this.check(t.id, `sweep: ${reason}`, 0));
    }
    await Promise.all(work);
    return work.length;
  }

  /** Resolves when no check is running (tests). */
  async idle(): Promise<void> {
    while (this.running.size > 0)
      await Promise.all([...this.running.values()].map((r) => r.done));
  }

  // ---- internals ----

  /** One check per tab at a time; a request arriving meanwhile runs once more afterwards (the state may have changed). */
  private check(tabId: number, reason: string, settle: number): Promise<void> {
    const current = this.running.get(tabId);
    if (current) {
      current.next = { reason, settle };
      return current.done;
    }
    const entry: {
      next: { reason: string; settle: number } | null;
      done: Promise<void>;
    } = { next: null, done: Promise.resolve() };
    this.running.set(tabId, entry);
    entry.done = (async () => {
      let job: { reason: string; settle: number } = { reason, settle };
      for (;;) {
        try {
          await this.enforce(tabId, job.reason, job.settle);
        } catch (error) {
          this.deps.log(
            "warn",
            `group guard: tab ${tabId} (${job.reason}) failed`,
            String(error),
          );
        }
        if (!entry.next) {
          this.running.delete(tabId); // synchronously with the check above: no request falls between them
          return;
        }
        job = entry.next;
        entry.next = null;
      }
    })();
    return entry.done;
  }

  private async enforce(
    tabId: number,
    reason: string,
    settle: number,
  ): Promise<void> {
    if (settle > 0) await this.delay(settle);
    const state = { counted: false };
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if ((await this.step(tabId, reason, state)) === "done") return;
      await this.delay(RETRY_MS);
    }
    this.deps.log(
      "warn",
      `group guard: tab ${tabId} (${reason}) still could not be put in its group's container; the next sweep tries again`,
    );
  }

  /** One look at the live state, and the action it calls for. 'wait': look again in a moment. */
  private async step(
    tabId: number,
    reason: string,
    state: { counted: boolean },
  ): Promise<"done" | "wait"> {
    await this.deps.groupsIdle(); // a tab SplitSession has just assigned is regrouped first
    const tab = await this.deps.getTab(tabId);
    if (!tab || tab.groupId < 0) {
      this.pendingOwn.delete(tabId);
      return "done"; // closed, or out of any group (that keeps its container)
    }
    const target = await this.deps.groupContainer(tab.groupId);
    if (target === null) {
      this.pendingOwn.delete(tabId);
      return "done";
    }
    const asked = await this.deps.ownTab(tabId);
    if (asked !== null) this.pendingOwn.add(tabId);
    const own = asked ?? (this.pendingOwn.has(tabId) ? "own" : null);
    if (own === "busy" || this.deps.isAssigning(tabId)) return "wait";
    const from = this.deps.containerOf(tabId);
    if (from === target) {
      this.pendingOwn.delete(tabId);
      return "done";
    }
    if (own === "own") {
      try {
        await this.deps.placeOwn(tabId, from);
      } catch (error) {
        if (dragRefusal(error)) return "wait"; // the user still holds a dragged tab: SplitSession's own tab is fixed after the drop
        throw error; // stays pending: the next sweep fixes the group, it does not reopen the tab
      }
      this.pendingOwn.delete(tabId);
      this.record(
        tabId,
        from,
        target,
        reason,
        from === null ? "ungrouped" : "regrouped",
      );
      return "done";
    }
    const address = isHttpUrl(tab.pendingUrl)
      ? tab.pendingUrl
      : isHttpUrl(tab.url)
        ? tab.url
        : null;
    if (
      this.deps.isWaiting(tabId) ||
      tab.status === "unloaded" ||
      tab.discarded ||
      address === null
    ) {
      // Nothing is loaded in it: assigning it where it stands is free and not counted toward the limit.
      await this.deps.assignInPlace(tabId, target);
      this.record(tabId, from, target, reason, "assigned in place");
      return "done";
    }
    if (!state.counted) {
      if (!this.allow()) {
        if (this.now() - this.limitedAt > RATE_WINDOW_MS) {
          this.limitedAt = this.now();
          this.deps.log(
            "warn",
            `group guard: more than ${RATE_LIMIT} tabs reopened in ${RATE_WINDOW_MS / 1000} s; the rest wait for a sweep just after the window`,
          );
        }
        this.sweepAfterWindow();
        return "done";
      }
      state.counted = true;
    }
    try {
      const fresh = await this.deps.move(tabId, target, address);
      this.record(tabId, from, target, reason, "reopened", fresh);
      this.deps.moved(fresh, target, this.deps.containerName(target) ?? "");
      return "done";
    } catch (error) {
      if (dragRefusal(error)) return "wait"; // still being dragged: look again, the drop may put it somewhere else
      this.deps.log(
        "error",
        `group guard: tab ${tabId} could not be reopened in ${target} (${reason}); the next sweep tries again`,
        String(error),
      );
      return "done";
    }
  }

  /** The reopen limit was hit: one sweep right after the window has passed picks the rest up (not the 30 s alarm). */
  private sweepAfterWindow(): void {
    if (this.limitTimer) return;
    this.limitTimer = setTimeout(
      () => {
        this.limitTimer = null;
        void this.sweep("reopen limit lifted");
      },
      RATE_WINDOW_MS + SWEEP_DEBOUNCE_MS / 10,
    );
  }

  private record(
    tabId: number,
    from: ContainerId | null,
    to: ContainerId,
    reason: string,
    action: Action,
    fresh?: number,
  ): void {
    const what =
      action === "reopened"
        ? `reopened in it as tab ${fresh}`
        : action === "assigned in place"
          ? "assigned to it in place"
          : action === "regrouped"
            ? `SplitSession's own tab, moved to the group of ${from}`
            : "SplitSession's own plain tab, taken out of the group";
    this.deps.log(
      "info",
      `group guard: tab ${tabId} ${from ?? "no container"} -> ${to} (${reason}): ${what}`,
      {
        tabId,
        from,
        to,
        reason,
        action,
        ...(fresh !== undefined ? { newTabId: fresh } : {}),
      },
    );
  }

  private allow(): boolean {
    const now = this.now();
    while (this.recent.length > 0 && now - this.recent[0]! > RATE_WINDOW_MS)
      this.recent.shift();
    if (this.recent.length >= RATE_LIMIT) return false;
    this.recent.push(now);
    return true;
  }
}
