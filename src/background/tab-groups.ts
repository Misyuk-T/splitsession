import { decodeGroupMarker, GROUP_COLOR, groupTitle, type Container, type ContainerId, type Settings } from '../core';
import type { StorageAreaLike } from '../engine/storage/storage-area';

/** `chrome.storage.session` key: Chrome tab-group IDs this module created, with the container each one stands for. */
export const OWNED_GROUPS_KEY = 'ownedGroups';

export interface GroupTab {
  id?: number;
  windowId: number;
  groupId: number;
  pinned?: boolean;
}

export interface TabsLike {
  get(tabId: number): Promise<GroupTab>;
  group(options: { tabIds: number[]; groupId?: number; createProperties?: { windowId: number } }): Promise<number>;
  ungroup(tabIds: number[]): Promise<void>;
  query(queryInfo: { groupId?: number }): Promise<GroupTab[]>;
}

export interface TabGroupsLike {
  get(groupId: number): Promise<{ id: number; windowId: number; title?: string; color: string }>;
  update(groupId: number, properties: { title?: string; color?: string }): Promise<unknown>;
}

export interface TabGroupDeps {
  tabs: TabsLike;
  tabGroups: TabGroupsLike;
  area: StorageAreaLike;
  settings(): Settings;
  container(id: ContainerId): Container | undefined;
  /** Every tab currently assigned to a container. */
  containerTabs(): Array<{ tabId: number; containerId: ContainerId }>;
  log(level: 'info' | 'warn' | 'error', message: string, data?: unknown): void;
  /** Retry back-off while the user is dragging a tab (default: real timers). */
  delay?(ms: number): Promise<void>;
}

const RETRIES = 6;
const RETRY_DELAY_MS = 150;

/**
 * Projection of containers onto Chrome tab groups: one group per (window, container), titled with the container's
 * name and coloured like it. The registry (`tabId -> container`) is the truth; groups are only a view, so nothing here
 * ever reads a tab's group to find its container, and a tab the user drags out of a group or into another one keeps
 * its container (and is NOT pulled back: the view is re-applied only when the tab is assigned or moved to another
 * window, when a container is renamed or recoloured, when the setting is switched on, or on "Re-group").
 * Chrome deletes a group when its last tab leaves, which removes empty groups for us.
 * Titles carry an invisible marker with the container ID (`groupTitle`, `core/restore.ts`): a group Chrome brings back
 * (session restore, a saved group opened again) is recognised as this container's and taken over instead of a second
 * group being made, and the restore matcher can tell SplitSession's groups from the user's.
 */
export class TabGroupProjection {
  /** groupId -> container it was made for. */
  private owned = new Map<number, ContainerId>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly delay: (ms: number) => Promise<void>;

  constructor(private readonly deps: TabGroupDeps) {
    this.delay = deps.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async load(): Promise<void> {
    const stored = (await this.deps.area.get(OWNED_GROUPS_KEY))[OWNED_GROUPS_KEY];
    this.owned = new Map();
    if (typeof stored === 'object' && stored !== null) {
      for (const [id, container] of Object.entries(stored)) {
        if (Number.isInteger(Number(id)) && typeof container === 'string') this.owned.set(Number(id), container);
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
      if (tab.groupId >= 0 && this.owned.get(tab.groupId) === containerId) await this.ungroup([tabId]);
    });
  }

  /** Name or colour changed: the groups follow. */
  containerUpdated(container: Container): Promise<void> {
    return this.enqueue(async () => {
      for (const [groupId, containerId] of [...this.owned]) {
        if (containerId !== container.id) continue;
        await this.deps.tabGroups.update(groupId, { title: groupTitle(container.name, container.id), color: GROUP_COLOR[container.color] }).catch(() => this.forget(groupId));
      }
    });
  }

  containerDeleted(id: ContainerId): Promise<void> {
    return this.enqueue(async () => {
      for (const [groupId, containerId] of [...this.owned]) if (containerId === id) this.owned.delete(groupId);
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
      for (const { tabId, containerId } of this.deps.containerTabs()) await this.ensureGrouped(tabId, containerId, true);
    });
  }

  /** Setting switched off: take every tab out of the groups this module made. */
  releaseAll(): Promise<void> {
    return this.enqueue(async () => {
      for (const groupId of [...this.owned.keys()]) {
        const tabs = await this.deps.tabs.query({ groupId }).catch(() => [] as GroupTab[]);
        const ids = tabs.map((t) => t.id).filter((id): id is number => id !== undefined);
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
    const next = this.queue.then(work).catch((error) => {
      this.deps.log('warn', 'tab group update failed', String(error));
    });
    this.queue = next;
    return next;
  }

  private async ensureGrouped(tabId: number, containerId: ContainerId, force = false): Promise<void> {
    if (!this.deps.settings().tabGroups) return;
    const container = this.deps.container(containerId);
    if (!container) return;
    let tab: GroupTab;
    try {
      tab = await this.deps.tabs.get(tabId);
    } catch {
      return; // closed meanwhile
    }
    if (tab.pinned) return; // Chrome cannot group pinned tabs
    const wanted = { title: groupTitle(container.name, container.id), color: GROUP_COLOR[container.color] };

    if (tab.groupId >= 0 && !this.owned.has(tab.groupId)) {
      // A group Chrome brought back with this container's marker (session restore, a saved group opened again).
      const group = await this.deps.tabGroups.get(tab.groupId).catch(() => null);
      if (group && decodeGroupMarker(group.title) === containerId) {
        this.owned.set(tab.groupId, containerId);
        await this.persist();
        force = true;
      }
    }

    if (tab.groupId >= 0 && this.owned.get(tab.groupId) === containerId) {
      if (force) await this.deps.tabGroups.update(tab.groupId, wanted).catch(() => {});
      return; // already where it belongs
    }

    let groupId = await this.groupFor(containerId, tab.windowId);
    if (groupId === null) {
      groupId = await this.retrying(() => this.deps.tabs.group({ tabIds: [tabId], createProperties: { windowId: tab.windowId } }));
      this.owned.set(groupId, containerId);
      await this.persist();
    } else {
      await this.retrying(() => this.deps.tabs.group({ tabIds: [tabId], groupId: groupId! }));
    }
    await this.deps.tabGroups.update(groupId, wanted);
  }

  /** The group this module keeps for the container in that window, if it still exists. */
  private async groupFor(containerId: ContainerId, windowId: number): Promise<number | null> {
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

  private async ungroup(tabIds: number[]): Promise<void> {
    await this.retrying(() => this.deps.tabs.ungroup(tabIds)).catch(() => {});
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
        if (!/cannot be edited|dragging/i.test(String((error as Error)?.message ?? error))) throw error;
        await this.delay(RETRY_DELAY_MS);
      }
    }
    throw last;
  }

  private persist(): Promise<void> {
    return this.deps.area.set({ [OWNED_GROUPS_KEY]: Object.fromEntries(this.owned) }).catch(() => {});
  }
}
