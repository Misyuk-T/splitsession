import {
  AGENT_MARK_GLYPHS,
  checkContainerName,
  type Container,
  type ContainerColor,
  containerColorOfGroup,
  type ContainerId,
  decodeGroupMarker,
  GROUP_COLOR,
  type GroupGlyph,
  groupNameOf,
  groupTitle,
  groupTitleWithGlyph,
  hasMarkGlyph,
  type Settings,
  sleep,
  startsWithGroupGlyph,
} from "../core";
import type { StorageAreaLike } from "../engine/storage/storage-area";
import { splitIsMixed, splitViewOf } from "./split-view";

/** `chrome.storage.session` key: Chrome tab-group IDs this module created, with the container each one stands for. */
export const OWNED_GROUPS_KEY = "ownedGroups";

export interface GroupTab {
  id?: number;
  windowId: number;
  groupId: number;
  pinned?: boolean;
  /** Chrome 140+: the split view the tab is in (-1 or absent: none). */
  splitViewId?: number;
}

export interface TabsLike {
  get(tabId: number): Promise<GroupTab>;
  group(options: {
    tabIds: number[];
    groupId?: number;
    createProperties?: { windowId: number };
  }): Promise<number>;
  ungroup(tabIds: number[]): Promise<void>;
  query(queryInfo: {
    groupId?: number;
    splitViewId?: number;
  }): Promise<GroupTab[]>;
}

export interface TabGroupsLike {
  get(
    groupId: number,
  ): Promise<{ id: number; windowId: number; title?: string; color: string }>;
  update(
    groupId: number,
    properties: { title?: string; color?: string },
  ): Promise<unknown>;
  query?(
    queryInfo: object,
  ): Promise<
    Array<{ id: number; windowId: number; title?: string; color: string }>
  >;
}

/** A group as `tabGroups.onUpdated` reports it. */
export interface GroupState {
  id: number;
  title?: string;
  color: string;
}

export interface TabGroupDeps {
  tabs: TabsLike;
  tabGroups: TabGroupsLike;
  area: StorageAreaLike;
  settings(): Settings;
  container(id: ContainerId): Container | undefined;
  /** Every container (a name typed into a group must not duplicate another one). */
  containers(): Container[];
  /** The user renamed or recoloured a group in Chrome's menu: the container follows (the engine then emits "container-updated"). */
  updateContainer(
    id: ContainerId,
    patch: { name?: string; color?: ContainerColor },
  ): Promise<unknown>;
  /** Every tab currently assigned to a container. */
  containerTabs(): Array<{ tabId: number; containerId: ContainerId }>;
  log(level: "info" | "warn" | "error", message: string, data?: unknown): void;
  /** Retry back-off while the user is dragging a tab (default: real timers). */
  delay?(ms: number): Promise<void>;
  /** Quiet time after the last edit of a group's title or colour before the container follows (default 700 ms). */
  editSettleMs?: number;
}

const RETRIES = 6;
const RETRY_DELAY_MS = 150;
/** The user types a group's name in Chrome's editor and Chrome reports every keystroke: the container follows once they pause. */
const EDIT_SETTLE_MS = 700;
/** The glyph of a marked group goes to the other frame of its blink this often (Full). */
export const BLINK_MS = 1_200;
/** An update SplitSession made itself is remembered this long, to tell its echo from the user's edit. */
const EXPECTED_TTL_MS = 10_000;

