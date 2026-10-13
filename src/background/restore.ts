import {
  associateSessions,
  type CompiledRules,
  type ContainerId,
  Debounced,
  flattenRecentlyClosed,
  gateKey,
  heldPageTarget,
  heldPageUrl,
  isClosed,
  layoutWindows,
  matchRestoredTab,
  type MatchResult,
  oneClickPlan,
  parseRestoreState,
  RESTORE_STATE_KEY,
  type RestoreState,
  type RuleIdAllocator,
  sleep,
  STARTUP_GRACE_MS,
} from "../core";
import { RestoreGate } from "./restore/gate";
import { heldKeys, heldStatus } from "./restore/held";
import {
  parseSession,
  RESTORE_SESSION_KEY,
  SessionWriter,
} from "./restore/session";
import { buildSnapshot } from "./restore/snapshot";
import { waitForStableTabs } from "./restore/stable-tabs";
import {
  type HeldEntry,
  type RestoreDeps,
  type RestoreStatus,
  type TabLike,
  toLive,
  urlOf,
} from "./restore/types";

export { RESTORE_SESSION_KEY } from "./restore/session";
export type {
  RestoreBrowser,
  RestoreDeps,
  RestoreStatus,
} from "./restore/types";

/** Session-rule key of the gate's openers (container IDs are [a-z0-9], so no clash). */
export const RESTORE_KEY = "@restore";

/** A tab that appeared is matched this long after it appeared (its group and recently-closed change arrive meanwhile). */
const SETTLE_MS = 400;
/**
 * A change is written this long after the last one (and at the latest SNAPSHOT_MAX_WAIT_MS after the first of a burst):
 * the browser may be quit a moment after a tab closed, and a stale window signature locks tabs out at the next start.
 */
const SNAPSHOT_DELAY_MS = 100;
const SNAPSHOT_MAX_WAIT_MS = 500;
/** A restored entry counts as "just restored" for tabs that appeared up to this long before the change was seen. */
const CONSUMED_WINDOW_MS = 10_000;
const RELOAD_GUARD_MS = 10_000;

