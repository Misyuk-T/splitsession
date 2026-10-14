import type { ContainerId } from "../core";

/**
 * `chrome.tabs.SPLIT_VIEW_ID_NONE` (Chrome 140+): a tab that is not in a split view. Chrome before 140 has no
 * `splitViewId` at all; for it no tab is ever in a split view.
 */
export const SPLIT_VIEW_ID_NONE = -1;

/** The split view the tab is in (`tabs.Tab.splitViewId`, Chrome 140+), or null. */
export function splitViewOf(tab: { splitViewId?: number }): number | null {
  const id = tab.splitViewId;
  return typeof id === "number" && id !== SPLIT_VIEW_ID_NONE ? id : null;
}

/**
 * The tabs of a split view are not all in one container (two containers, or a container tab and an ordinary one). Such a
 * pair stays out of SplitSession's groups (docs/decisions.md, "Split view: two accounts side by side"): Chrome keeps the
 * two tabs of a split view in one group, so a container group would say something one of them is not.
 */
export function splitIsMixed(containers: Array<ContainerId | null>): boolean {
  return containers.some((c) => c !== containers[0]);
}