/**
 * Projection of containers onto Chrome tab groups: one group per (window, container), titled with the container's
 * name and coloured like it. The registry (`tabId -> container`) is the truth; groups are only a view, so nothing here
 * ever reads a tab's group to find its container, and a tab the user drags out of a group or into another one keeps
 * its container (and is NOT pulled back: the view is re-applied only when the tab is assigned or moved to another
 * window, when a container is renamed or recoloured, when the setting is switched on, or on "Re-group").
 * Chrome deletes a group when its last tab leaves, which removes empty groups for us.
 * One exception, the other way round (`group-guard.ts`): every tab inside a group that carries the marker of a container
 * is in that container (a tab dragged in is reopened there, a tab Chrome creates inside the group is assigned), because
 * the group looks like the container and a tab that is not in it would be logged in as someone else under its name.
 * Titles are `⧉ name` + an invisible marker with the container ID (`groupTitle`, `core/restore.ts`): the glyph tells the user
 * the group is SplitSession's, the marker identifies it. A group Chrome brings back (session restore, a saved group opened
 * again) is recognised by the marker as this container's and taken over instead of a second group being made, and the
 * restore matcher can tell SplitSession's groups from the user's (a user group titled "⧉ fake" has no marker: not ours).
 * A split view whose tabs are not all in one container is never grouped (grouping one of its tabs groups both: Chrome),
 * and leaves a group that carries a container's marker (`ungroupSplit`, `mixedSplit`).
 * Two ways: the user renaming or recolouring one of our groups in Chrome's group menu changes the container (`groupUpdated`,
 * after a short pause; SplitSession's own updates are told apart by an expected-updates list), and the container's other
 * groups follow. Collapsing a group is not an edit. Full edition: while the agent works in a tab of a group its title glyph blinks between two
 * emoji (`setActivity`; the colour is not touched); that change is ours too, never an edit, and a user's rename or recolour
 * meanwhile still syncs, with the mark on top.
 */
export class TabGroupProjection {
  /** groupId -> container it was made for. */
  private owned = new Map<number, ContainerId>();
  private queue: Promise<unknown> = Promise.resolve();
  /** groupId -> updates SplitSession made and whose echo (`tabGroups.onUpdated`) has not been seen. */
  private expected = new Map<
    number,
    Array<{ title: string; color?: string; at: number; quiet?: boolean }>
  >();

  /**
   * Full only: groups that show the agent-activity mark right now (the title glyph blinking between two emoji), with the frame
   * of the blink the glyph is at (0 or 1). Memory only on purpose: when the worker dies the agent's activity display is gone with
   * it, so the next start (`adoptExisting`) puts "⧉ " and the container's colour back.
   */
  private activity = new Map<number, number>();
  private blinkTimer: ReturnType<typeof setInterval> | null = null;

  /** groupId -> counter of the user's last edit, so only the last one of a burst is acted on. */
  private editGen = new Map<number, number>();
  private readonly delay: (ms: number) => Promise<void>;

  constructor(private readonly deps: TabGroupDeps) {
    this.delay = deps.delay ?? sleep;
  }

  async load(): Promise<void> {
    const stored = (await this.deps.area.get(OWNED_GROUPS_KEY))[
      OWNED_GROUPS_KEY
    ];
    this.owned = new Map();
    if (typeof stored === "object" && stored !== null) {
      for (const [id, container] of Object.entries(stored)) {
        if (Number.isInteger(Number(id)) && typeof container === "string")
          this.owned.set(Number(id), container);
      }
    }
  }

  ownedGroups(): Array<[number, ContainerId]> {
    return [...this.owned];
  }

  // ---- entry points (each is serialised, so two events never create two groups for one container) ----

  /** A tab entered a container, or moved to another window: put it in the container's group in its window. */
  tabAssigned(tabId: number, containerId: ContainerId): Promise<void> {
    return this.enqueue(() => this.ensureGrouped(tabId, containerId));
  }

  /** A tab left its container: out of our group (a group of the user's own making is left alone). */
  tabUnassigned(tabId: number, containerId: ContainerId): Promise<void> {
    return this.enqueue(async () => {
      let tab: GroupTab;
      try {
        tab = await this.deps.tabs.get(tabId);
      } catch {
        return; // closed
      }
      if (tab.groupId < 0) return;
      // Also a marked group SplitSession does not keep (groups off): a group may not stand for a container its tab left.
      if (
        this.owned.get(tab.groupId) === containerId ||
        (await this.markerOf(tab.groupId)) === containerId
      )
        await this.ungroup([tabId]);
    });
  }