interface Pending {
  since: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Brings container tabs back into their containers when Chrome brings the tabs back (docs/decisions.md, "Container
 * tabs that come back").
 *
 * The gate: a dynamic declarativeNetRequest `block` rule (priority 1, main frames) for every address SplitSession may have to
 * restore: those of open container tabs (for the next browser start, when no session rule exists yet and the service
 * worker may not run) and of closed ones that Chrome can reopen. Dynamic rules survive the browser restart and apply
 * before any extension code runs. Session `allow` rules at the same priority open it for every tab SplitSession already
 * knows ("cleared" tabs: all tabs that existed when the worker started, every new tab once seen, every container tab),
 * and for everyone on the addresses that only matter at the next start. A tab that appears with a gated address
 * (restored, reopened) thus sends nothing until it is matched: into its container (and reloaded there), plain (and
 * reloaded as such), or held for the user when the evidence is not conclusive.
 *
 * Parts: the gate's rules (`restore/gate.ts`), the records and window signatures rebuilt from the live tabs
 * (`restore/snapshot.ts`), what survives a stop of the worker (`restore/session.ts`); matching itself is pure
 * (`core/restore.ts`).
 */
export class TabRestore {
  private enabled = false;
  private state: RestoreState = { records: [], windows: [] };
  private readonly cleared = new Set<number>();
  private readonly pending = new Map<number, Pending>();
  private readonly held = new Map<number, HeldEntry>();
  /** Main-frame requests our gate blocked, per tab (the tab is reloaded once it is decided). */
  private readonly blocked = new Map<number, { url: string; at: number }>();
  private readonly reloadedAt = new Map<number, number>();
  /** Session IDs in Chrome's recently-closed list at the last look, and those that left it (restored), with when. */
  private present = new Set<string>();
  private readonly consumed = new Map<string, number>();
  private startupUntil = 0;
  private readonly gate: RestoreGate;
  private readonly sessionWriter: SessionWriter;
  /** Snapshots of a burst of changes are written once (`scheduleSnapshot`). */
  private readonly snapshotLater = new Debounced(
    () => void this.snapshot(),
    SNAPSHOT_DELAY_MS,
    SNAPSHOT_MAX_WAIT_MS,
  );

  private snapshotWork: Promise<void> = Promise.resolve();
  /** Browser start in progress: snapshots wait (the previous session's records are being matched). */
  private starting = false;
  /** Tabs that appeared while the worker was stopped: checked for a blocked request once the rules are back. */
  private readonly recheck = new Set<number>();
  /** Groups Chrome removed in the last seconds (their tabs' removals may be reported after the group's). */
  private readonly removedGroups = new Map<number, number>();

  constructor(private readonly deps: RestoreDeps) {
    this.gate = new RestoreGate({
      dnr: deps.b.declarativeNetRequest,
      invalidate: () => deps.invalidate(),
      log: deps.log,
      enabled: () => this.enabled,
    });
    this.sessionWriter = new SessionWriter(deps.session, () => ({
      cleared: [...this.cleared],
      held: [...this.held.values()],
      present: [...this.present],
      startupUntil: this.startupUntil,
    }));
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Tabs the restore is deciding about (a tab on a gated address is matched) or holds for the user: they may become
   * container tabs, so their first request must not precede the content scripts. Records of CLOSED tabs and groups
   * (saved groups, recently closed; up to 30 days) are not tabs and never count: nothing is open to protect.
   */
  waitingCount(): number {
    return this.pending.size + this.held.size;
  }

  /** The start pass (matching the previous session's tabs) is still running. */
  isStarting(): boolean {
    return this.starting;
  }

  private notifyWaiting(): void {
    this.deps.waitingChanged?.();
  }

  // ---------------------------------------------------------------- start

  /**
   * Called during rehydration, before the session rules are reinstalled. Returns true when `storage.session` was empty
   * (browser start, extension update, reload or re-enable): every session rule is gone and the gate holds every tab, so
   * `startupPass` must run. Otherwise (the worker was only stopped) the known tabs are known again.
   */
  async load(liveTabs: readonly TabLike[], enabled: boolean): Promise<boolean> {
    this.enabled = enabled;
    const [loc, ses] = await Promise.all([
      this.deps.local.get(RESTORE_STATE_KEY),
      this.deps.session.get(RESTORE_SESSION_KEY),
    ]);
    this.state = parseRestoreState(loc[RESTORE_STATE_KEY]);
    const saved = parseSession(ses[RESTORE_SESSION_KEY]);
    const live = liveTabs.filter((t) => t.id !== undefined);
    if (!enabled) {
      for (const t of live) this.cleared.add(t.id!);
      this.recomputeKeys();
      return false;
    }
    if (saved) {
      this.startupUntil = saved.startupUntil;
      this.present = new Set(saved.present);
      const liveIds = new Set(live.map((t) => t.id!));
      for (const h of saved.held)
        if (liveIds.has(h.tabId)) this.held.set(h.tabId, h);
      const known = new Set(saved.cleared);
      this.recomputeKeys();
      for (const t of live) {
        if (known.has(t.id!)) this.cleared.add(t.id!);
        else if (!this.held.has(t.id!)) this.considerNew(t, false); // appeared while the worker was stopped
      }
      return false;
    }
    // Every session rule is gone. Records open at the end of that session (and those closed with its windows during
    // shutdown) belong to the previous session; recently-closed IDs of then mean nothing now.
    const now = Date.now();
    const lastActivity = Math.max(
      0,
      ...this.state.records.map((r) => Math.max(r.at, r.closedAt ?? 0)),
    );
    for (const r of this.state.records) {
      if (!isClosed(r) || (r.viaWindow && r.closedAt! >= lastActivity - 30_000))
        r.prev = true;
      delete r.sessionId;
    }
    this.startupUntil = now + STARTUP_GRACE_MS;
    this.starting = true;
    this.recomputeKeys();
    const candidates = new Set(
      this.state.records
        .map((r) => gateKey(r.url))
        .filter((k): k is string => k !== null),
    );
    for (const t of live) {
      const key = gateKey(urlOf(t));
      if (key && candidates.has(key))
        this.pending.set(t.id!, { since: now, timer: null });
      else this.cleared.add(t.id!);
    }
    this.persistSession();
    return true;
  }

  /** After a worker restart: the gate and the snapshot follow the current state. */
  afterLoad(): void {
    for (const id of this.recheck) void this.reloadIfBlocked(id);
    this.recheck.clear();
    if (!this.enabled) {
      void this.gate.sync();
      return;
    }
    for (const id of this.pending.keys()) this.schedule(id);
    this.scheduleSnapshot();
  }

  /**
   * Browser start (or extension update): match every held-back tab against the previous session, once Chrome has
   * finished restoring windows. Runs before the engine reports ready.
   */
  async startupPass(): Promise<void> {
    try {
      if (this.enabled) await this.matchPreviousSession();
    } finally {
      this.starting = false;
      this.notifyWaiting();
    }
    for (const id of this.recheck) void this.reloadIfBlocked(id);
    this.recheck.clear();
    await this.snapshot();
  }

  private async matchPreviousSession(): Promise<void> {
    if (this.pending.size > 0)
      await waitForStableTabs(() => this.deps.b.tabs.query({}).catch(() => []));
    await this.refreshSessions();
    const [tabs, groups] = await Promise.all([
      this.deps.b.tabs.query({}),
      this.deps.b.tabGroups.query({}).catch(() => []),
    ]);
    const live = tabs.filter((t) => t.id !== undefined);
    // Tabs that appeared while we waited: the same treatment.
    const candidates = new Set(this.state.records.map((r) => gateKey(r.url)));
    for (const t of live) {
      if (this.cleared.has(t.id!) || this.pending.has(t.id!)) continue;
      if (candidates.has(gateKey(urlOf(t))))
        this.pending.set(t.id!, { since: Date.now(), timer: null });
      else this.clearSync(t.id!);
    }
    const ctx = { ...this.context(live, groups, true, 0), history: true };
    const claimed = new Set<string>();
    const order = live
      .filter((t) => this.pending.has(t.id!))
      .sort((a, b) => a.windowId - b.windowId || a.index - b.index);
    let restored = 0;
    for (const tab of order) {
      const result = matchRestoredTab(toLive(tab), {
        ...ctx,
        records: ctx.records.filter((r) => !claimed.has(r.key)),
      });
      if (result.kind === "container") claimed.add(result.record);
      this.pending.delete(tab.id!);
      if (await this.apply(tab, result)) restored++;
    }
    // What the previous session had open and nothing claimed: closed with that session (History can reopen it).
    this.state.records = this.state.records.filter((r) => !claimed.has(r.key));
    for (const r of this.state.records) {
      if (!r.prev || isClosed(r)) continue;
      r.closedAt = r.at;
      r.viaWindow = true;
      delete r.tabId;
      delete r.windowId;
    }
    await this.refreshSessions();
    await this.deps.invalidate();
    this.persistSession();
    this.deps.log(
      "info",
      `restore after start: ${restored} container tabs back, ${this.held.size} waiting for the user`,
    );
  }

  // ---------------------------------------------------------------- session rules

  /** Session rules of `RESTORE_KEY`: the openers of the gate. */
  compile(allocator: RuleIdAllocator): CompiledRules | null {
    if (!this.enabled) return null;
    return this.gate.openers(this.cleared, allocator);
  }

  /** The tab is known from now on (its requests pass the gate). True when that changed the rules (invalidate). */
  clearSync(tabId: number): boolean {
    if (tabId < 0) return false;
    const p = this.pending.get(tabId);
    if (p?.timer) clearTimeout(p.timer);
    const wasPending = this.pending.delete(tabId);
    const wasHeld = this.held.delete(tabId);
    if (wasHeld) this.deps.heldChanged([tabId]);
    if (wasPending || wasHeld) this.notifyWaiting();
    if (this.cleared.has(tabId)) return false;
    this.cleared.add(tabId);
    if (wasPending || wasHeld || this.enabled) this.persistSession();
    return this.enabled;
  }

  async clear(tabId: number): Promise<void> {
    if (this.clearSync(tabId)) await this.deps.invalidate();
  }

  /** The user chose for this tab (popup "Reopen in", the API): it is no longer waiting. */
  async release(tabId: number): Promise<string | undefined> {
    const address = this.held.get(tabId)?.url;
    if (this.pending.has(tabId) || this.held.has(tabId))
      await this.clear(tabId);
    return address;
  }

  /** The address a waiting tab stands for (it shows SplitSession's page), or undefined. */
  heldAddress(tabId: number): string | undefined {
    return this.held.get(tabId)?.url;
  }

  isHeld(tabId: number): boolean {
    return this.held.has(tabId);
  }

  /** The tab is still being decided (matched against what Chrome brought back) or waits for the user. */
  isWaiting(tabId: number): boolean {
    return this.pending.has(tabId) || this.held.has(tabId);
  }

  heldCount(): number {
    return this.held.size;
  }

  heldIds(): number[] {
    return [...this.held.keys()];
  }

  /** The address a tab shows or stands for: a waiting tab sits on SplitSession's own page, which carries the address. */
  private addressOf(tab: TabLike): string {
    const url = urlOf(tab);
    return heldPageTarget(url, this.deps.heldPage) ?? url;
  }

  /** `Facet.assign` succeeded: a request the gate blocked before is repeated (in the container). */
  afterAssign(tabId: number): void {
    if (this.blocked.has(tabId)) void this.reloadIfBlocked(tabId);
  }

  // ---------------------------------------------------------------- tab events

  tabCreated(tab: TabLike): void {
    if (tab.id === undefined || tab.id < 0) return;
    this.considerNew(tab, true);
  }

  /** A tab SplitSession has not seen: held for matching when its address is gated now, known otherwise. */
  private considerNew(tab: TabLike, live: boolean): void {
    const id = tab.id!;
    if (this.cleared.has(id) || this.pending.has(id) || this.held.has(id))
      return;
    const key = gateKey(urlOf(tab));
    if (this.enabled && key && this.gate.holdsNew(key)) {
      this.pending.set(id, { since: Date.now(), timer: null });
      if (live) this.schedule(id);
      return;
    }
    const changed = this.clearSync(id);
    if (!live) this.recheck.add(id);
    else if (changed) void this.deps.invalidate();
  }

  /**
   * A page opened this tab (link, `window.open`) and the page is not in a container: never a restore. (A container
   * page's child inherits its container instead, which clears it.)
   */
  pageOpened(tabId: number): void {
    if (!this.pending.has(tabId)) return;
    void this.clear(tabId).then(() => this.reloadIfBlocked(tabId));
  }

  /** `webRequest.onBeforeRequest` for a main frame: an unknown tab requesting a gated address is matched first. */
  mainFrameRequest(tabId: number, url: string): void {
    if (
      !this.enabled ||
      tabId < 0 ||
      this.cleared.has(tabId) ||
      this.pending.has(tabId) ||
      this.held.has(tabId)
    )
      return;
    const key = gateKey(url);
    if (!key || !this.gate.gates(key)) return;
    this.pending.set(tabId, { since: Date.now(), timer: null });
    this.schedule(tabId);
  }

  /** `webRequest.onErrorOccurred` for a main frame. */
  requestFailed(details: {
    tabId: number;
    url: string;
    type?: string;
    error?: string;
  }): void {
    if (
      details.tabId < 0 ||
      details.type !== "main_frame" ||
      details.error !== "net::ERR_BLOCKED_BY_CLIENT"
    )
      return;
    const key = gateKey(details.url);
    if (!key || !this.gate.gates(key)) return;
    this.blocked.set(details.tabId, { url: details.url, at: Date.now() });
    // Known already: its opener landed a moment after the request (a brand-new tab navigating at once).
    if (this.cleared.has(details.tabId))
      void this.reloadIfBlocked(details.tabId);
  }

  /** A container tab's main frame committed: its record follows at once (the snapshot may come too late at a close). */
  tabCommitted(
    tabId: number,
    url: string,
    containerId: ContainerId | undefined,
  ): void {
    if (!this.enabled) return;
    const key = gateKey(url);
    if (containerId !== undefined && key) {
      const rec = this.state.records.find(
        (r) => r.tabId === tabId && !isClosed(r),
      );
      if (rec && rec.url !== url) rec.url = url;
      this.scheduleSnapshot();
    }
    // A waiting tab went somewhere the gate does not hold: the user moved on, it is an ordinary tab.
    if (
      (this.held.has(tabId) || this.pending.has(tabId)) &&
      key &&
      !this.gate.gates(key)
    )
      void this.clear(tabId);
  }

  tabRemoved(tabId: number, isWindowClosing: boolean): void {
    const p = this.pending.get(tabId);
    if (p?.timer) clearTimeout(p.timer);
    this.pending.delete(tabId);
    const wasHeld = this.held.delete(tabId);
    if (wasHeld) this.deps.heldChanged([tabId]);
    if (p || wasHeld) this.notifyWaiting();
    const changed = this.cleared.delete(tabId) || wasHeld;
    this.blocked.delete(tabId);
    this.reloadedAt.delete(tabId);
    if (!this.enabled) return;
    const rec = this.state.records.find(
      (r) => r.tabId === tabId && !isClosed(r),
    );
    if (rec) {
      rec.closedAt = Date.now();
      rec.viaWindow = isWindowClosing;
      const groupGone =
        rec.groupId !== undefined
          ? this.removedGroups.get(rec.groupId)
          : undefined;
      if (
        rec.inGroup &&
        groupGone !== undefined &&
        rec.closedAt - groupGone < 5_000
      )
        rec.savedGroup = true;
      delete rec.tabId;
      delete rec.windowId;
      // Its address is now one Chrome can bring back: closed to unknown tabs from this moment.
      this.recomputeKeys();
      void this.deps.invalidate();
      this.scheduleSnapshot();
    } else {
      if (changed) void this.deps.invalidate();
      // A plain tab closing moves the others' positions (and may change the window's address list): the window
      // signatures must not be stale if the browser quits now. Nothing to write for a window that is closing as a whole.
      if (!isWindowClosing) this.scheduleSnapshot();
    }
    this.persistSession();
  }

  tabReplaced(added: number, removed: number): void {
    if (this.cleared.delete(removed)) this.cleared.add(added);
    const held = this.held.get(removed);
    if (held) {
      this.held.delete(removed);
      this.held.set(added, { ...held, tabId: added });
      this.deps.heldChanged([removed, added]);
    }
    const p = this.pending.get(removed);
    if (p) {
      if (p.timer) clearTimeout(p.timer);
      this.pending.delete(removed);
      this.pending.set(added, { since: p.since, timer: null });
      this.schedule(added);
    }
    for (const r of this.state.records)
      if (r.tabId === removed) r.tabId = added;
    if (this.enabled) void this.deps.invalidate();
    this.persistSession();
    this.scheduleSnapshot();
  }

  /** Chrome removed a group: tabs of it closed just now closed with their whole group (Chrome saves such a group). */
  groupRemoved(groupId: number): void {
    if (!this.enabled) return;
    const now = Date.now();
    for (const [id, at] of this.removedGroups)
      if (now - at > 5_000) this.removedGroups.delete(id);
    this.removedGroups.set(groupId, now);
    let changed = false;
    for (const r of this.state.records) {
      if (
        r.groupId === groupId &&
        r.inGroup &&
        isClosed(r) &&
        now - r.closedAt! < 5_000 &&
        !r.savedGroup
      ) {
        r.savedGroup = true;
        changed = true;
      }
    }
    if (changed) {
      this.recomputeKeys();
      this.scheduleSnapshot();
    }
  }

  /** `chrome.sessions.onChanged`: a tab or window was closed or restored. */
  sessionsChanged(): void {
    if (!this.enabled) return;
    void this.refreshSessions().then(() => {
      if (this.recomputeKeys()) void this.deps.invalidate();
      this.scheduleSnapshot();
    });
  }

  private async refreshSessions(): Promise<void> {
    const list = await this.deps.b.sessions
      .getRecentlyClosed({ maxResults: 25 })
      .catch(() => null);
    if (!list) return;
    const entries = flattenRecentlyClosed(list as never);
    const now = Date.now();
    const ids = new Set(entries.map((e) => e.sessionId));
    for (const id of this.present)
      if (!ids.has(id) && !this.consumed.has(id)) this.consumed.set(id, now);
    for (const [id, at] of this.consumed)
      if (now - at > CONSUMED_WINDOW_MS) this.consumed.delete(id);
    this.present = ids;
    associateSessions(
      this.state.records,
      entries,
      new Set(this.consumed.keys()),
    );
    this.persistSession();
  }

  // ---------------------------------------------------------------- deciding

  private schedule(tabId: number): void {
    const p = this.pending.get(tabId);
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    p.timer = setTimeout(() => void this.decide(tabId), SETTLE_MS);
  }

  private context(
    tabs: readonly TabLike[],
    groups: ReadonlyArray<{ id: number; title?: string }>,
    startup: boolean,
    since: number,
  ) {
    const consumed = new Set(
      [...this.consumed]
        .filter(([, at]) => at >= since - CONSUMED_WINDOW_MS)
        .map(([id]) => id),
    );
    const live = tabs.filter((t) => t.id !== undefined).map(toLive);
    return {
      tabs: live,
      layouts: layoutWindows(live),
      groupTitles: new Map(groups.map((g) => [g.id, g.title ?? ""])),
      records: this.state.records,
      hasContainer: (id: ContainerId) => this.deps.hasContainer(id),
      consumed,
      windows: this.state.windows,
      startup,
    };
  }

  private async decide(tabId: number): Promise<void> {
    const p = this.pending.get(tabId);
    if (!p) return;
    p.timer = null;
    await this.refreshSessions();
    const [tab, tabs, groups] = await Promise.all([
      this.deps.b.tabs.get(tabId).catch(() => null),
      this.deps.b.tabs.query({}),
      this.deps.b.tabGroups.query({}).catch(() => []),
    ]);
    if (!this.pending.has(tabId)) return; // decided meanwhile (inherited a container, closed, chosen by the user)
    this.pending.delete(tabId);
    if (!tab) {
      this.notifyWaiting();
      return;
    }
    const ctx = this.context(
      tabs,
      groups,
      Date.now() < this.startupUntil,
      p.since,
    );
    await this.apply(tab, matchRestoredTab(toLive(tab), ctx));
    this.persistSession();
    this.notifyWaiting();
  }

  /** Puts a decision into effect. True when the tab went into a container. */
  private async apply(tab: TabLike, result: MatchResult): Promise<boolean> {
    const tabId = tab.id!;
    const url = this.addressOf(tab);
    const onHeldPage = heldPageTarget(urlOf(tab), this.deps.heldPage) !== null;
    if (result.kind === "container") {
      this.blocked.delete(tabId);
      try {
        await this.deps.assign(tabId, result.containerId);
      } catch (error) {
        this.deps.log(
          "error",
          `tab ${tabId} could not be restored into ${result.containerId}`,
          String(error),
        );
        await this.clear(tabId);
        return false;
      }
      this.state.records = this.state.records.filter(
        (r) => r.key !== result.record || !(isClosed(r) || r.prev),
      );
      this.deps.log(
        "info",
        `tab ${tabId} restored into ${result.containerId} (${result.evidence})`,
        url,
      );
      // Not loaded yet (restored "unloaded" or discarded): it loads in the container when the user opens it.
      if (tab.status !== "unloaded" && !tab.discarded) {
        this.reloadedAt.set(tabId, Date.now());
        await this.deps.prepareNavigation(url);
        // A waiting tab shows SplitSession's page: it goes to the address it stood for.
        await (
          onHeldPage
            ? this.deps.b.tabs.update(tabId, { url })
            : this.deps.b.tabs.reload(tabId)
        ).catch(() => {});
      }
      this.scheduleSnapshot();
      return true;
    }
    if (result.kind === "ambiguous") {
      this.held.set(tabId, {
        tabId,
        url,
        candidates: result.candidates,
        at: Date.now(),
      });
      this.deps.log(
        "warn",
        `tab ${tabId} may belong to ${result.candidates.join(" or ")}: waiting for the user`,
        url,
      );
      this.persistSession();
      this.deps.heldChanged([tabId]);
      // Chrome's "blocked by an extension" says nothing: the tab shows SplitSession's page with the choices instead (no request).
      if (!onHeldPage)
        await this.deps.b.tabs
          .update(tabId, { url: heldPageUrl(this.deps.heldPage, url) })
          .catch(() => {});
      return false;
    }
    await this.clear(tabId);
    await this.reloadIfBlocked(tabId);
    return false;
  }

  /** Reloads a tab whose request the gate blocked, now that it may pass (once per 10 s). */
  private async reloadIfBlocked(tabId: number): Promise<void> {
    const now = Date.now();
    if (now - (this.reloadedAt.get(tabId) ?? 0) < RELOAD_GUARD_MS) return;
    const frame = await this.deps.b.webNavigation
      .getFrame({ tabId, frameId: 0 })
      .catch(() => null);
    const noted = this.blocked.get(tabId);
    const failed =
      frame?.errorOccurred === true &&
      gateKey(frame.url) !== null &&
      this.gate.gates(gateKey(frame.url)!);
    if (!noted && !failed) return;
    this.blocked.delete(tabId);
    this.reloadedAt.set(tabId, now);
    if (this.deps.isContainerTab(tabId))
      await this.deps.prepareNavigation(frame?.url ?? noted?.url);
    await this.deps.b.tabs.reload(tabId).catch(() => {});
  }

  /** A waiting tab, now an ordinary one: it goes from SplitSession's page to its address (nothing is blocked any more). */
  private async openAsPlain(tabId: number, url: string): Promise<void> {
    this.blocked.delete(tabId);
    this.reloadedAt.set(tabId, Date.now());
    const tab = await this.deps.b.tabs.get(tabId).catch(() => null);
    if (!tab) return;
    if (heldPageTarget(urlOf(tab), this.deps.heldPage) !== null)
      await this.deps.b.tabs.update(tabId, { url }).catch(() => {});
    else await this.reloadIfBlocked(tabId);
  }

  // ---------------------------------------------------------------- the popup's banner

  status(): Promise<RestoreStatus> {
    return heldStatus(
      this.deps.b,
      this.deps.heldPage,
      this.enabled,
      [...this.held.values()],
      this.state.records,
    );
  }

  /** "Restore container tabs" (the one-click plan) or "Open as ordinary tabs" for the held tabs (or some of them). */
  async resolveHeld(
    action: "restore" | "plain",
    tabIds?: number[],
  ): Promise<number> {
    const targets = [...this.held.values()].filter(
      (h) => !tabIds || tabIds.includes(h.tabId),
    );
    let done = 0;
    if (action === "restore") {
      const plan = oneClickPlan(targets, this.state.records);
      for (const [tabId, containerId] of plan) {
        const tab = await this.deps.b.tabs.get(tabId).catch(() => null);
        if (!tab) continue;
        const key = gateKey(this.held.get(tabId)?.url);
        const record = this.state.records.find(
          (r) =>
            r.containerId === containerId &&
            gateKey(r.url) === key &&
            (r.prev || isClosed(r)),
        );
        this.held.delete(tabId);
        this.deps.heldChanged([tabId]);
        if (
          await this.apply(tab, {
            kind: "container",
            containerId,
            evidence: "user",
            record: record?.key ?? "",
          })
        )
          done++;
      }
    } else {
      for (const h of targets) {
        await this.clear(h.tabId);
        await this.openAsPlain(h.tabId, h.url);
        done++;
      }
    }
    this.persistSession();
    this.notifyWaiting();
    return done;
  }

  // ---------------------------------------------------------------- settings, tests

  async setEnabled(on: boolean): Promise<void> {
    if (on === this.enabled) return;
    if (!on) {
      const waiting = [...this.pending.keys(), ...this.held.keys()];
      for (const id of waiting) this.clearSync(id);
      this.enabled = false;
      this.state = { records: [], windows: [] };
      await this.deps.local.remove(RESTORE_STATE_KEY).catch(() => {});
      this.recomputeKeys();
      await this.gate.sync();
      await this.deps.invalidate();
      for (const id of waiting) {
        const tab = await this.deps.b.tabs.get(id).catch(() => null);
        const address = tab
          ? heldPageTarget(urlOf(tab), this.deps.heldPage)
          : null;
        if (address) await this.openAsPlain(id, address);
        else await this.reloadIfBlocked(id);
      }
      this.persistSession();
      return;
    }
    // Every tab open now is known: the gate never holds them.
    for (const t of await this.deps.b.tabs.query({}))
      if (t.id !== undefined) this.cleared.add(t.id);
    this.enabled = true;
    this.recomputeKeys();
    await this.deps.invalidate();
    this.persistSession();
    await this.snapshot();
  }

  /** Forgets closed container tabs (tests start clean; nothing reopened afterwards returns to a container). */
  async forgetClosed(): Promise<void> {
    this.state.records = this.state.records.filter(
      (r) => !isClosed(r) && !r.prev,
    );
    if (this.recomputeKeys()) await this.deps.invalidate();
    await this.snapshot();
  }

  /** Tests: every tab is known or decided, the snapshot is written and the rules match it. */
  async flush(): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (this.pending.size > 0 && Date.now() < deadline) await sleep(50);
    for (const t of await this.deps.b.tabs.query({}))
      if (t.id !== undefined) this.considerNew(t, true);
    await this.snapshot();
    await this.gate.synced();
    await this.deps.invalidate();
  }

  /** Diagnostics (e2e). */
  debugState(): unknown {
    return {
      enabled: this.enabled,
      records: this.state.records.map((r) => ({ ...r })),
      windows: this.state.windows.length,
      cleared: this.cleared.size,
      pending: [...this.pending.keys()],
      held: [...this.held.keys()],
      ...this.gate.debug(),
      startupUntil: this.startupUntil,
    };
  }

  // ---------------------------------------------------------------- snapshot and the gate

  scheduleSnapshot(): void {
    if (!this.enabled) return;
    this.snapshotLater.schedule();
  }

  /** The worker is about to be stopped (or the browser is going away): a change that has not been written goes now. */
  flushPending(): void {
    if (this.snapshotLater.pending) void this.snapshot();
  }

  /** Rebuilds the records of open container tabs and the window signatures from the live tabs; writes; syncs the gate. */
  snapshot(): Promise<void> {
    this.snapshotLater.cancel();
    this.snapshotWork = this.snapshotWork
      .then(() => this.snapshotNow())
      .catch((error) =>
        this.deps.log("error", "restore snapshot failed", String(error)),
      );
    return this.snapshotWork;
  }

  private async snapshotNow(): Promise<void> {
    if (!this.enabled || this.starting) return;
    const [tabs, groups] = await Promise.all([
      this.deps.b.tabs.query({}),
      this.deps.b.tabGroups.query({}).catch(() => []),
    ]);
    if (!this.enabled) return;
    this.state = buildSnapshot({
      tabs,
      groups,
      containerTabs: this.deps.containerTabs(),
      state: this.state,
      now: Date.now(),
      startupUntil: this.startupUntil,
      present: this.present,
      heldKeys: heldKeys(this.held.values()),
      hasContainer: (id) => this.deps.hasContainer(id),
    });
    await this.deps.local
      .set({ [RESTORE_STATE_KEY]: this.state })
      .catch((error) =>
        this.deps.log("error", "saving restore records failed", String(error)),
      );
    if (this.recomputeKeys()) await this.deps.invalidate();
    await this.gate.sync();
  }

  /** Recomputes the gated addresses; true when the session openers change. */
  private recomputeKeys(): boolean {
    return this.gate.recompute(
      this.state.records,
      this.present,
      this.startupUntil,
      this.held.values(),
    );
  }

  private persistSession(): void {
    this.sessionWriter.schedule();
  }
}
