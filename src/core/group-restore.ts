import { decodeGroupMarker, groupNameOf } from "./restore/group-marker";
import { containerColorOfGroup } from "./indicators";
import { collapseName, MAX_CONTAINER_NAME } from "./names";
import {
  CONTAINER_COLORS,
  type ContainerColor,
  type ContainerId,
} from "./types";

/** A Chrome tab group as `chrome.tabGroups` reports it. */
export interface GroupSnapshot {
  id: number;
  windowId: number;
  title?: string;
  color: string;
}

/** A container the leftover SplitSession groups stand for. */
export interface RestorableContainer {
  /** The ID the group marker names: the container comes back under it (page storage prefixed with it is found again). */
  id: ContainerId;
  name: string;
  color: ContainerColor;
  /** Every group (one per window) that carries this container's marker. */
  groupIds: number[];
}

/** The popup's offer. */
export interface GroupRestoreOffer {
  containers: number;
  groups: number;
}

/** What `restoreFromGroups` did. */
export interface GroupRestoreResult {
  containers: number;
  /** Tabs put into their container. */
  tabs: number;
  /** Tabs that could not be assigned (the group guard retries them later). */
  failed: number;
}

/** `chrome.storage.local` key: the user said no to the offer (or it was taken). */
export const GROUP_RESTORE_DISMISSED_KEY = "groupRestoreDismissed";

const FALLBACK_NAME = "Container";

/** A group name fit for a container: at most `MAX_CONTAINER_NAME` characters, never empty. */
function fitName(raw: string): string {
  const name = Array.from(collapseName(raw)).slice(0, MAX_CONTAINER_NAME);
  return name.join("").trim() || FALLBACK_NAME;
}

/** `name` unless it is taken (case-insensitive), then `name 2`, `name 3`, ... within the length limit. */
function uniqueName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`;
    const base = Array.from(name)
      .slice(0, MAX_CONTAINER_NAME - suffix.length)
      .join("")
      .trimEnd();
    const candidate = base + suffix;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * The containers the groups of an earlier install stand for. Only groups whose title carries SplitSession's invisible
 * marker count (a user group, even one titled "⧉ fake", is never touched). Groups with one marker (the same container in
 * several windows) are one container. Name: the title without glyph and marker; colour: the container colour of the group's
 * colour (grey, which no container has, gets the first colour not used yet).
 */
export function planGroupRestore(
  groups: readonly GroupSnapshot[],
): RestorableContainer[] {
  const byId = new Map<ContainerId, RestorableContainer>();
  const missing: ContainerId[] = []; // containers whose group colour maps to no container colour
  for (const group of [...groups].sort((a, b) => a.id - b.id)) {
    const id = decodeGroupMarker(group.title);
    if (id === null) continue;
    const known = byId.get(id);
    if (known) {
      known.groupIds.push(group.id);
      continue;
    }
    const color = containerColorOfGroup(group.color, "blue");
    byId.set(id, {
      id,
      name: fitName(groupNameOf(group.title)),
      color: color ?? "blue",
      groupIds: [group.id],
    });
    if (color === null) missing.push(id);
  }
  const plan = [...byId.values()];
  const names = new Set<string>();
  for (const c of plan) {
    c.name = uniqueName(c.name, names);
    names.add(c.name.toLowerCase());
  }
  const used = new Set(
    plan.filter((c) => !missing.includes(c.id)).map((c) => c.color),
  );
  for (const id of missing) {
    const color = CONTAINER_COLORS.find((c) => !used.has(c)) ?? "blue";
    byId.get(id)!.color = color;
    used.add(color);
  }
  return plan;
}

/**
 * What the popup offers: the plan, but only when there is no container at all (a fresh install, or storage wiped) and the user has not
 * said no. Nothing is offered next to existing containers, whatever groups are around.
 */
export function groupRestorePlan(input: {
  containerCount: number;
  dismissed: boolean;
  groups: readonly GroupSnapshot[];
}): RestorableContainer[] {
  if (input.containerCount > 0 || input.dismissed) return [];
  return planGroupRestore(input.groups);
}
