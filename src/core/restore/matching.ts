import type { ContainerId } from "../types";
import { gateKey } from "./gate";
import { decodeGroupMarker } from "./group-marker";
import { isClosed, type RestoreRecord, type SavedWindow } from "./records";
import { layoutWindows, type LiveTab, type WindowLayout } from "./windows";

/** `user`: the user's choice in the popup, not a match. */
export type Evidence = "tab-id" | "window" | "session" | "group" | "user";

export type MatchResult =
  /** `record`: the record the tab takes over (it stops being restorable). */
  | {
      kind: "container";
      containerId: ContainerId;
      evidence: Evidence;
      record: string;
    }
  | { kind: "ambiguous"; candidates: ContainerId[] }
  | { kind: "plain"; reason: string };

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
  return ctx.records.some(
    (r) =>
      r.windowSig === sig &&
      r.viaWindow === true &&
      r.sessionId !== undefined &&
      ctx.consumed.has(r.sessionId),
  );
}

function decide(
  records: readonly RestoreRecord[],
  evidence: Evidence,
): MatchResult {
  const containers = uniq(records.map((r) => r.containerId));
  return containers.length === 1
    ? {
        kind: "container",
        containerId: containers[0]!,
        evidence,
        record: records[0]!.key,
      }
    : { kind: "ambiguous", candidates: containers.sort() };
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
  if (!key) return { kind: "plain", reason: "not a web page" };
  const sameUrl = ctx.records.filter(
    (r) => gateKey(r.url) === key && ctx.hasContainer(r.containerId),
  );
  if (sameUrl.length === 0)
    return { kind: "plain", reason: "no container tab had this address" };

  const byId = sameUrl.filter(
    (r) => !isClosed(r) && r.tabId === tab.id && r.windowId === tab.windowId,
  );
  if (byId.length > 0) return decide(byId, "tab-id");

  const layouts = ctx.layouts ?? layoutWindows(ctx.tabs);
  const layout = layouts.get(tab.windowId);
  const pos = layout?.pos.get(tab.id);
  // A window with one web page says nothing: any link opened in a new window looks like it. Two or more pages in the
  // same order are a pattern; outside a browser start it takes a window that was just reopened from Recently closed.
  if (
    layout &&
    pos !== undefined &&
    layout.count >= MIN_WINDOW_TABS &&
    (ctx.startup || ctx.history || windowRestored(layout.sig, ctx))
  ) {
    const liveSame = [...layouts.values()].filter(
      (l) => l.sig === layout.sig,
    ).length;
    const own = (windowId: number | undefined) =>
      !ctx.history && windowId === tab.windowId;
    const saved = ctx.windows.filter(
      (w) => w.sig === layout.sig && !own(w.windowId),
    ).length;
    if (liveSame === 1 && saved === 1) {
      const atPos = ctx.records.filter(
        (r) =>
          r.windowSig === layout.sig &&
          r.pos === pos &&
          !(own(r.windowId) && !isClosed(r)) &&
          ctx.hasContainer(r.containerId),
      );
      if (atPos.length === 0)
        return { kind: "plain", reason: "its window had a plain tab there" };
      if (atPos.every((r) => gateKey(r.url) === key))
        return decide(atPos, "window");
    }
  }

  const bySession = sameUrl.filter(
    (r) => r.sessionId !== undefined && ctx.consumed.has(r.sessionId),
  );
  if (bySession.length > 0) return decide(bySession, "session");

  const marker =
    tab.groupId >= 0
      ? decodeGroupMarker(ctx.groupTitles.get(tab.groupId))
      : null;
  if (marker !== null) {
    const byGroup = sameUrl.filter(
      (r) => r.containerId === marker && (isClosed(r) || r.prev),
    );
    if (byGroup.length > 0) return decide(byGroup, "group");
  }

  if (ctx.startup) {
    const prev = sameUrl.filter((r) => r.prev);
    if (prev.length > 0)
      return {
        kind: "ambiguous",
        candidates: uniq(prev.map((r) => r.containerId)).sort(),
      };
  }
  return { kind: "plain", reason: "no evidence it was a container tab" };
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
export function oneClickPlan(
  held: readonly HeldTab[],
  records: readonly RestoreRecord[],
): Map<number, ContainerId> {
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
    const [containerId, key] = [
      k.slice(0, k.indexOf(" ")),
      k.slice(k.indexOf(" ") + 1),
    ];
    const available = records.filter(
      (r) =>
        r.containerId === containerId &&
        gateKey(r.url) === key &&
        (r.prev || isClosed(r)),
    ).length;
    if (available >= tabs.length)
      for (const h of tabs) plan.set(h.tabId, containerId);
  }
  return plan;
}
