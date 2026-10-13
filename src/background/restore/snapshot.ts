import {
  type ContainerId,
  decodeGroupMarker,
  gateKey,
  isClosed,
  layoutWindows,
  pruneRecords,
  type RestoreRecord,
  type RestoreState,
  type SavedWindow,
  WINDOW_TTL_MS,
} from "../../core";
import { type TabLike, toLive, urlOf } from "./types";

const MAX_WINDOWS = 60;

const randomKey = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

export interface SnapshotInput {
  /** Every live tab and tab group. */
  tabs: readonly TabLike[];
  groups: ReadonlyArray<{ id: number; title?: string }>;
  /** Every tab in a container right now. */
  containerTabs: Array<[number, ContainerId]>;
  /** The state before this snapshot. */
  state: RestoreState;
  now: number;
  startupUntil: number;
  /** Recently-closed session IDs Chrome lists now. */
  present: Set<string>;
  /** `container address` of every candidate of every waiting tab: their records are kept. */
  heldKeys: Set<string>;
  hasContainer(id: ContainerId): boolean;
}

/** Rebuilds the records of open container tabs and the window signatures from the live tabs. */
export function buildSnapshot(input: SnapshotInput): RestoreState {
  const { now, state, startupUntil } = input;
  const titles = new Map(input.groups.map((g) => [g.id, g.title ?? ""]));
  const live = input.tabs.filter((t) => t.id !== undefined);
  const byId = new Map(live.map((t) => [t.id!, t]));
  const layouts = layoutWindows(live.map(toLive));
  const previous = new Map(
    state.records
      .filter((r) => !isClosed(r) && r.tabId !== undefined)
      .map((r) => [r.tabId!, r]),
  );
  const open: RestoreRecord[] = [];
  const inContainer = new Set<number>();
  for (const [tabId, containerId] of input.containerTabs) {
    inContainer.add(tabId);
    const tab = byId.get(tabId);
    const url = tab ? urlOf(tab) : "";
    if (!tab || !gateKey(url)) continue;
    const layout = layouts.get(tab.windowId);
    const before = previous.get(tabId);
    const groupId =
      tab.groupId !== undefined && tab.groupId >= 0 ? tab.groupId : undefined;
    open.push({
      key:
        before && before.containerId === containerId ? before.key : randomKey(),
      containerId,
      url,
      tabId,
      windowId: tab.windowId,
      ...(groupId !== undefined
        ? {
            groupId,
            inGroup: decodeGroupMarker(titles.get(groupId)) === containerId,
          }
        : {}),
      ...(layout ? { windowSig: layout.sig, pos: layout.pos.get(tabId) } : {}),
      at: now,
    });
  }
  const rest: RestoreRecord[] = [];
  for (const r of state.records) {
    if (isClosed(r)) rest.push(r);
    // Closed without an event reaching us.
    else if (
      r.tabId === undefined ||
      (!byId.has(r.tabId) && !inContainer.has(r.tabId))
    )
      rest.push({ ...r, closedAt: now, viaWindow: false });
    // Otherwise a live tab: listed above while still in a container, dropped once it left its container.
  }
  if (now >= startupUntil) for (const r of rest) delete r.prev;
  // Records a waiting tab may still be put back with are kept (and its address stays gated) until the user decides.
  const pinned = rest.filter(
    (r) =>
      input.heldKeys.has(`${r.containerId} ${gateKey(r.url)}`) &&
      input.hasContainer(r.containerId),
  );
  const records = [
    ...pinned,
    ...pruneRecords(
      [...open, ...rest.filter((r) => !pinned.includes(r))],
      input.present,
      now,
      startupUntil,
      (id) => input.hasContainer(id),
    ),
  ];
  const windows: SavedWindow[] = [];
  for (const [windowId, layout] of layouts)
    windows.push({ sig: layout.sig, windowId, at: now });
  for (const w of state.windows) {
    if (w.windowId !== undefined && layouts.has(w.windowId)) continue;
    if (now - w.at > WINDOW_TTL_MS) continue;
    // A window of this session that is gone keeps its last signature (it may be reopened from History).
    windows.push(
      w.windowId !== undefined && !layouts.has(w.windowId)
        ? { sig: w.sig, at: w.at }
        : w,
    );
  }
  return { records, windows: windows.slice(0, MAX_WINDOWS) };
}
