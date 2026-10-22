import type { browser } from "wxt/browser";

import { AGENT_GLYPHS } from "../../ui/agent-glyphs";
import type { GroupActivityMark } from "./group-activity";
import {
  type ActivityCommand,
  type ActivityInspection,
  type ActivityRect,
  pageActivity,
} from "./overlay";

type Browser = typeof browser;

/**
 * How long the bright action layer (pill, brighter glow) stays after the last action on a tab. Longer than a typical
 * polling cadence (a screenshot every 3 s): the layer then stays on between the actions instead of fading out and in again.
 */
export const ACTIVITY_TTL_MS = 3_500;
/** A tab the agent touched is in an agent session for this long after the touch, even without a debugger session. */
export const SESSION_MS = 8_000;
/** How often the background looks at its sessions and renews the page side's lease. */
export const SESSION_TICK_MS = 2_000;
/** The page lets go by itself when no command renews the lease within this time (a worker that died). */
export const LEASE_MS = 3 * SESSION_TICK_MS;
/**
 * A session tab that is not the active tab of its window is in the background: Chrome runs its page timers a few times a
 * second, so the favicon would crawl. The worker's timers are not throttled (measured: 30 of 30 a second), so it nudges such
 * tabs with a message at this interval and the page draws the frame the clock says (overlay.ts).
 */
export const ICON_TICK_MS = 33;
/** The blinking dot is put back to idle a little after the page side has faded, so the two never flicker against each other. */
const BADGE_HOLD_MS = ACTIVITY_TTL_MS + 150;

export type MarkKind = "read" | "act";

interface ToolLook {
  label: string;
  /** `read`: the eye glyph; `act`: the pointer glyph. The tab title is never touched. */
  kind: MarkKind;
}

const read = (label: string): ToolLook => ({ label, kind: "read" });
const act = (label: string): ToolLook => ({ label, kind: "act" });

/** Tools that touch one specific tab, and how they show. `list_tabs` / `list_containers` / `bridge_info` are absent on purpose. */
export const TOOL_LOOK: Readonly<Record<string, ToolLook>> = {
  get_tab_text: read("reading"),
  get_tab_html: read("reading"),
  snapshot: read("reading"),
  screenshot_tab: read("screenshot"),
  wait_for: read("waiting"),
  console_messages: read("reading logs"),
  network_requests: read("reading logs"),
  watch: read("watching"),
  click: act("clicking"),
  hover: act("hovering"),
  drag: act("dragging"),
  type: act("typing"),
  press_key: act("pressing keys"),
  select_option: act("choosing"),
  upload_file: act("uploading"),
  scroll: act("scrolling"),
  run_js: act("running script"),
  handle_dialog: act("answering a dialog"),
  resize_viewport: act("resizing"),
  navigate: act("navigating"),
  navigate_back: act("navigating"),
  navigate_forward: act("navigating"),
  reload: act("reloading"),
  open_in_container: act("opening"),
  open_tab: act("opening"),
  assign_tab: act("moving to a container"),
  close_tab: act("closing"),
  activate_tab: act("switching to this tab"),
};

/** Longest wait for the page side: a page that is stuck (a JavaScript dialog is open) must not hold the tool up. */
const INJECT_MS = 1_200;

export interface ActivityDeps {
  b: Browser;
  /** The "Show agent activity" setting, read at every action. */
  enabled: () => boolean;
  /** The tab's toolbar dot starts to blink (a no-op while it already blinks, or while the bridge is off). */
  startBlink: (tabId: number) => void;
  /** The blink ends and the tab's own badge (idle dot, container dot, or none) comes back. */
  stopBlink: (tabId: number) => Promise<void>;
  /**
   * Whether the agent bridge's debugger session is held on the tab by more than its idle window (a viewport override, a
   * watch, an open dialog): that keeps the agent session alive. The idle minute after a burst of actions does not.
   */
  held?: (tabId: number) => boolean;
  /**
   * The activity mark of tab groups: starts with the tab's first action and ends together with the toolbar dot (below), so
   * it has no clock of its own.
   */
  groupMark?: Pick<GroupActivityMark, "start" | "stop" | "stopAll">;
  now?: () => number;
}

interface Session {
  /** The latest agent tool that touched the tab. */
  last: number;
  /** The page side answered a command: it has our script in it (an unscriptable page never does) and can take ticks. */
  scripted: boolean;
  timer: ReturnType<typeof setInterval>;
}

