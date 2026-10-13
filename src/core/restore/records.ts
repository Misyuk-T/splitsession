import type { ContainerId } from "../types";
import {
  CLOSED_GRACE_MS,
  MAX_GATE_RULES,
  MAX_RECORDS,
  SAVED_GROUP_TTL_MS,
} from "./constants";
import { gateKey } from "./gate";

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

const isNum = (x: unknown): x is number =>
  typeof x === "number" && Number.isFinite(x);
const optNum = (x: unknown) => x === undefined || isNum(x);
const optStr = (x: unknown) => x === undefined || typeof x === "string";
const optBool = (x: unknown) => x === undefined || typeof x === "boolean";

function isRecord(x: unknown): x is RestoreRecord {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.key === "string" &&
    typeof r.containerId === "string" &&
    typeof r.url === "string" &&
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
  const src =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)
      : {};
  const records = Array.isArray(src.records)
    ? src.records.filter(isRecord).map((r) => ({ ...r }))
    : [];
  const windows = Array.isArray(src.windows)
    ? src.windows
        .filter(
          (w): w is SavedWindow =>
            typeof w === "object" &&
            w !== null &&
            typeof (w as SavedWindow).sig === "string" &&
            isNum((w as SavedWindow).at) &&
            optNum((w as SavedWindow).windowId),
        )
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
export function isRestorable(
  r: RestoreRecord,
  present: ReadonlySet<string>,
  now: number,
  startupUntil: number,
): boolean {
  if (r.prev && now < startupUntil) return true;
  if (!isClosed(r)) return false;
  if (r.savedGroup && now - r.closedAt! < SAVED_GROUP_TTL_MS) return true;
  if (r.sessionId !== undefined && present.has(r.sessionId)) return true;
  return now - r.closedAt! < CLOSED_GRACE_MS;
}

/** URLs the gate holds at the next browser start (dynamic rules): every open record and every restorable one. */
export function persistentGateKeys(
  records: readonly RestoreRecord[],
  present: ReadonlySet<string>,
  now: number,
  startupUntil: number,
): string[] {
  const ordered = [...records].sort(
    (a, b) => (b.closedAt ?? b.at) - (a.closedAt ?? a.at),
  );
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
export function runtimeGateKeys(
  records: readonly RestoreRecord[],
  present: ReadonlySet<string>,
  now: number,
  startupUntil: number,
): Set<string> {
  const keys = new Set<string>();
  for (const r of records) {
    if (!isRestorable(r, present, now, startupUntil)) continue;
    const key = gateKey(r.url);
    if (key) keys.add(key);
  }
  return keys;
}

/** Drops records nothing can bring back any more, and the oldest beyond MAX_RECORDS. */
export function pruneRecords(
  records: readonly RestoreRecord[],
  present: ReadonlySet<string>,
  now: number,
  startupUntil: number,
  hasContainer: (id: ContainerId) => boolean,
): RestoreRecord[] {
  const kept = records.filter(
    (r) =>
      hasContainer(r.containerId) &&
      (!isClosed(r) || isRestorable(r, present, now, startupUntil)),
  );
  kept.sort((a, b) => (b.closedAt ?? b.at) - (a.closedAt ?? a.at));
  return kept.slice(0, MAX_RECORDS);
}