  /**
   * The container a group stands for, read from its invisible title marker (null: not one of ours, a user's group, a
   * title the user retyped, a deleted container). A marked group Chrome brought back is taken over on the way, so the
   * tab that joins it later lands in this group and not in a second one.
   */
  containerOfGroup(groupId: number): Promise<ContainerId | null> {
    return this.enqueueValue(async () => {
      const group = await this.deps.tabGroups.get(groupId).catch(() => null);
      const id = group ? decodeGroupMarker(group.title) : null;
      if (id === null || !this.deps.container(id)) return null;
      if (!this.owned.has(groupId) && this.deps.settings().tabGroups) {
        this.owned.set(groupId, id);
        await this.persist();
        await this.normalise(groupId, group!); // a title of an earlier version gets the glyph
      }
      return id;
    }, null);
  }

  /**
   * A tab SplitSession created landed in a group that stands for another container (Chrome puts a tab created inside a
   * group into that group): into its own container's group, or out of the group when it has no container or groups are
   * off. The group must not say something the tab is not.
   */
  placeOwn(tabId: number, containerId: ContainerId | null): Promise<void> {
    // Unlike the other entry points this one reports failure (a drag that outlasts the retries): the group guard tries again.
    const done = this.queue.then(() =>
      containerId !== null
        ? this.ensureGrouped(tabId, containerId, false, true)
        : this.leaveForeignGroup(tabId, null, true),
    );
    this.queue = done.catch(
      (error) =>
        void this.deps.log("warn", "tab group update failed", String(error)),
    );
    return done;
  }

  /**
   * The tabs of a split view that is not all of one container: out of their group (both, Chrome moves them together), with
   * their containers untouched. Reports failure like `placeOwn` (the group guard retries after a drag).
   */
  ungroupSplit(tabIds: number[]): Promise<void> {
    const done = this.queue.then(() => this.ungroup(tabIds, true));
    this.queue = done.catch(
      (error) =>
        void this.deps.log("warn", "tab group update failed", String(error)),
    );
    return done;
  }

  /** Name or colour changed: the groups follow. */
  containerUpdated(container: Container): Promise<void> {
    return this.enqueue(() => this.applyToGroups(container));
  }

  /**
   * The user changed one of our groups in Chrome's menu (`tabGroups.onUpdated`; call after `load`). Only groups SplitSession
   * keeps count (a restored group is taken over and set to the container's state, never the other way round). SplitSession's
   * own updates, and collapsing, change nothing. The state this event reports is what the edit is read from (`syncEdited`), not
   * the group as it is when the pause is over: a decoration written meanwhile (the agent mark) cannot take the edit with it.
   */
  groupUpdated(group: GroupState): Promise<void> {
    if (!this.owned.has(group.id) || this.consumeExpected(group))
      return Promise.resolve();
    const gen = (this.editGen.get(group.id) ?? 0) + 1;
    this.editGen.set(group.id, gen);
    const pause = this.deps.editSettleMs ?? EDIT_SETTLE_MS;
    return (
      pause > 0
        ? new Promise<void>((resolve) => setTimeout(resolve, pause))
        : Promise.resolve()
    ).then(() => {
      if (this.editGen.get(group.id) !== gen) return; // edited again meanwhile: that one will do
      this.editGen.delete(group.id);
      return this.enqueue(() => this.syncEdited(group.id, group));
    });
  }