/**
 * Shows the user which tab the agent is working with, without taking focus or switching tabs. An "agent session" on a
 * tab lasts while the bridge's debugger session is attached to it, or the agent touched it within `SESSION_MS`. During
 * it the page shows a steady, slowly breathing neon glow along its edges and a breathing favicon; each action adds a
 * brighter layer, a pill with the glyph (eye for reads, pointer for actions) and a pulse at the target (overlay.ts); the
 * toolbar button's dot of that tab blinks (badges.ts) until `BADGE_HOLD_MS` after the last action. The session is kept alive by `session` commands that renew a lease on the page
 * side; a new document (navigation) gets it again at commit. Every step is best effort: a page that cannot be scripted
 * (chrome://, the Web Store, an error page) gets the blinking dot only, and nothing here can make a tool fail. The tab title is
 * never touched.
 */
export class AgentActivity {
  private readonly badgeTimers = new Map<
    number,
    ReturnType<typeof setTimeout>
  >();

  private readonly sessions = new Map<number, Session>();
  private readonly now: () => number;
  /** Session tabs that are in the background (not the active tab of their window), and the worker-driven favicon tick. */
  private readonly background = new Set<number>();
  private ticker: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly d: ActivityDeps) {
    this.now = d.now ?? Date.now;
    // A new document in a session tab (full page load) gets the glow again at once; the periodic renewal is the fallback.
    const nav = d.b.webNavigation as unknown as
      | {
          onCommitted?: {
            addListener(
              cb: (details: { tabId: number; frameId: number }) => void,
            ): void;
          };
        }
      | undefined;
    nav?.onCommitted?.addListener((details) => {
      if (details.frameId === 0 && this.sessions.has(details.tabId))
        void this.renew(details.tabId, true);
    });
    d.b.tabs?.onRemoved?.addListener((tabId) => this.forget(tabId));
    d.b.tabs?.onActivated?.addListener(() => void this.refreshBackground());
  }

  /** `tool` is working on `tabId` now (re-arms the bright layer and the session). `rect`: a pulse at that spot of the page. */
  async touch(
    tabId: number,
    tool: string,
    rect: ActivityRect | null = null,
  ): Promise<void> {
    const look = TOOL_LOOK[tool];
    if (!look || !this.d.enabled() || tabId < 0) return;
    this.hold(tabId);
    this.blink(tabId);
    const done = await this.inject(
      tabId,
      this.command("show", { label: look.label, kind: look.kind, rect }),
    );
    this.markScripted(tabId, done);
  }

  /** Takes the overlay out of the picture (a screenshot is about to be taken). */
  async hide(tabId: number): Promise<void> {
    await this.inject(tabId, this.command("hide"));
  }

  async unhide(tabId: number): Promise<void> {
    await this.inject(tabId, this.command("unhide"));
  }

  /**
   * The setting or the bridge was switched off: everything shown in the tabs goes at once (the page's own icon values
   * are put back, glow and pill removed) and the tabs' own badges return.
   */
  async stopAll(): Promise<void> {
    const tabs = [...this.sessions.keys()];
    for (const tabId of tabs) this.drop(tabId);
    const marks = this.d.groupMark?.stopAll().catch(() => {});
    await Promise.all([
      marks,
      ...tabs.map(async (tabId) => {
        const timer = this.badgeTimers.get(tabId);
        if (timer) clearTimeout(timer);
        this.badgeTimers.delete(tabId);
        await this.inject(tabId, this.command("stop"));
        await this.d.stopBlink(tabId).catch(() => {});
      }),
    ]);
  }

  /** Tabs that are in an agent session right now (tests). */
  sessionTabs(): number[] {
    return [...this.sessions.keys()];
  }

  private command(
    op: ActivityCommand["op"],
    o: {
      label?: string;
      kind?: ActivityCommand["kind"];
      rect?: ActivityRect | null;
    } = {},
  ): ActivityCommand {
    return {
      op,
      label: o.label ?? "",
      kind: o.kind ?? "",
      ttl: ACTIVITY_TTL_MS,
      lease: LEASE_MS,
      rect: o.rect ?? null,
      glyphs: AGENT_GLYPHS as unknown as ActivityCommand["glyphs"],
    };
  }

  /** Starts the tab's session or extends it. */
  private hold(tabId: number): void {
    const existing = this.sessions.get(tabId);
    if (existing) {
      existing.last = this.now();
      return;
    }
    const timer = setInterval(() => void this.tick(tabId), SESSION_TICK_MS);
    this.sessions.set(tabId, { last: this.now(), scripted: false, timer });
    void this.refreshBackground();
  }

  private markScripted(tabId: number, result: unknown): void {
    const session = this.sessions.get(tabId);
    if (!session) return;
    session.scripted = result === true;
    this.syncTicker();
  }

  /** Looks at which session tabs are not the active tab of their window (the ones whose page timers Chrome throttles). */
  private async refreshBackground(): Promise<void> {
    const tabs = this.d.b.tabs as unknown as
      { get?(id: number): Promise<{ active?: boolean }> } | undefined;
    if (!tabs?.get) return;
    await Promise.all(
      [...this.sessions.keys()].map(async (tabId) => {
        const tab = await tabs.get!(tabId).catch(() => null);
        if (!tab || !this.sessions.has(tabId)) return;
        if (tab.active === false) this.background.add(tabId);
        else this.background.delete(tabId);
      }),
    );
    this.syncTicker();
  }

  /** Runs the favicon tick while at least one scripted session tab is in the background. */
  private syncTicker(): void {
    const need = [...this.background].some(
      (id) => this.sessions.get(id)?.scripted,
    );
    if (need && !this.ticker) {
      this.ticker = setInterval(() => this.sendTicks(), ICON_TICK_MS);
    } else if (!need && this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  private sendTicks(): void {
    const tabs = this.d.b.tabs as unknown as
      | {
          sendMessage?(
            id: number,
            message: unknown,
            options?: unknown,
          ): Promise<unknown>;
        }
      | undefined;
    if (!tabs?.sendMessage) return;
    for (const tabId of this.background) {
      if (!this.sessions.get(tabId)?.scripted) continue;
      try {
        tabs
          .sendMessage(tabId, { facetAgentTick: 1 }, { frameId: 0 })
          .catch(() => {}); // no receiver (page gone, overlay down): nothing to do
      } catch {
        // the tab is gone
      }
    }
  }

  private drop(tabId: number): void {
    const session = this.sessions.get(tabId);
    if (!session) return;
    clearInterval(session.timer);
    this.sessions.delete(tabId);
    this.background.delete(tabId);
    this.syncTicker();
  }

  /** The tab was closed. */
  forget(tabId: number): void {
    this.drop(tabId);
    const timer = this.badgeTimers.get(tabId);
    if (timer) clearTimeout(timer);
    this.badgeTimers.delete(tabId);
    this.d.groupMark?.stop(tabId);
    void this.d.stopBlink(tabId).catch(() => {}); // ends the interval
  }

  /** Renews the page side's lease (or starts it in a new document). */
  private async renew(tabId: number, immediate = false): Promise<void> {
    this.markScripted(
      tabId,
      await this.inject(tabId, this.command("session"), immediate),
    );
  }

  private async tick(tabId: number): Promise<void> {
    const session = this.sessions.get(tabId);
    if (!session) return;
    if (!this.d.enabled()) {
      this.drop(tabId);
      await this.inject(tabId, this.command("stop"));
      return;
    }
    const active =
      (this.d.held?.(tabId) ?? false) || this.now() - session.last < SESSION_MS;
    if (active) {
      void this.refreshBackground();
      await this.renew(tabId);
      return;
    }
    this.drop(tabId);
    await this.inject(tabId, this.command("end"));
  }

  private async inject(
    tabId: number,
    cmd: ActivityCommand,
    immediate = false,
  ): Promise<ActivityInspection | boolean | undefined> {
    try {
      const run = this.d.b.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        world: "ISOLATED",
        func: pageActivity as never,
        args: [cmd] as never,
        ...(immediate ? { injectImmediately: true } : {}),
      });
      run.catch(() => {});
      const results = await Promise.race([
        run,
        new Promise<undefined>((r) =>
          setTimeout(() => r(undefined), INJECT_MS),
        ),
      ]);
      return results?.[0]?.result as ActivityInspection | boolean | undefined;
    } catch {
      return undefined; // cannot be scripted, or the tab is gone: no overlay, which is fine
    }
  }

  /** The dot of the tab blinks (and its group, if it is a container's, shows the activity glyph); the end is re-armed by every touch. */
  private blink(tabId: number): void {
    this.d.startBlink(tabId);
    this.d.groupMark?.start(tabId);
    const previous = this.badgeTimers.get(tabId);
    if (previous) clearTimeout(previous);
    this.badgeTimers.set(
      tabId,
      setTimeout(() => {
        this.badgeTimers.delete(tabId);
        this.d.groupMark?.stop(tabId);
        void this.d.stopBlink(tabId).catch(() => {});
      }, BADGE_HOLD_MS),
    );
  }
}
