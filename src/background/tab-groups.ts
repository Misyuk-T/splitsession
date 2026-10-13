import {
  checkContainerName,
  type Container,
  type ContainerColor,
  containerColorOfGroup,
  type ContainerId,
  decodeGroupMarker,
  GROUP_COLOR,
  groupNameOf,
  groupTitle,
  type Settings,
  sleep,
} from "../core";
import type { StorageAreaLike } from "../engine/storage/storage-area";

/** `chrome.storage.session` key: Chrome tab-group IDs this module created, with the container each one stands for. */
export const OWNED_GROUPS_KEY = "ownedGroups";

export interface GroupTab {
  id?: number;
  windowId: number;
  groupId: number;
  pinned?: boolean;
}

export interface TabsLike {
  get(tabId: number): Promise<GroupTab>;
  group(options: {
    tabIds: number[];
    groupId?: number;
    createProperties?: { windowId: number };
  }): Promise<number>;
  ungroup(tabIds: number[]): Promise<void>;
  query(queryInfo: { groupId?: number }): Promise<GroupTab[]>;
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
 * Two ways: the user renaming or recolouring one of our groups in Chrome's group menu changes the container (`groupUpdated`,
 * after a short pause; SplitSession's own updates are told apart by an expected-updates list), and the container's other
 * groups follow. Collapsing a group is not an edit.
 */
export class TabGroupProjection {
  /** groupId -> container it was made for. */
  private owned = new Map<number, ContainerId>();
  private queue: Promise<unknown> = Promise.resolve();
  /** groupId -> updates SplitSession made and whose echo (`tabGroups.onUpdated`) has not been seen. */
  private expected = new Map<
    number,
    Array<{ title: string; color: string; at: number }>
  >();

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

  /** Name or colour changed: the groups follow. */
  containerUpdated(container: Container): Promise<void> {
    return this.enqueue(() => this.applyToGroups(container));
  }

  /**
   * The user changed one of our groups in Chrome's menu (`tabGroups.onUpdated`; call after `load`). Only groups SplitSession
   * keeps count (a restored group is taken over and set to the container's state, never the other way round). SplitSession's
   * own updates, and collapsing, change nothing. See `syncEdited`.
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
      return this.enqueue(() => this.syncEdited(group.id));
    });
  }

  /**
   * Startup (after `load`): every group Chrome kept with a container's marker (restart, saved groups) is taken over and
   * shown in the container's current form, which also rewrites titles of earlier versions (no glyph).
   */
  adoptExisting(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.deps.settings().tabGroups || !this.deps.tabGroups.query) return;
      const groups = await this.deps.tabGroups.query({}).catch(() => []);
      let changed = false;
      for (const group of groups) {
        const id = decodeGroupMarker(group.title);
        if (id === null || !this.deps.container(id)) continue;
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
        if (containerId === id) this.owned.delete(groupId);
      await this.persist();
    });
  }

  /** Chrome removed a group (last tab closed, or the user closed it). */
  groupRemoved(groupId: number): Promise<void> {
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
      await this.persist();
    });
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
    const wanted = {
      title: groupTitle(container.name, container.id),
      color: GROUP_COLOR[container.color],
    };

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
      if (force) await this.applyGroup(tab.groupId, wanted).catch(() => {});
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
    await this.applyGroup(groupId, wanted);
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

  /** Sets title and colour, remembering that this update is ours. */
  private async applyGroup(
    groupId: number,
    wanted: { title: string; color: string },
  ): Promise<void> {
    const entry = { ...wanted, at: Date.now() };
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
  private consumeExpected(group: GroupState): boolean {
    const now = Date.now();
    const live = (this.expected.get(group.id) ?? []).filter(
      (e) => now - e.at < EXPECTED_TTL_MS,
    );
    const index = live.findIndex(
      (e) => e.title === (group.title ?? "") && e.color === group.color,
    );
    if (index !== -1) live.splice(index, 1);
    if (live.length > 0) this.expected.set(group.id, live);
    else this.expected.delete(group.id);
    return index !== -1;
  }

  private wantedFor(container: Container): { title: string; color: string } {
    return {
      title: groupTitle(container.name, container.id),
      color: GROUP_COLOR[container.color],
    };
  }

  /** Every group of the container (every window) shows its current name and colour. */
  private async applyToGroups(container: Container): Promise<void> {
    for (const [groupId, containerId] of [...this.owned]) {
      if (containerId !== container.id) continue;
      await this.applyGroup(groupId, this.wantedFor(container)).catch(() =>
        this.forget(groupId),
      );
    }
  }

  /** The group shows the container's current title and colour (it was just taken over; the container is the truth). */
  private async normalise(
    groupId: number,
    group: { title?: string; color: string },
  ): Promise<void> {
    const container = this.deps.container(this.owned.get(groupId) ?? "");
    if (!container) return;
    const wanted = this.wantedFor(container);
    if (group.title !== wanted.title || group.color !== wanted.color)
      await this.applyGroup(groupId, wanted).catch(() => {});
  }

  /**
   * A group of ours was edited in Chrome's menu: the name typed (the title without "⧉ " and the marker) becomes the
   * container's name, the group colour becomes its colour; the container's groups in every window follow. A name that is
   * empty, too long or another container's is refused: the group shows the container's name again, and it is logged. A
   * colour no container has (grey) is refused the same way. Whatever the user deleted from the title (glyph, marker)
   * is put back.
   */
  private async syncEdited(groupId: number): Promise<void> {
    const containerId = this.owned.get(groupId);
    const container =
      containerId === undefined ? undefined : this.deps.container(containerId);
    if (!container || !this.deps.settings().tabGroups) return;
    const group = await this.deps.tabGroups.get(groupId).catch(() => null);
    if (!group) return;

    const patch: { name?: string; color?: ContainerColor } = {};
    const typed = groupNameOf(group.title);
    const others = this.deps
      .containers()
      .filter((c) => c.id !== container.id)
      .map((c) => c.name);
    const check = checkContainerName(typed, others, container.name);
    if (check.ok) {
      if (check.name !== container.name) patch.name = check.name;
    } else {
      this.deps.log(
        "warn",
        "tab group rename refused, the group shows the container’s name again",
        { groupId, container: container.name, typed, reason: check.message },
      );
    }
    const color = containerColorOfGroup(group.color, container.color);
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
