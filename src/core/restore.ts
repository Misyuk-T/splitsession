import type { ContainerId } from './types';
import type { DnrRule } from './dnr/rule-compiler';

/**
 * Container tabs that come back: browser restart with session restore, Ctrl/Cmd+Shift+T and History's "Recently
 * closed", a closed (saved) SplitSession tab group opened again. Pure part: what SplitSession remembers about container tabs, how a
 * tab that appears is matched to that memory, the group-title marker, and the declarativeNetRequest gate that keeps
 * such a tab from sending anything before it is matched. The stateful part is `src/background/restore.ts`; the
 * reasoning is in docs/decisions.md ("Container tabs that come back").
 */

/** `chrome.storage.local`: records of container tabs (open and closed) and signatures of windows. */
export const RESTORE_STATE_KEY = 'restoreState';
/** Dynamic rule IDs of the gate: [base, base + MAX_GATE_RULES). The service-worker policy uses IDs 1 and 2. */
export const GATE_RULE_ID_BASE = 1000;
export const MAX_GATE_RULES = 500;
/**
 * Priority of the gate (dynamic `block`) and of the session `allow` rules that open it for known tabs. At equal
 * priority `allow` beats `block`; an `allow` also cancels every `modifyHeaders` rule of the same or lower priority,
 * which is why every cookie rule of SplitSession sits at 2 or above (`CATCH_ALL_PRIORITY`). Measured in Chromium 156.
 */
export const GATE_PRIORITY = 1;
export const MAX_RECORDS = 400;
/** A closed tab whose recently-closed entry has not been found yet stays restorable this long. */
export const CLOSED_GRACE_MS = 60_000;
/** A whole SplitSession group that was closed (Chrome keeps it as a saved group) stays restorable this long. */
export const SAVED_GROUP_TTL_MS = 30 * 24 * 3600_000;
export const WINDOW_TTL_MS = 7 * 24 * 3600_000;
/**
 * How long after a browser start windows that come late (Chrome's "Restore pages?" after a crash, a slow restore) are
 * still matched against the previous session.
 */
export const STARTUP_GRACE_MS = 5 * 60_000;

// ---------------------------------------------------------------- group-title marker

/**
 * SplitSession's groups carry the container ID in their title as invisible characters: `name` + U+2063 + three of four
 * zero-width characters per ID character + U+2063. Chrome keeps the title as it is through session restore and saved
 * groups, the user sees only the name, and a group the user made (or renamed by retyping it) has no marker, so its
 * title never decides a container.
 */
const MARK = '⁣';
const DIGITS = ['​', '‌', '‍', '⁠'] as const;
const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const MARKER_RE = new RegExp(`${MARK}([${DIGITS.join('')}]{3,96})${MARK}$`);

export function groupMarker(containerId: ContainerId): string {
  if (!/^[a-z0-9]{1,32}$/.test(containerId)) return '';
  let out = MARK;
  for (const ch of containerId) {
    const n = ID_ALPHABET.indexOf(ch);
    out += DIGITS[(n >> 4) & 3]! + DIGITS[(n >> 2) & 3]! + DIGITS[n & 3]!;
  }
  return out + MARK;
}

export function groupTitle(name: string, containerId: ContainerId): string {
  return name + groupMarker(containerId);
}

/** The container a title's marker names, or null (no marker, or a malformed one). */
export function decodeGroupMarker(title: string | undefined): ContainerId | null {
  const m = title ? MARKER_RE.exec(title) : null;
  if (!m || m[1]!.length % 3 !== 0) return null;
  let id = '';
  for (let i = 0; i < m[1]!.length; i += 3) {
    const d = (k: number) => DIGITS.indexOf(m[1]![i + k] as (typeof DIGITS)[number]);
    const n = (d(0) << 4) | (d(1) << 2) | d(2);
    if (n >= ID_ALPHABET.length) return null;
    id += ID_ALPHABET[n];
  }
  return id;
}

export function stripGroupMarker(title: string): string {
  return title.replace(MARKER_RE, '');
}

// ---------------------------------------------------------------- URLs and the gate

/** The URL as a request carries it (no fragment); null for anything but http(s). */
export function gateKey(url: string | undefined): string | null {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const hash = url.indexOf('#');
  return hash === -1 ? url : url.slice(0, hash);
}