  /**
   * Startup (after `load`): every group Chrome kept with a container's marker (restart, saved groups) is taken over and
   * shown in the container's current form, which also rewrites titles of earlier versions (no glyph), a blink emoji or a "◉ ◎ ○"
   * that the previous worker left behind (Full: it died while the agent was working; nothing shows the activity now). Taking
   * over also sets the group's colour to the container's (the container is the truth), which is what puts back the colour
   * that 0.1.6's colour pulse could leave behind. A marked group that is not taken over (groups off, deleted container) gets
   * only the glyph clean-up (`clearLeftoverMark`); its colour is never touched.
   */
  adoptExisting(): Promise<void> {
    return this.enqueue(async () => {
      const keep = this.deps.settings().tabGroups;
      // Lite has no activity marks to clean up: nothing to do with groups off.
      if (!this.deps.tabGroups.query || (!keep && !__FULL__)) return;
      const groups = await this.deps.tabGroups.query({}).catch(() => []);
      let changed = false;
      for (const group of groups) {
        const id = decodeGroupMarker(group.title);
        if (id === null) continue;
        if (!keep || !this.deps.container(id)) {
          if (__FULL__) await this.clearLeftoverMark(group);
          continue;
        }
        if (this.owned.get(group.id) !== id) {
          this.owned.set(group.id, id);
          changed = true;
        }
        await this.normalise(group.id, group);
      }
      if (changed) await this.persist();
    });
  }

  containerDeleted(id: ContainerId): Promise<void> {
    return this.enqueue(async () => {
      for (const [groupId, containerId] of [...this.owned])
        if (containerId === id) {
          this.owned.delete(groupId);
          this.activity.delete(groupId);
        }
      this.syncBlink();
      await this.persist();
    });
  }

  /** Chrome removed a group (last tab closed, or the user closed it). */
  groupRemoved(groupId: number): Promise<void> {
    this.activity.delete(groupId);
    this.syncBlink();
    return this.enqueue(async () => {
      if (this.owned.delete(groupId)) await this.persist();
    });
  }

