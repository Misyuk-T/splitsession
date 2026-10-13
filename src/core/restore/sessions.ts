import { gateKey } from "./gate";
import { isClosed, type RestoreRecord } from "./records";
import { windowSignature } from "./windows";

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
export function flattenRecentlyClosed(
  list: readonly SessionLike[],
): ClosedEntry[] {
  const out: ClosedEntry[] = [];
  for (const s of list) {
    if (s.tab?.sessionId && gateKey(s.tab.url))
      out.push({
        sessionId: s.tab.sessionId,
        url: s.tab.url!,
        lastModified: s.lastModified,
      });
    if (s.window) {
      const tabs = (s.window.tabs ?? []).filter((t) => gateKey(t.url));
      const sig = windowSignature(tabs.map((t) => t.url!));
      tabs.forEach((t, pos) => {
        if (t.sessionId)
          out.push({
            sessionId: t.sessionId,
            url: t.url!,
            lastModified: s.lastModified,
            windowSig: sig,
            pos,
          });
      });
    }
  }
  return out;
}

/**
 * Links closed records to their recently-closed entries (sets `sessionId`): a tab closed with its window by the
 * window's signature and position, a tab closed alone by URL and time (within 15 s). Each entry links one record.
 */
export function associateSessions(
  records: RestoreRecord[],
  entries: readonly ClosedEntry[],
  keep: ReadonlySet<string> = new Set(),
): void {
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
      hit = entries.find(
        (e) =>
          open(e) &&
          e.windowSig === r.windowSig &&
          e.pos === r.pos &&
          gateKey(e.url) === key,
      );
    }
    if (!hit && isClosed(r)) {
      const near = entries
        .filter(
          (e) =>
            open(e) &&
            gateKey(e.url) === key &&
            Math.abs(e.lastModified * 1000 - r.closedAt!) <= 15_000,
        )
        .sort(
          (a, b) =>
            Math.abs(a.lastModified * 1000 - r.closedAt!) -
            Math.abs(b.lastModified * 1000 - r.closedAt!),
        );
      hit = near[0];
    }
    if (hit) {
      r.sessionId = hit.sessionId;
      claimed.add(hit.sessionId);
    }
  }
}