/**
 * `urlFilter` matching exactly `key` (`|…|`). `*`, `^` and `|` have a meaning in a filter and cannot be escaped: such
 * a URL is matched by its prefix up to the first of them (a little wider). Null for URLs a filter cannot hold (non-ASCII,
 * very long).
 */
export function gateUrlFilter(key: string): string | null {
  if (key.length > 2048 || !/^[\x21-\x7e]+$/.test(key)) return null;
  const special = key.search(/[*^|]/);
  if (special === -1) return `|${key}|`;
  const prefix = key.slice(0, special);
  return /^https?:\/\/[^/]+\//i.test(prefix) ? `|${prefix}` : null;
}

/** The dynamic `block` rules of the gate, one per filter (deduplicated, at most MAX_GATE_RULES). */
export function compileGateRules(keys: Iterable<string>): DnrRule[] {
  const filters = new Set<string>();
  for (const key of keys) {
    const filter = gateUrlFilter(key);
    if (filter) filters.add(filter);
    if (filters.size >= MAX_GATE_RULES) break;
  }
  return [...filters].sort().map((urlFilter, i) => ({
    id: GATE_RULE_ID_BASE + i,
    priority: GATE_PRIORITY,
    condition: { urlFilter, resourceTypes: ['main_frame'] },
    action: { type: 'block' },
  }));
}

/**
 * Session `allow` rules that open the gate: for every tab SplitSession already knows (`clearedTabs`), and for every tab on
 * the URLs that are gated only for the next browser start (`openKeys`: URLs of container tabs that are open now, not
 * of tabs that could come back from "recently closed"). IDs from `next()`.
 */
export function compileGateOpeners(clearedTabs: Iterable<number>, openKeys: Iterable<string>, next: () => number): DnrRule[] {
  const rules: DnrRule[] = [];
  const tabIds = [...new Set(clearedTabs)].filter((id) => Number.isInteger(id) && id >= 0).sort((a, b) => a - b);
  if (tabIds.length > 0) {
    rules.push({ id: next(), priority: GATE_PRIORITY, condition: { tabIds, resourceTypes: ['main_frame'] }, action: { type: 'allow' } });
  }
  const filters = new Set<string>();
  for (const key of openKeys) {
    const filter = gateUrlFilter(key);
    if (filter) filters.add(filter);
    if (filters.size >= MAX_GATE_RULES) break;
  }
  for (const urlFilter of [...filters].sort()) {
    rules.push({ id: next(), priority: GATE_PRIORITY, condition: { urlFilter, resourceTypes: ['main_frame'] }, action: { type: 'allow' } });
  }
  return rules;
}

// ---------------------------------------------------------------- window signatures

