import {
  compileGateOpeners,
  compileGateRules,
  decodeGroupMarker,
  flattenRecentlyClosed,
  gateKey,
  GATE_RULE_ID_BASE,
  heldPageTarget,
  heldPageUrl,
  isClosed,
  layoutWindows,
  matchRestoredTab,
  MAX_GATE_RULES,
  oneClickPlan,
  parseRestoreState,
  persistentGateKeys,
  pruneRecords,
  RESTORE_STATE_KEY,
  runtimeGateKeys,
  STARTUP_GRACE_MS,
  WINDOW_TTL_MS,
  associateSessions,
  type CompiledRules,
  type ContainerId,
  type DnrRule,
  type HeldTab,
  type LiveTab,
  type MatchResult,
  type RestoreRecord,
  type RestoreState,
  type RuleIdAllocator,
  type SavedWindow,
} from '../core';
import type { StorageAreaLike } from '../engine/storage/storage-area';
import type { Logger } from './log';

/** Session-rule key of the gate's openers (container IDs are [a-z0-9], so no clash). */
export const RESTORE_KEY = '@restore';
/** `chrome.storage.session`: which tabs are known, held, and the recently-closed entries last seen. */
export const RESTORE_SESSION_KEY = 'restoreSession';

/** A tab that appeared is matched this long after it appeared (its group and recently-closed change arrive meanwhile). */
const SETTLE_MS = 400;
/**
 * A change is written this long after the last one (and at the latest SNAPSHOT_MAX_WAIT_MS after the first of a burst):
 * the browser may be quit a moment after a tab closed, and a stale window signature locks tabs out at the next start.
 */
const SNAPSHOT_DELAY_MS = 100;
const SNAPSHOT_MAX_WAIT_MS = 500;
/** Browser start: the tab set must stay unchanged this long before the restored session is matched (at most MAX). */
const STARTUP_STABLE_MS = 400;
const STARTUP_MAX_WAIT_MS = 3_000;
/** A restored entry counts as "just restored" for tabs that appeared up to this long before the change was seen. */
const CONSUMED_WINDOW_MS = 10_000;
const RELOAD_GUARD_MS = 10_000;
const MAX_WINDOWS = 60;

interface TabLike {
  id?: number;
  windowId: number;
  index: number;
  url?: string;
  pendingUrl?: string;
  groupId?: number;
  status?: string;
  discarded?: boolean;
  title?: string;
}

/** The parts of `chrome.*` the restore manager uses. */
export interface RestoreBrowser {
  tabs: {
    query(q: object): Promise<TabLike[]>;
    get(id: number): Promise<TabLike>;
    reload(id: number): Promise<void>;
    update(id: number, props: { url: string }): Promise<unknown>;
  };
  tabGroups: { query(q: object): Promise<Array<{ id: number; title?: string }>> };
  sessions: { getRecentlyClosed(filter?: { maxResults?: number }): Promise<unknown[]> };
  webNavigation: { getFrame(d: { tabId: number; frameId: number }): Promise<{ errorOccurred?: boolean; url?: string } | null | undefined> };
  declarativeNetRequest: {
    getDynamicRules(): Promise<Array<{ id: number }>>;
    updateDynamicRules(o: { removeRuleIds?: number[]; addRules?: DnrRule[] }): Promise<void>;
  };
}

export interface RestoreDeps {
  b: RestoreBrowser;
  local: StorageAreaLike;
  session: StorageAreaLike;
  log: Logger;
  /** Every tab in a container right now. */
  containerTabs(): Array<[number, ContainerId]>;
  hasContainer(id: ContainerId): boolean;
  isContainerTab(tabId: number): boolean;
  /** `Facet.assign`: puts the tab in the container (it calls `clearSync` itself); throws when the rules fail. */
  assign(tabId: number, containerId: ContainerId): Promise<void>;
  /** Recompiles this module's session rules (`RESTORE_KEY`); resolves once they are installed. */
  invalidate(): Promise<boolean>;
  prepareNavigation(url: string | undefined): Promise<void>;
  /** The extension page a waiting tab shows, without its query (`held.html`). */
  heldPage: string;
  /** The set of waiting tabs changed (`tabIds`: those added or removed): badges follow. */
  heldChanged(tabIds: number[]): void;
}