  /** Setting switched on, or the "Re-group" action: every container tab into its group. */
  reconcileAll(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.deps.settings().tabGroups) return;
      for (const { tabId, containerId } of this.deps.containerTabs())
        await this.ensureGrouped(tabId, containerId, true);
    });
  }

  /** Setting switched off: take every tab out of the groups this module made. */
  releaseAll(): Promise<void> {
    return this.enqueue(async () => {
      for (const groupId of [...this.owned.keys()]) {
        const tabs = await this.deps.tabs
          .query({ groupId })
          .catch(() => [] as GroupTab[]);
        const ids = tabs
          .map((t) => t.id)
          .filter((id): id is number => id !== undefined);
        if (ids.length > 0) await this.ungroup(ids);
      }
      this.owned.clear();
      this.activity.clear();
      this.syncBlink();
      await this.persist();
    });
  }

  /**
   * Full only. The agent is working in a tab of this group (`on`) or has stopped. While it works the group's title glyph blinks
   * between "✦" and "✧" every `BLINK_MS` instead of "⧉" (the three glyphs are equally wide, so the tabs next to the chip do not
   * move, and neither do the start and the end); name and invisible marker are untouched, and the group's COLOUR is never
   * written. The glyph shows when the group is collapsed too. Only groups SplitSession keeps are marked (a plain group, or any
   * group with groups off, is ignored). One title-only write for the start, one per tick, one for the end; a call that does not
   * change the state, and a burst, write nothing. Every write is remembered as ours and quiet (`takeMarkEcho`,
   * `consumeExpected`), so it neither renames the container nor wakes the group guard; a rename or a recolour the user makes
   * meanwhile still syncs (and the mark stays on top: `wantedFor`).
   */
  setActivity(groupId: number, on: boolean): Promise<void> {
    if (!__FULL__) return Promise.resolve();
    if (on) {
      if (!this.owned.has(groupId) || !this.deps.settings().tabGroups)
        return Promise.resolve();
      if (this.activity.has(groupId)) return Promise.resolve();
      this.activity.set(groupId, 0);
    } else if (!this.activity.delete(groupId)) {
      return Promise.resolve();
    }
    this.syncBlink();
    return this.enqueue(() => this.showActivity(groupId));
  }

  /**
   * True (and forgotten) when this update is the echo of a mark change `setActivity` made: nothing for the group guard or the
   * sync to do. Call it before them.
   */
  takeMarkEcho(group: GroupState): boolean {
    return __FULL__ && this.consumeExpected(group, true);
  }

  /** Resolves when everything queued so far has run (tests, e2e). */
  idle(): Promise<void> {
    return this.queue.then(() => undefined);
  }

  // ---- internals ----

  private enqueue(work: () => Promise<void>): Promise<void> {
    return this.enqueueValue(work, undefined);
  }

  private enqueueValue<T>(work: () => Promise<T>, fallback: T): Promise<T> {
    const next = this.queue.then(work).catch((error) => {
      this.deps.log("warn", "tab group update failed", String(error));
      return fallback;
    });
    this.queue = next;
    return next;
  }

  /** Takes the tab out of its group when that group carries the marker of a container other than `containerId`. */
  private async leaveForeignGroup(
    tabId: number,
    containerId: ContainerId | null,
    strict = false,
  ): Promise<void> {
    const tab = await this.deps.tabs.get(tabId).catch(() => null);
    if (!tab || tab.groupId < 0) return;
    const marker = await this.markerOf(tab.groupId);
    if (marker !== null && marker !== containerId)
      await this.ungroup([tabId], strict);
  }

  /** The tab is in a split view whose tabs are not all in one container: the IDs of its tabs; otherwise null. */
  private async mixedSplit(tabId: number): Promise<number[] | null> {
    const tab = await this.deps.tabs.get(tabId).catch(() => null);
    const splitViewId = tab ? splitViewOf(tab) : null;
    if (splitViewId === null) return null;
    const pair = await this.deps.tabs
      .query({ splitViewId })
      .catch(() => [] as GroupTab[]);
    const ids = pair
      .map((t) => t.id)
      .filter((id): id is number => id !== undefined);
    if (!ids.includes(tabId)) ids.unshift(tabId);
    const of = new Map(
      this.deps.containerTabs().map((e) => [e.tabId, e.containerId]),
    );
    return splitIsMixed(ids.map((id) => of.get(id) ?? null)) ? ids : null;
  }

  private async markerOf(groupId: number): Promise<ContainerId | null> {
    const group = await this.deps.tabGroups.get(groupId).catch(() => null);
    return group ? decodeGroupMarker(group.title) : null;
  }

  private async ensureGrouped(
    tabId: number,
    containerId: ContainerId,
    force = false,
    strict = false,
  ): Promise<void> {
    const split = await this.mixedSplit(tabId);
    if (split !== null) {
      // Two accounts side by side: no container group may hold the pair (docs/decisions.md, "Split view").
      const tab = await this.deps.tabs.get(tabId).catch(() => null);
      if (
        tab &&
        tab.groupId >= 0 &&
        (await this.markerOf(tab.groupId)) !== null
      )
        await this.ungroup(split, strict);
      return;
    }
    // Groups off: SplitSession makes none, but a tab may not stay in a group that names another container.
    if (!this.deps.settings().tabGroups)
      return this.leaveForeignGroup(tabId, containerId, strict);
    const container = this.deps.container(containerId);
    if (!container) return;
    let tab: GroupTab;
    try {
      tab = await this.deps.tabs.get(tabId);
    } catch {
      return; // closed meanwhile
    }
    if (tab.pinned) return; // Chrome cannot group pinned tabs
    if (tab.groupId >= 0 && !this.owned.has(tab.groupId)) {
      // A group Chrome brought back with this container's marker (session restore, a saved group opened again).
      const group = await this.deps.tabGroups
        .get(tab.groupId)
        .catch(() => null);
      if (group && decodeGroupMarker(group.title) === containerId) {
        this.owned.set(tab.groupId, containerId);
        await this.persist();
        force = true;
      }
    }

    if (tab.groupId >= 0 && this.owned.get(tab.groupId) === containerId) {
      if (force)
        await this.applyGroup(
          tab.groupId,
          this.wantedFor(container, tab.groupId),
        ).catch(() => {});
      return; // already where it belongs
    }

    let groupId = await this.groupFor(containerId, tab.windowId);
    if (groupId === null) {
      groupId = await this.retrying(() =>
        this.deps.tabs.group({
          tabIds: [tabId],
          createProperties: { windowId: tab.windowId },
        }),
      );
      this.owned.set(groupId, containerId);
      await this.persist();
    } else {
      await this.retrying(() =>
        this.deps.tabs.group({ tabIds: [tabId], groupId: groupId! }),
      );
    }
    await this.applyGroup(groupId, this.wantedFor(container, groupId));
  }

  /** The group this module keeps for the container in that window, if it still exists. */
  private async groupFor(
    containerId: ContainerId,
    windowId: number,
  ): Promise<number | null> {
    for (const [groupId, owner] of [...this.owned]) {
      if (owner !== containerId) continue;
      try {
        const group = await this.deps.tabGroups.get(groupId);
        if (group.windowId === windowId) return groupId;
      } catch {
        this.owned.delete(groupId); // gone
        await this.persist();
      }
    }
    return null;
  }

  private async ungroup(tabIds: number[], strict = false): Promise<void> {
    const done = this.retrying(() => this.deps.tabs.ungroup(tabIds));
    await (strict ? done : done.catch(() => {}));
  }

  /**
   * Sets the title (and colour), remembering that this update is ours. `quiet`: an agent-activity mark change, whose echo
   * the group guard's sweep does not need to see either (`takeMarkEcho`).
   */
  private async applyGroup(
    groupId: number,
    wanted: { title?: string; color?: string },
    quiet = false,
    /**
     * The state the echo must report when the write leaves a part alone (a title-only write: the colour the group has; a
     * colour-only write: its title). A part someone else changed meanwhile makes the event not our echo.
     */
    after: { title: string; color: string } | null = null,
  ): Promise<void> {
    const entry = {
      title: wanted.title ?? after?.title ?? "",
      color: wanted.color ?? after?.color,
      at: Date.now(),
      ...(quiet ? { quiet } : {}),
    };
    this.expected.set(groupId, [...(this.expected.get(groupId) ?? []), entry]);
    try {
      await this.deps.tabGroups.update(groupId, wanted);
    } catch (error) {
      this.expected.set(
        groupId,
        (this.expected.get(groupId) ?? []).filter((e) => e !== entry),
      );
      throw error;
    }
  }

  /** True (and forgotten) when this state is the echo of an update SplitSession made. */
  private consumeExpected(group: GroupState, quietOnly = false): boolean {
    const now = Date.now();
    const live = (this.expected.get(group.id) ?? []).filter(
      (e) => now - e.at < EXPECTED_TTL_MS,
    );
    const index = live.findIndex(
      (e) =>
        (!quietOnly || e.quiet === true) &&
        e.title === (group.title ?? "") &&
        (e.color === undefined || e.color === group.color),
    );
    if (index !== -1) live.splice(index, 1);
    if (live.length > 0) this.expected.set(group.id, live);
    else this.expected.delete(group.id);
    return index !== -1;
  }

  /** The glyph a group shows now: idle (`false`) or its frame of the blink. */
  private glyphOf(groupId: number): GroupGlyph {
    const frame = __FULL__ ? this.activity.get(groupId) : undefined;
    return frame === undefined ? false : frame;
  }

  /** The title and colour a group of the container shows now: the blink glyph while the agent works in it; the colour is always the container's. */
  private wantedFor(
    container: Container,
    groupId: number,
  ): { title: string; color: string } {
    return {
      title: groupTitle(container.name, container.id, this.glyphOf(groupId)),
      color: GROUP_COLOR[container.color],
    };
  }

  /** Every group of the container (every window) shows its current name and colour. */
  private async applyToGroups(container: Container): Promise<void> {
    for (const [groupId, containerId] of [...this.owned]) {
      if (containerId !== container.id) continue;
      await this.applyGroup(groupId, this.wantedFor(container, groupId)).catch(
        () => this.forget(groupId),
      );
    }
  }

  /**
   * Puts the group's glyph in line with `activity` (start, tick and end are all this), by swapping only the glyph of the title the
   * group has now (name and marker kept). Title only. Chrome has no "update if unchanged", so title and colour are read again
   * right before the write; when either changed in between (the user is renaming or recolouring) the swap is worked out again
   * from the new state, never written over a state it was not decided on. What still slips through that window is not lost: the
   * user's event carries their title and colour and the sync reads the edit from it (`syncEdited`). Nothing is written when the
   * title already is the wanted one.
   */
  private async showActivity(groupId: number): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const containerId = this.owned.get(groupId);
      const group = await this.deps.tabGroups.get(groupId).catch(() => null);
      if (
        containerId === undefined ||
        !this.deps.container(containerId) ||
        !group
      ) {
        this.activity.delete(groupId); // gone, or no longer ours
        this.syncBlink();
        return;
      }
      // A title without the container's marker (retyped by the user): not ours to edit; the sync puts the title back, with the glyph.
      if (decodeGroupMarker(group.title) !== containerId) return;
      const title = groupTitleWithGlyph(
        group.title ?? "",
        this.glyphOf(groupId),
      );
      if (title === group.title) return;
      const again = await this.deps.tabGroups.get(groupId).catch(() => null);
      if (!again || again.title !== group.title || again.color !== group.color)
        continue; // renamed or recoloured meanwhile: decide again from the new state
      await this.applyGroup(groupId, { title }, true, {
        title,
        color: group.color,
      }).catch(() => {});
      return;
    }
  }

  /** One blink tick: every marked group's glyph goes to the other frame (title only). */
  private blink(): void {
    for (const [groupId, frame] of [...this.activity]) {
      this.activity.set(groupId, frame === 0 ? 1 : 0);
      void this.enqueue(() => this.showActivity(groupId));
    }
  }

  /** The blink timer runs while some group is marked, and only then. */
  private syncBlink(): void {
    if (!__FULL__) return;
    if (this.activity.size > 0 && this.blinkTimer === null) {
      this.blinkTimer = setInterval(() => this.blink(), BLINK_MS);
    } else if (this.activity.size === 0 && this.blinkTimer !== null) {
      clearInterval(this.blinkTimer);
      this.blinkTimer = null;
    }
  }

  /**
   * Clean-up for a group of ours that nothing is marking (the worker that marked it is gone) and that is not taken over (groups
   * off, deleted container): a glyph left by the mark (a blink emoji, or the "◉ ◎ ○" of 0.1.5-dev builds) goes back to "⧉ ". The
   * glyph is unambiguous, so this runs on every start. The colour is NOT touched here: a palette colour cannot prove that 0.1.6's
   * pulse left it, and with groups off the user's own purple or pink on a marked group is theirs. Only groups with our marker
   * come here.
   */
  private async clearLeftoverMark(group: GroupState): Promise<void> {
    if (this.activity.has(group.id)) return;
    const id = decodeGroupMarker(group.title);
    if (id === null || !hasMarkGlyph(group.title)) return;
    const title = groupTitleWithGlyph(group.title ?? "", false);
    await this.applyGroup(group.id, { title }, true, {
      title,
      color: group.color,
    }).catch(() => {});
  }

  /** The group shows the container's current title and colour (it was just taken over; the container is the truth). */
  private async normalise(
    groupId: number,
    group: { title?: string; color: string },
  ): Promise<void> {
    const container = this.deps.container(this.owned.get(groupId) ?? "");
    if (!container) return;
    const wanted = this.wantedFor(container, groupId);
    // While the group is marked either frame of the blink is fine (the blink moves it by itself).
    const titleOk =
      group.title === wanted.title ||
      (__FULL__ &&
        this.activity.has(groupId) &&
        AGENT_MARK_GLYPHS.some(
          (_, frame) =>
            group.title === groupTitle(container.name, container.id, frame),
        ));
    if (!titleOk || group.color !== wanted.color)
      await this.applyGroup(groupId, wanted).catch(() => {});
  }

  /**
   * A group of ours was edited in Chrome's menu: the name typed (the title without "⧉ " and the marker) becomes the
   * container's name, the group colour becomes its colour; the container's groups in every window follow. A name that is
   * empty, too long or another container's is refused: the group shows the container's name again, and it is logged. A
   * colour no container has (grey) is refused the same way. Whatever the user deleted from the title (glyph, marker)
   * is put back. The title the user typed is the one the update event reported (`seen`): re-reading the group could return a
   * title a decoration of ours was written over, and the edit would be lost.
   */
  private async syncEdited(
    groupId: number,
    seen: { title?: string; color?: string },
  ): Promise<void> {
    const containerId = this.owned.get(groupId);
    const container =
      containerId === undefined ? undefined : this.deps.container(containerId);
    if (!container || !this.deps.settings().tabGroups) return;
    const group = await this.deps.tabGroups.get(groupId).catch(() => null);
    if (!group) return;

    const patch: { name?: string; color?: ContainerColor } = {};
    const typed = groupNameOf(seen.title);
    const others = this.deps
      .containers()
      .filter((c) => c.id !== container.id)
      .map((c) => c.name);
    const check = checkContainerName(typed, others, container.name);
    if (
      check.ok &&
      check.name !== container.name &&
      startsWithGroupGlyph(check.name)
    ) {
      // "⧉ ◉ Job": the second glyph is part of the name, which would read as the glyph next time. Never a container name.
      this.deps.log(
        "warn",
        "tab group rename refused, the group shows the container’s name again",
        { groupId, container: container.name, typed, reason: "starts with ⧉" },
      );
    } else if (check.ok) {
      if (check.name !== container.name) patch.name = check.name;
    } else {
      this.deps.log(
        "warn",
        "tab group rename refused, the group shows the container’s name again",
        { groupId, container: container.name, typed, reason: check.message },
      );
    }
    // The colour is the one the event reported too (the mark never writes colours: whatever it says is the user's choice).
    const color = containerColorOfGroup(
      seen.color ?? group.color,
      container.color,
    );
    if (color !== null && color !== container.color) patch.color = color;

    if (patch.name !== undefined || patch.color !== undefined) {
      try {
        await this.deps.updateContainer(container.id, patch);
        this.deps.log("info", "container changed from its tab group", {
          groupId,
          container: container.id,
          ...patch,
        });
      } catch (error) {
        this.deps.log(
          "warn",
          "container could not follow its tab group",
          String(error),
        );
      }
    }
    const now = this.deps.container(container.id) ?? container;
    if (now.name !== container.name || now.color !== container.color)
      await this.applyToGroups(now);
    else await this.normalise(groupId, group);
  }

  private forget(groupId: number): void {
    this.owned.delete(groupId);
    void this.persist();
  }

  /** Chrome refuses to edit tabs while the user is dragging one: wait a moment and try again. */
  private async retrying<T>(action: () => Promise<T>): Promise<T> {
    let last: unknown;
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      try {
        return await action();
      } catch (error) {
        last = error;
        if (
          !/cannot be edited|dragging/i.test(
            String((error as Error)?.message ?? error),
          )
        )
          throw error;
        await this.delay(RETRY_DELAY_MS);
      }
    }
    throw last;
  }

  private persist(): Promise<void> {
    return this.deps.area
      .set({ [OWNED_GROUPS_KEY]: Object.fromEntries(this.owned) })
      .catch(() => {});
  }
}