function fnv1a(text: string, seed: number): string {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Signature of a window: its http(s) tabs' URLs in tab-strip order (other tabs, such as a new-tab page, are ignored). */
export function windowSignature(urls: readonly string[]): string {
  const text = urls.join('\n');
  return `${urls.length}:${fnv1a(text, 0x811c9dc5)}${fnv1a(text, 0x5bd1e995)}`;
}

export interface LiveTab {
  id: number;
  windowId: number;
  index: number;
  /** `url`, or `pendingUrl` while the first navigation has not committed. */
  url: string;
  groupId: number;
}

export interface WindowLayout {
  sig: string;
  /** How many http(s) tabs the window has. */
  count: number;
  /** Position of each http(s) tab among the window's http(s) tabs. */
  pos: Map<number, number>;
}

export function layoutWindows(tabs: readonly LiveTab[]): Map<number, WindowLayout> {
  const byWindow = new Map<number, LiveTab[]>();
  for (const tab of tabs) {
    if (!gateKey(tab.url)) continue;
    const list = byWindow.get(tab.windowId);
    if (list) list.push(tab);
    else byWindow.set(tab.windowId, [tab]);
  }
  const out = new Map<number, WindowLayout>();
  for (const [windowId, list] of byWindow) {
    list.sort((a, b) => a.index - b.index);
    out.set(windowId, { sig: windowSignature(list.map((t) => t.url)), count: list.length, pos: new Map(list.map((t, i) => [t.id, i])) });
  }
  return out;
}

// ---------------------------------------------------------------- records

export interface RestoreRecord {
  /** Identity of the record (random), kept while the tab lives and after it closed. */
  key: string;
  containerId: ContainerId;
  url: string;
  /** While the tab is open in this browser session. */
  tabId?: number;
  windowId?: number;
  groupId?: number;
  /** Its window's signature and its position among that window's http(s) tabs, at the last snapshot. */
  windowSig?: string;
  pos?: number;
  /** It sat in a SplitSession group (marker) of its own container. */
  inGroup?: boolean;
  /** Last snapshot that saw the tab open (epoch ms). */
  at: number;
  /** Set once the tab closed. */
  closedAt?: number;
  /** Closed together with its window. */
  viaWindow?: boolean;
  /** Its whole SplitSession group closed with it: Chrome keeps such a group (saved tab groups) and can open it again. */
  savedGroup?: boolean;
  /** Its entry in `chrome.sessions.getRecentlyClosed` (valid in this browser session only). */
  sessionId?: string;
  /** Open at the end of the previous browser session (set at browser start, while that session is being restored). */
  prev?: boolean;
}

export interface SavedWindow {
  sig: string;
  /** Live window of this browser session; absent for windows of an earlier session or closed ones. */
  windowId?: number;
  at: number;
}

export interface RestoreState {
  records: RestoreRecord[];
  windows: SavedWindow[];
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const optNum = (x: unknown) => x === undefined || isNum(x);
const optStr = (x: unknown) => x === undefined || typeof x === 'string';
const optBool = (x: unknown) => x === undefined || typeof x === 'boolean';

function isRecord(x: unknown): x is RestoreRecord {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.key === 'string' &&
    typeof r.containerId === 'string' &&
    typeof r.url === 'string' &&
    gateKey(r.url) !== null &&
    isNum(r.at) &&
    optNum(r.tabId) &&
    optNum(r.windowId) &&
    optNum(r.groupId) &&
    optStr(r.windowSig) &&
    optNum(r.pos) &&
    optBool(r.inGroup) &&
    optNum(r.closedAt) &&
    optBool(r.viaWindow) &&
    optBool(r.savedGroup) &&
    optStr(r.sessionId) &&
    optBool(r.prev)
  );
}

/** Tolerant reader for `storage.local` data. */
export function parseRestoreState(raw: unknown): RestoreState {
  const src = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const records = Array.isArray(src.records) ? src.records.filter(isRecord).map((r) => ({ ...r })) : [];
  const windows = Array.isArray(src.windows)
    ? src.windows
        .filter((w): w is SavedWindow => typeof w === 'object' && w !== null && typeof (w as SavedWindow).sig === 'string' && isNum((w as SavedWindow).at) && optNum((w as SavedWindow).windowId))
        .map((w) => ({ ...w }))
    : [];
  return { records, windows };
}

export const isClosed = (r: RestoreRecord): boolean => r.closedAt !== undefined;

/**
 * Can this record's tab still come back without the browser restarting? Closed and either in Chrome's recently-closed
 * list (`present` session IDs), part of a saved group, closed moments ago, or open at the end of the previous browser
 * session while that session is still being restored.
 */
export function isRestorable(r: RestoreRecord, present: ReadonlySet<string>, now: number, startupUntil: number): boolean {
  if (r.prev && now < startupUntil) return true;
  if (!isClosed(r)) return false;
  if (r.savedGroup && now - r.closedAt! < SAVED_GROUP_TTL_MS) return true;
  if (r.sessionId !== undefined && present.has(r.sessionId)) return true;
  return now - r.closedAt! < CLOSED_GRACE_MS;
}

/** URLs the gate holds at the next browser start (dynamic rules): every open record and every restorable one. */
export function persistentGateKeys(records: readonly RestoreRecord[], present: ReadonlySet<string>, now: number, startupUntil: number): string[] {
  const ordered = [...records].sort((a, b) => (b.closedAt ?? b.at) - (a.closedAt ?? a.at));
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const r of ordered) {
    if (isClosed(r) && !isRestorable(r, present, now, startupUntil)) continue;
    const key = gateKey(r.url);
    if (key && !seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  return keys.slice(0, MAX_GATE_RULES);
}

/** URLs the gate holds for tabs that appear now: those of restorable records. */
export function runtimeGateKeys(records: readonly RestoreRecord[], present: ReadonlySet<string>, now: number, startupUntil: number): Set<string> {
  const keys = new Set<string>();
  for (const r of records) {
    if (!isRestorable(r, present, now, startupUntil)) continue;
    const key = gateKey(r.url);
    if (key) keys.add(key);
  }
  return keys;
}

/** Drops records nothing can bring back any more, and the oldest beyond MAX_RECORDS. */
export function pruneRecords(records: readonly RestoreRecord[], present: ReadonlySet<string>, now: number, startupUntil: number, hasContainer: (id: ContainerId) => boolean): RestoreRecord[] {
  const kept = records.filter((r) => hasContainer(r.containerId) && (!isClosed(r) || isRestorable(r, present, now, startupUntil)));
  kept.sort((a, b) => (b.closedAt ?? b.at) - (a.closedAt ?? a.at));
  return kept.slice(0, MAX_RECORDS);
}

// ---------------------------------------------------------------- recently closed (chrome.sessions)

export interface ClosedEntry {
  sessionId: string;
  url: string;
  /** Seconds since the epoch (Chrome's `Session.lastModified`). */
  lastModified: number;
  /** For a tab inside a closed window entry: that window's signature and the tab's position in it. */
  windowSig?: string;
  pos?: number;
}

interface SessionTabLike {
  sessionId?: string;
  url?: string;
}
interface SessionLike {
  lastModified: number;
  tab?: SessionTabLike;
  window?: { sessionId?: string; tabs?: SessionTabLike[] };
}

/** Tabs of `chrome.sessions.getRecentlyClosed()`, those inside window entries included (with the window's signature). */
export function flattenRecentlyClosed(list: readonly SessionLike[]): ClosedEntry[] {
  const out: ClosedEntry[] = [];
  for (const s of list) {
    if (s.tab?.sessionId && gateKey(s.tab.url)) out.push({ sessionId: s.tab.sessionId, url: s.tab.url!, lastModified: s.lastModified });
    if (s.window) {
      const tabs = (s.window.tabs ?? []).filter((t) => gateKey(t.url));
      const sig = windowSignature(tabs.map((t) => t.url!));
      tabs.forEach((t, pos) => {
        if (t.sessionId) out.push({ sessionId: t.sessionId, url: t.url!, lastModified: s.lastModified, windowSig: sig, pos });
      });
    }
  }
  return out;
}

/**
 * Links closed records to their recently-closed entries (sets `sessionId`): a tab closed with its window by the
 * window's signature and position, a tab closed alone by URL and time (within 15 s). Each entry links one record.
 */
export function associateSessions(records: RestoreRecord[], entries: readonly ClosedEntry[], keep: ReadonlySet<string> = new Set()): void {
  const ids = new Set(entries.map((e) => e.sessionId));
  const claimed = new Set<string>();
  for (const r of records) {
    if (r.sessionId === undefined) continue;
    // A link to an entry that is gone is dropped, unless that entry was just restored (the match needs it).
    if (ids.has(r.sessionId)) claimed.add(r.sessionId);
    else if (!keep.has(r.sessionId)) delete r.sessionId;
  }
  const open = (e: ClosedEntry) => !claimed.has(e.sessionId);
  for (const r of records) {
    if (r.sessionId !== undefined || (!isClosed(r) && !r.prev)) continue;
    const key = gateKey(r.url);
    let hit: ClosedEntry | undefined;
    if (r.windowSig !== undefined && (r.viaWindow || r.prev)) {
      hit = entries.find((e) => open(e) && e.windowSig === r.windowSig && e.pos === r.pos && gateKey(e.url) === key);
    }
    if (!hit && isClosed(r)) {
      const near = entries
        .filter((e) => open(e) && gateKey(e.url) === key && Math.abs(e.lastModified * 1000 - r.closedAt!) <= 15_000)
        .sort((a, b) => Math.abs(a.lastModified * 1000 - r.closedAt!) - Math.abs(b.lastModified * 1000 - r.closedAt!));
      hit = near[0];
    }
    if (hit) {
      r.sessionId = hit.sessionId;
      claimed.add(hit.sessionId);
    }
  }
}

// ---------------------------------------------------------------- matching

/** `user`: the user's choice in the popup, not a match. */
export type Evidence = 'tab-id' | 'window' | 'session' | 'group' | 'user';

export type MatchResult =
  /** `record`: the record the tab takes over (it stops being restorable). */
  | { kind: 'container'; containerId: ContainerId; evidence: Evidence; record: string }
  | { kind: 'ambiguous'; candidates: ContainerId[] }
  | { kind: 'plain'; reason: string };

export interface MatchContext {
  /** Every live tab (window layouts come from them). */
  tabs: readonly LiveTab[];
  groupTitles: ReadonlyMap<number, string>;
  records: readonly RestoreRecord[];
  hasContainer(id: ContainerId): boolean;
  /** Recently-closed entries that were just restored. */
  consumed: ReadonlySet<string>;
  windows: readonly SavedWindow[];
  /** Browser start and the minutes after it: a tab with no evidence but the URL of a tab that was open in a container
   * at the end of the previous session is ambiguous rather than plain, and a window's address list counts as evidence. */
  startup: boolean;
  /** Precomputed `layoutWindows(tabs)` (optional). */
  layouts?: Map<number, WindowLayout>;
  /**
   * The remembered windows and records all predate the tabs being matched (the pass right after the session rules
   * were wiped: an extension update keeps window IDs, and the tab's own window then IS the remembered one). Otherwise
   * a live window's own snapshot is ignored: it was taken after the tab appeared and says nothing about it.
   */
  history?: boolean;
}

const uniq = <T>(xs: Iterable<T>): T[] => [...new Set(xs)];

/** Fewest http(s) tabs a window needs for its address list to count as evidence. */
export const MIN_WINDOW_TABS = 2;

/** A record of a window with this signature, closed together with it, whose recently-closed entry was restored just now. */
function windowRestored(sig: string, ctx: MatchContext): boolean {
  return ctx.records.some((r) => r.windowSig === sig && r.viaWindow === true && r.sessionId !== undefined && ctx.consumed.has(r.sessionId));
}

function decide(records: readonly RestoreRecord[], evidence: Evidence): MatchResult {
  const containers = uniq(records.map((r) => r.containerId));
  return containers.length === 1
    ? { kind: 'container', containerId: containers[0]!, evidence, record: records[0]!.key }
    : { kind: 'ambiguous', candidates: containers.sort() };
}

/**
 * Which container (if any) a tab that just appeared belongs to. Evidence, strongest first (the strongest one present
 * decides alone; several containers at that level make the tab ambiguous):
 *  1. `tab-id`: same tab and window ID as an open record (an extension update or reload: the browser kept its tabs);
 *  2. `window`: the tab's window has two or more http(s) tabs, exactly the URLs, in order, of ONE remembered window,
 *     and the record at the tab's position is a container tab (no record there: the tab was a plain tab, and stays
 *     one). Only at a browser start (and the 5 minutes after, and right after an extension update), or when the
 *     recently-closed entry of such a window was restored just now. A window with a single web page is never evidence:
 *     a link from another app, "open bookmark in new window" and the like produce exactly that;
 *  3. `session`: the tab's recently-closed entry was restored just now (Ctrl/Cmd+Shift+T, History);
 *  4. `group`: the tab sits in a group whose title carries SplitSession's marker for a container that has a closed record
 *     with this URL (a saved group opened again).
 * Only the URL in common: plain, except at browser start for URLs of tabs open in a container at the end of the
 * previous session (ambiguous: the user decides).
 */
export function matchRestoredTab(tab: LiveTab, ctx: MatchContext): MatchResult {
  const key = gateKey(tab.url);
  if (!key) return { kind: 'plain', reason: 'not a web page' };
  const sameUrl = ctx.records.filter((r) => gateKey(r.url) === key && ctx.hasContainer(r.containerId));
  if (sameUrl.length === 0) return { kind: 'plain', reason: 'no container tab had this address' };

  const byId = sameUrl.filter((r) => !isClosed(r) && r.tabId === tab.id && r.windowId === tab.windowId);
  if (byId.length > 0) return decide(byId, 'tab-id');

  const layouts = ctx.layouts ?? layoutWindows(ctx.tabs);
  const layout = layouts.get(tab.windowId);
  const pos = layout?.pos.get(tab.id);
  // A window with one web page says nothing: any link opened in a new window looks like it. Two or more pages in the
  // same order are a pattern; outside a browser start it takes a window that was just reopened from Recently closed.
  if (layout && pos !== undefined && layout.count >= MIN_WINDOW_TABS && (ctx.startup || ctx.history || windowRestored(layout.sig, ctx))) {
    const liveSame = [...layouts.values()].filter((l) => l.sig === layout.sig).length;
    const own = (windowId: number | undefined) => !ctx.history && windowId === tab.windowId;
    const saved = ctx.windows.filter((w) => w.sig === layout.sig && !own(w.windowId)).length;
    if (liveSame === 1 && saved === 1) {
      const atPos = ctx.records.filter(
        (r) => r.windowSig === layout.sig && r.pos === pos && !(own(r.windowId) && !isClosed(r)) && ctx.hasContainer(r.containerId),
      );
      if (atPos.length === 0) return { kind: 'plain', reason: 'its window had a plain tab there' };
      if (atPos.every((r) => gateKey(r.url) === key)) return decide(atPos, 'window');
    }
  }

  const bySession = sameUrl.filter((r) => r.sessionId !== undefined && ctx.consumed.has(r.sessionId));
  if (bySession.length > 0) return decide(bySession, 'session');

  const marker = tab.groupId >= 0 ? decodeGroupMarker(ctx.groupTitles.get(tab.groupId)) : null;
  if (marker !== null) {
    const byGroup = sameUrl.filter((r) => r.containerId === marker && (isClosed(r) || r.prev));
    if (byGroup.length > 0) return decide(byGroup, 'group');
  }

  if (ctx.startup) {
    const prev = sameUrl.filter((r) => r.prev);
    if (prev.length > 0) return { kind: 'ambiguous', candidates: uniq(prev.map((r) => r.containerId)).sort() };
  }
  return { kind: 'plain', reason: 'no evidence it was a container tab' };
}

export interface HeldTab {
  tabId: number;
  url: string;
  candidates: ContainerId[];
}

/**
 * "Restore N container tabs" in one click: a held tab goes into its container only when it has exactly one candidate
 * and there are at least as many previous-session records of that container and address as held tabs asking for them
 * (otherwise one of them may have been a plain tab, or a tab of the other container: the user picks per tab).
 */
export function oneClickPlan(held: readonly HeldTab[], records: readonly RestoreRecord[]): Map<number, ContainerId> {
  const plan = new Map<number, ContainerId>();
  const want = new Map<string, HeldTab[]>();
  for (const h of held) {
    const key = gateKey(h.url);
    if (!key || h.candidates.length !== 1) continue;
    const k = `${h.candidates[0]} ${key}`;
    const list = want.get(k);
    if (list) list.push(h);
    else want.set(k, [h]);
  }
  for (const [k, tabs] of want) {
    const [containerId, key] = [k.slice(0, k.indexOf(' ')), k.slice(k.indexOf(' ') + 1)];
    const available = records.filter((r) => r.containerId === containerId && gateKey(r.url) === key && (r.prev || isClosed(r))).length;
    if (available >= tabs.length) for (const h of tabs) plan.set(h.tabId, containerId);
  }
  return plan;
}

// ---------------------------------------------------------------- the page a waiting tab shows

/** The extension page a waiting tab shows instead of Chrome's "blocked" page: `<base>?u=<address>`. No network request. */
export function heldPageUrl(base: string, address: string): string {
  return `${base}?u=${encodeURIComponent(address)}`;
}

/** The address a held page stands for, or null when `url` is not one (`base` is the page without its query). */
export function heldPageTarget(url: string | undefined, base: string): string | null {
  if (!url || !url.startsWith(`${base}?`)) return null;
  const u = new URLSearchParams(url.slice(base.length + 1).split('#')[0]).get('u');
  return u && gateKey(u) !== null ? u : null;
}