interface HeldEntry extends HeldTab {
  at: number;
}

interface Pending {
  since: number;
  timer: ReturnType<typeof setTimeout> | null;
}

interface SessionState {
  cleared: number[];
  held: HeldEntry[];
  present: string[];
  startupUntil: number;
}

export interface RestoreStatus {
  enabled: boolean;
  /** Tabs SplitSession could not match with certainty: they wait (their address is not loaded) until the user decides. */
  held: Array<{ tabId: number; url: string; title: string; candidates: ContainerId[] }>;
  /** How many of them "Restore container tabs" puts back in one click. */
  oneClick: number;
}

const randomKey = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const urlOf = (t: TabLike): string => t.url || t.pendingUrl || '';
const toLive = (t: TabLike): LiveTab => ({ id: t.id!, windowId: t.windowId, index: t.index, url: urlOf(t), groupId: t.groupId ?? -1 });

function parseSession(raw: unknown): SessionState | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const s = raw as Record<string, unknown>;
  const nums = (x: unknown) => (Array.isArray(x) ? x.filter((n): n is number => Number.isInteger(n) && (n as number) >= 0) : []);
  return {
    cleared: nums(s.cleared),
    held: Array.isArray(s.held)
      ? (s.held as HeldEntry[]).filter((h) => h && Number.isInteger(h.tabId) && typeof h.url === 'string' && Array.isArray(h.candidates))
      : [],
    present: Array.isArray(s.present) ? s.present.filter((x): x is string => typeof x === 'string') : [],
    startupUntil: typeof s.startupUntil === 'number' ? s.startupUntil : 0,
  };
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
  private persistentKeys = new Set<string>();
  private runtimeKeys = new Set<string>();
  /** Joined filters of the dynamic gate rules installed now (null: not read yet). */
  private installedGate: string | null = null;
  private installedGateIds: number[] = [];
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshotFirstAt = 0;
  private snapshotWork: Promise<void> = Promise.resolve();
  private sessionTimer: ReturnType<typeof setTimeout> | null = null;
  private dynamicWork: Promise<void> = Promise.resolve();
  /** Browser start in progress: snapshots wait (the previous session's records are being matched). */
  private starting = false;
  /** Tabs that appeared while the worker was stopped: checked for a blocked request once the rules are back. */
  private readonly recheck = new Set<number>();
  /** Groups Chrome removed in the last seconds (their tabs' removals may be reported after the group's). */
  private readonly removedGroups = new Map<number, number>();

  constructor(private readonly deps: RestoreDeps) {}

  isEnabled(): boolean {
    return this.enabled;
  }

  // ---------------------------------------------------------------- start

  /**
   * Called during rehydration, before the session rules are reinstalled. Returns true when `storage.session` was empty
   * (browser start, extension update, reload or re-enable): every session rule is gone and the gate holds every tab, so
   * `startupPass` must run. Otherwise (the worker was only stopped) the known tabs are known again.
   */
  async load(liveTabs: readonly TabLike[], enabled: boolean): Promise<boolean> {
    this.enabled = enabled;
    const [loc, ses] = await Promise.all([this.deps.local.get(RESTORE_STATE_KEY), this.deps.session.get(RESTORE_SESSION_KEY)]);
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
      for (const h of saved.held) if (liveIds.has(h.tabId)) this.held.set(h.tabId, h);
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
    const lastActivity = Math.max(0, ...this.state.records.map((r) => Math.max(r.at, r.closedAt ?? 0)));
    for (const r of this.state.records) {
      if (!isClosed(r) || (r.viaWindow && r.closedAt! >= lastActivity - 30_000)) r.prev = true;
      delete r.sessionId;
    }
    this.startupUntil = now + STARTUP_GRACE_MS;
    this.starting = true;
    this.recomputeKeys();
    const candidates = new Set(this.state.records.map((r) => gateKey(r.url)).filter((k): k is string => k !== null));
    for (const t of live) {
      const key = gateKey(urlOf(t));
      if (key && candidates.has(key)) this.pending.set(t.id!, { since: now, timer: null });
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
      void this.syncDynamic();
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
    }
    for (const id of this.recheck) void this.reloadIfBlocked(id);
    this.recheck.clear();
    await this.snapshot();
  }

  private async matchPreviousSession(): Promise<void> {
    if (this.pending.size > 0) await this.waitForStableTabs();
    await this.refreshSessions();
    const [tabs, groups] = await Promise.all([this.deps.b.tabs.query({}), this.deps.b.tabGroups.query({}).catch(() => [])]);
    const live = tabs.filter((t) => t.id !== undefined);
    // Tabs that appeared while we waited: the same treatment.
    const candidates = new Set(this.state.records.map((r) => gateKey(r.url)));
    for (const t of live) {
      if (this.cleared.has(t.id!) || this.pending.has(t.id!)) continue;
      if (candidates.has(gateKey(urlOf(t)))) this.pending.set(t.id!, { since: Date.now(), timer: null });
      else this.clearSync(t.id!);
    }
    const ctx = { ...this.context(live, groups, true, 0), history: true };
    const claimed = new Set<string>();
    const order = live.filter((t) => this.pending.has(t.id!)).sort((a, b) => a.windowId - b.windowId || a.index - b.index);
    let restored = 0;
    for (const tab of order) {
      const result = matchRestoredTab(toLive(tab), { ...ctx, records: ctx.records.filter((r) => !claimed.has(r.key)) });
      if (result.kind === 'container') claimed.add(result.record);
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
    this.deps.log('info', `restore after start: ${restored} container tabs back, ${this.held.size} waiting for the user`);
  }

  private async waitForStableTabs(): Promise<void> {
    const deadline = Date.now() + STARTUP_MAX_WAIT_MS;
    let last = '';
    let since = Date.now();
    while (Date.now() < deadline) {
      const tabs = await this.deps.b.tabs.query({}).catch(() => []);
      const sig = tabs
        .map((t) => `${t.id}:${t.windowId}:${t.index}:${urlOf(t)}:${t.groupId}`)
        .sort()
        .join('|');
      if (sig !== last) {
        last = sig;
        since = Date.now();
      } else if (Date.now() - since >= STARTUP_STABLE_MS) {
        return;
      }
      await sleep(100);
    }
  }

  // ---------------------------------------------------------------- session rules

  /** Session rules of `RESTORE_KEY`: the openers of the gate. */
  compile(allocator: RuleIdAllocator): CompiledRules | null {
    if (!this.enabled) return null;
    const openKeys = [...this.persistentKeys].filter((k) => !this.runtimeKeys.has(k));
    const addRules = compileGateOpeners(this.cleared, openKeys, () => allocator.next());
    return addRules.length > 0 ? { addRules, ruleIds: addRules.map((r) => r.id), regexRuleCount: 0 } : null;
  }

  /** The tab is known from now on (its requests pass the gate). True when that changed the rules (invalidate). */
  clearSync(tabId: number): boolean {
    if (tabId < 0) return false;
    const p = this.pending.get(tabId);
    if (p?.timer) clearTimeout(p.timer);
    const wasPending = this.pending.delete(tabId);
    const wasHeld = this.held.delete(tabId);
    if (wasHeld) this.deps.heldChanged([tabId]);
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
    if (this.pending.has(tabId) || this.held.has(tabId)) await this.clear(tabId);
    return address;
  }

  /** The address a waiting tab stands for (it shows SplitSession's page), or undefined. */
  heldAddress(tabId: number): string | undefined {
    return this.held.get(tabId)?.url;
  }

  isHeld(tabId: number): boolean {
    return this.held.has(tabId);
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
    if (this.cleared.has(id) || this.pending.has(id) || this.held.has(id)) return;
    const key = gateKey(urlOf(tab));
    if (this.enabled && key && this.runtimeKeys.has(key)) {
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
    if (!this.enabled || tabId < 0 || this.cleared.has(tabId) || this.pending.has(tabId) || this.held.has(tabId)) return;
    const key = gateKey(url);
    if (!key || !this.persistentKeys.has(key)) return;
    this.pending.set(tabId, { since: Date.now(), timer: null });
    this.schedule(tabId);
  }

  /** `webRequest.onErrorOccurred` for a main frame. */
  requestFailed(details: { tabId: number; url: string; type?: string; error?: string }): void {
    if (details.tabId < 0 || details.type !== 'main_frame' || details.error !== 'net::ERR_BLOCKED_BY_CLIENT') return;
    const key = gateKey(details.url);
    if (!key || !this.persistentKeys.has(key)) return;
    this.blocked.set(details.tabId, { url: details.url, at: Date.now() });
    // Known already: its opener landed a moment after the request (a brand-new tab navigating at once).
    if (this.cleared.has(details.tabId)) void this.reloadIfBlocked(details.tabId);
  }

  /** A container tab's main frame committed: its record follows at once (the snapshot may come too late at a close). */
  tabCommitted(tabId: number, url: string, containerId: ContainerId | undefined): void {
    if (!this.enabled) return;
    const key = gateKey(url);
    if (containerId !== undefined && key) {
      const rec = this.state.records.find((r) => r.tabId === tabId && !isClosed(r));
      if (rec && rec.url !== url) rec.url = url;
      this.scheduleSnapshot();
    }
    // A waiting tab went somewhere the gate does not hold: the user moved on, it is an ordinary tab.
    if ((this.held.has(tabId) || this.pending.has(tabId)) && key && !this.persistentKeys.has(key)) void this.clear(tabId);
  }

  tabRemoved(tabId: number, isWindowClosing: boolean): void {
    const p = this.pending.get(tabId);
    if (p?.timer) clearTimeout(p.timer);
    this.pending.delete(tabId);
    const wasHeld = this.held.delete(tabId);
    if (wasHeld) this.deps.heldChanged([tabId]);
    const changed = this.cleared.delete(tabId) || wasHeld;
    this.blocked.delete(tabId);
    this.reloadedAt.delete(tabId);
    if (!this.enabled) return;
    const rec = this.state.records.find((r) => r.tabId === tabId && !isClosed(r));
    if (rec) {
      rec.closedAt = Date.now();
      rec.viaWindow = isWindowClosing;
      const groupGone = rec.groupId !== undefined ? this.removedGroups.get(rec.groupId) : undefined;
      if (rec.inGroup && groupGone !== undefined && rec.closedAt - groupGone < 5_000) rec.savedGroup = true;
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
    for (const r of this.state.records) if (r.tabId === removed) r.tabId = added;
    if (this.enabled) void this.deps.invalidate();
    this.persistSession();
    this.scheduleSnapshot();
  }

  /** Chrome removed a group: tabs of it closed just now closed with their whole group (Chrome saves such a group). */
  groupRemoved(groupId: number): void {
    if (!this.enabled) return;
    const now = Date.now();
    for (const [id, at] of this.removedGroups) if (now - at > 5_000) this.removedGroups.delete(id);
    this.removedGroups.set(groupId, now);
    let changed = false;
    for (const r of this.state.records) {
      if (r.groupId === groupId && r.inGroup && isClosed(r) && now - r.closedAt! < 5_000 && !r.savedGroup) {
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
    const list = await this.deps.b.sessions.getRecentlyClosed({ maxResults: 25 }).catch(() => null);
    if (!list) return;
    const entries = flattenRecentlyClosed(list as never);
    const now = Date.now();
    const ids = new Set(entries.map((e) => e.sessionId));
    for (const id of this.present) if (!ids.has(id) && !this.consumed.has(id)) this.consumed.set(id, now);
    for (const [id, at] of this.consumed) if (now - at > CONSUMED_WINDOW_MS) this.consumed.delete(id);
    this.present = ids;
    associateSessions(this.state.records, entries, new Set(this.consumed.keys()));
    this.persistSession();
  }

  // ---------------------------------------------------------------- deciding

  private schedule(tabId: number): void {
    const p = this.pending.get(tabId);
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    p.timer = setTimeout(() => void this.decide(tabId), SETTLE_MS);
  }

  private context(tabs: readonly TabLike[], groups: ReadonlyArray<{ id: number; title?: string }>, startup: boolean, since: number) {
    const consumed = new Set([...this.consumed].filter(([, at]) => at >= since - CONSUMED_WINDOW_MS).map(([id]) => id));
    const live = tabs.filter((t) => t.id !== undefined).map(toLive);
    return {
      tabs: live,
      layouts: layoutWindows(live),
      groupTitles: new Map(groups.map((g) => [g.id, g.title ?? ''])),
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
    if (!tab) return;
    const ctx = this.context(tabs, groups, Date.now() < this.startupUntil, p.since);
    await this.apply(tab, matchRestoredTab(toLive(tab), ctx));
    this.persistSession();
  }

  /** Puts a decision into effect. True when the tab went into a container. */
  private async apply(tab: TabLike, result: MatchResult): Promise<boolean> {
    const tabId = tab.id!;
    const url = this.addressOf(tab);
    const onHeldPage = heldPageTarget(urlOf(tab), this.deps.heldPage) !== null;
    if (result.kind === 'container') {
      this.blocked.delete(tabId);
      try {
        await this.deps.assign(tabId, result.containerId);
      } catch (error) {
        this.deps.log('error', `tab ${tabId} could not be restored into ${result.containerId}`, String(error));
        await this.clear(tabId);
        return false;
      }
      this.state.records = this.state.records.filter((r) => r.key !== result.record || !(isClosed(r) || r.prev));
      this.deps.log('info', `tab ${tabId} restored into ${result.containerId} (${result.evidence})`, url);
      // Not loaded yet (restored "unloaded" or discarded): it loads in the container when the user opens it.
      if (tab.status !== 'unloaded' && !tab.discarded) {
        this.reloadedAt.set(tabId, Date.now());
        await this.deps.prepareNavigation(url);
        // A waiting tab shows SplitSession's page: it goes to the address it stood for.
        await (onHeldPage ? this.deps.b.tabs.update(tabId, { url }) : this.deps.b.tabs.reload(tabId)).catch(() => {});
      }
      this.scheduleSnapshot();
      return true;
    }
    if (result.kind === 'ambiguous') {
      this.held.set(tabId, { tabId, url, candidates: result.candidates, at: Date.now() });
      this.deps.log('warn', `tab ${tabId} may belong to ${result.candidates.join(' or ')}: waiting for the user`, url);
      this.persistSession();
      this.deps.heldChanged([tabId]);
      // Chrome's "blocked by an extension" says nothing: the tab shows SplitSession's page with the choices instead (no request).
      if (!onHeldPage) await this.deps.b.tabs.update(tabId, { url: heldPageUrl(this.deps.heldPage, url) }).catch(() => {});
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
    const frame = await this.deps.b.webNavigation.getFrame({ tabId, frameId: 0 }).catch(() => null);
    const noted = this.blocked.get(tabId);
    const failed = frame?.errorOccurred === true && gateKey(frame.url) !== null && this.persistentKeys.has(gateKey(frame.url)!);
    if (!noted && !failed) return;
    this.blocked.delete(tabId);
    this.reloadedAt.set(tabId, now);
    if (this.deps.isContainerTab(tabId)) await this.deps.prepareNavigation(frame?.url ?? noted?.url);
    await this.deps.b.tabs.reload(tabId).catch(() => {});
  }

  /** A waiting tab, now an ordinary one: it goes from SplitSession's page to its address (nothing is blocked any more). */
  private async openAsPlain(tabId: number, url: string): Promise<void> {
    this.blocked.delete(tabId);
    this.reloadedAt.set(tabId, Date.now());
    const tab = await this.deps.b.tabs.get(tabId).catch(() => null);
    if (!tab) return;
    if (heldPageTarget(urlOf(tab), this.deps.heldPage) !== null) await this.deps.b.tabs.update(tabId, { url }).catch(() => {});
    else await this.reloadIfBlocked(tabId);
  }

  // ---------------------------------------------------------------- the popup's banner

  async status(): Promise<RestoreStatus> {
    const held = [...this.held.values()];
    // The title of SplitSession's own page says nothing about the address.
    const titles = await Promise.all(
      held.map((h) =>
        this.deps.b.tabs.get(h.tabId).then(
          (t) => (heldPageTarget(urlOf(t), this.deps.heldPage) !== null ? '' : (t.title ?? '')),
          () => null,
        ),
      ),
    );
    const live = held.filter((_, i) => titles[i] !== null);
    return {
      enabled: this.enabled,
      held: live.map((h) => ({ tabId: h.tabId, url: h.url, title: titles[held.indexOf(h)] ?? '', candidates: [...h.candidates] })),
      oneClick: oneClickPlan(live, this.state.records).size,
    };
  }

  /** "Restore container tabs" (the one-click plan) or "Open as ordinary tabs" for the held tabs (or some of them). */
  async resolveHeld(action: 'restore' | 'plain', tabIds?: number[]): Promise<number> {
    const targets = [...this.held.values()].filter((h) => !tabIds || tabIds.includes(h.tabId));
    let done = 0;
    if (action === 'restore') {
      const plan = oneClickPlan(targets, this.state.records);
      for (const [tabId, containerId] of plan) {
        const tab = await this.deps.b.tabs.get(tabId).catch(() => null);
        if (!tab) continue;
        const key = gateKey(this.held.get(tabId)?.url);
        const record = this.state.records.find((r) => r.containerId === containerId && gateKey(r.url) === key && (r.prev || isClosed(r)));
        this.held.delete(tabId);
        this.deps.heldChanged([tabId]);
        if (await this.apply(tab, { kind: 'container', containerId, evidence: 'user', record: record?.key ?? '' })) done++;
      }
    } else {
      for (const h of targets) {
        await this.clear(h.tabId);
        await this.openAsPlain(h.tabId, h.url);
        done++;
      }
    }
    this.persistSession();
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
      await this.syncDynamic();
      await this.deps.invalidate();
      for (const id of waiting) {
        const tab = await this.deps.b.tabs.get(id).catch(() => null);
        const address = tab ? heldPageTarget(urlOf(tab), this.deps.heldPage) : null;
        if (address) await this.openAsPlain(id, address);
        else await this.reloadIfBlocked(id);
      }
      this.persistSession();
      return;
    }
    // Every tab open now is known: the gate never holds them.
    for (const t of await this.deps.b.tabs.query({})) if (t.id !== undefined) this.cleared.add(t.id);
    this.enabled = true;
    this.recomputeKeys();
    await this.deps.invalidate();
    this.persistSession();
    await this.snapshot();
  }

  /** Forgets closed container tabs (tests start clean; nothing reopened afterwards returns to a container). */
  async forgetClosed(): Promise<void> {
    this.state.records = this.state.records.filter((r) => !isClosed(r) && !r.prev);
    if (this.recomputeKeys()) await this.deps.invalidate();
    await this.snapshot();
  }

  /** Tests: every tab is known or decided, the snapshot is written and the rules match it. */
  async flush(): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (this.pending.size > 0 && Date.now() < deadline) await sleep(50);
    for (const t of await this.deps.b.tabs.query({})) if (t.id !== undefined) this.considerNew(t, true);
    await this.snapshot();
    await this.dynamicWork;
    await this.deps.invalidate();
  }

  /** Diagnostics (state page, e2e). */
  debugState(): unknown {
    return {
      enabled: this.enabled,
      records: this.state.records.map((r) => ({ ...r })),
      windows: this.state.windows.length,
      cleared: this.cleared.size,
      pending: [...this.pending.keys()],
      held: [...this.held.keys()],
      gated: [...this.persistentKeys],
      runtime: [...this.runtimeKeys],
      startupUntil: this.startupUntil,
    };
  }

  // ---------------------------------------------------------------- snapshot and the gate

  scheduleSnapshot(): void {
    if (!this.enabled) return;
    const now = Date.now();
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    else this.snapshotFirstAt = now;
    // A burst of changes is written at the latest SNAPSHOT_MAX_WAIT_MS after its first.
    const wait = Math.max(0, Math.min(SNAPSHOT_DELAY_MS, this.snapshotFirstAt + SNAPSHOT_MAX_WAIT_MS - now));
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      void this.snapshot();
    }, wait);
  }

  /** The worker is about to be stopped (or the browser is going away): a change that has not been written goes now. */
  flushPending(): void {
    if (this.snapshotTimer) void this.snapshot();
  }

  /** Rebuilds the records of open container tabs and the window signatures from the live tabs; writes; syncs the gate. */
  snapshot(): Promise<void> {
    if (this.snapshotTimer) {
      clearTimeout(this.snapshotTimer);
      this.snapshotTimer = null;
    }
    this.snapshotWork = this.snapshotWork.then(() => this.snapshotNow()).catch((error) => this.deps.log('error', 'restore snapshot failed', String(error)));
    return this.snapshotWork;
  }

  private async snapshotNow(): Promise<void> {
    if (!this.enabled || this.starting) return;
    const [tabs, groups] = await Promise.all([this.deps.b.tabs.query({}), this.deps.b.tabGroups.query({}).catch(() => [])]);
    if (!this.enabled) return;
    const now = Date.now();
    const titles = new Map(groups.map((g) => [g.id, g.title ?? '']));
    const live = tabs.filter((t) => t.id !== undefined);
    const byId = new Map(live.map((t) => [t.id!, t]));
    const layouts = layoutWindows(live.map(toLive));
    const previous = new Map(this.state.records.filter((r) => !isClosed(r) && r.tabId !== undefined).map((r) => [r.tabId!, r]));
    const open: RestoreRecord[] = [];
    const inContainer = new Set<number>();
    for (const [tabId, containerId] of this.deps.containerTabs()) {
      inContainer.add(tabId);
      const tab = byId.get(tabId);
      const url = tab ? urlOf(tab) : '';
      if (!tab || !gateKey(url)) continue;
      const layout = layouts.get(tab.windowId);
      const before = previous.get(tabId);
      const groupId = tab.groupId !== undefined && tab.groupId >= 0 ? tab.groupId : undefined;
      open.push({
        key: before && before.containerId === containerId ? before.key : randomKey(),
        containerId,
        url,
        tabId,
        windowId: tab.windowId,
        ...(groupId !== undefined ? { groupId, inGroup: decodeGroupMarker(titles.get(groupId)) === containerId } : {}),
        ...(layout ? { windowSig: layout.sig, pos: layout.pos.get(tabId) } : {}),
        at: now,
      });
    }
    const rest: RestoreRecord[] = [];
    for (const r of this.state.records) {
      if (isClosed(r)) rest.push(r);
      // Closed without an event reaching us.
      else if (r.tabId === undefined || (!byId.has(r.tabId) && !inContainer.has(r.tabId))) rest.push({ ...r, closedAt: now, viaWindow: false });
      // Otherwise a live tab: listed above while still in a container, dropped once it left its container.
    }
    if (now >= this.startupUntil) for (const r of rest) delete r.prev;
    // Records a waiting tab may still be put back with are kept (and its address stays gated) until the user decides.
    const waiting = this.heldKeys();
    const pinned = rest.filter((r) => waiting.has(`${r.containerId} ${gateKey(r.url)}`) && this.deps.hasContainer(r.containerId));
    const records = [
      ...pinned,
      ...pruneRecords(
        [...open, ...rest.filter((r) => !pinned.includes(r))],
        this.present,
        now,
        this.startupUntil,
        (id) => this.deps.hasContainer(id),
      ),
    ];
    const windows: SavedWindow[] = [];
    for (const [windowId, layout] of layouts) windows.push({ sig: layout.sig, windowId, at: now });
    for (const w of this.state.windows) {
      if (w.windowId !== undefined && layouts.has(w.windowId)) continue;
      if (now - w.at > WINDOW_TTL_MS) continue;
      // A window of this session that is gone keeps its last signature (it may be reopened from History).
      windows.push(w.windowId !== undefined && !layouts.has(w.windowId) ? { sig: w.sig, at: w.at } : w);
    }
    this.state = { records, windows: windows.slice(0, MAX_WINDOWS) };
    await this.deps.local.set({ [RESTORE_STATE_KEY]: this.state }).catch((error) => this.deps.log('error', 'saving restore records failed', String(error)));
    if (this.recomputeKeys()) await this.deps.invalidate();
    await this.syncDynamic();
  }

  /** `container address` of every candidate of every waiting tab. */
  private heldKeys(): Set<string> {
    const keys = new Set<string>();
    for (const h of this.held.values()) for (const c of h.candidates) keys.add(`${c} ${gateKey(h.url)}`);
    return keys;
  }

  /** Recomputes the gated addresses; true when the session openers change. */
  private recomputeKeys(): boolean {
    const now = Date.now();
    const before = [...this.persistentKeys].filter((k) => !this.runtimeKeys.has(k)).join('\n');
    this.persistentKeys = this.enabled ? new Set(persistentGateKeys(this.state.records, this.present, now, this.startupUntil)) : new Set();
    this.runtimeKeys = this.enabled ? runtimeGateKeys(this.state.records, this.present, now, this.startupUntil) : new Set();
    // A waiting tab stays held whatever its records say.
    if (this.enabled) for (const h of this.held.values()) if (gateKey(h.url)) this.runtimeKeys.add(gateKey(h.url)!);
    for (const k of this.runtimeKeys) this.persistentKeys.add(k);
    const after = [...this.persistentKeys].filter((k) => !this.runtimeKeys.has(k)).join('\n');
    return before !== after;
  }

  /**
   * Makes the dynamic gate rules match `persistentKeys`. Openers for new addresses are installed first (session rules),
   * so a new block never catches a tab it should not.
   */
  private syncDynamic(): Promise<void> {
    this.dynamicWork = this.dynamicWork
      .then(async () => {
        const dnr = this.deps.b.declarativeNetRequest;
        if (this.installedGate === null) {
          const existing = await dnr.getDynamicRules();
          this.installedGateIds = existing.map((r) => r.id).filter((id) => id >= GATE_RULE_ID_BASE && id < GATE_RULE_ID_BASE + MAX_GATE_RULES);
          this.installedGate = (existing as Array<{ id: number; condition?: { urlFilter?: string } }>)
            .filter((r) => this.installedGateIds.includes(r.id))
            .map((r) => r.condition?.urlFilter ?? '')
            .sort()
            .join('\n');
        }
        const rules = this.enabled ? compileGateRules(this.persistentKeys) : [];
        const joined = rules.map((r) => r.condition.urlFilter!).join('\n');
        if (joined === this.installedGate) return;
        if (rules.length > 0) await this.deps.invalidate();
        await dnr.updateDynamicRules({ removeRuleIds: this.installedGateIds, addRules: rules });
        this.installedGate = joined;
        this.installedGateIds = rules.map((r) => r.id);
      })
      .catch((error) => {
        this.installedGate = null;
        this.deps.log('error', 'updating the restore gate failed', String(error));
      });
    return this.dynamicWork;
  }

  private persistSession(): void {
    if (this.sessionTimer) return;
    this.sessionTimer = setTimeout(() => {
      this.sessionTimer = null;
      const state: SessionState = {
        cleared: [...this.cleared],
        held: [...this.held.values()],
        present: [...this.present],
        startupUntil: this.startupUntil,
      };
      void this.deps.session.set({ [RESTORE_SESSION_KEY]: state }).catch(() => {});
    }, 50);
  }
}
