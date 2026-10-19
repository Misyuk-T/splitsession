import {
  type ContainerId,
  MAX_SAVED_TABS,
  normalizeSavedTabs,
  SAVED_TABS_KEY,
  type SavedTab,
} from "../../core";
import type { StorageAreaLike } from "./storage-area";

/**
 * The saved tabs of each container (`savedTabs` key in `chrome.storage.local`: `{ [containerId]: SavedTab[] }`): the
 * addresses and titles its last batch of closed tabs had. Memory is the source of truth while the worker lives; every
 * change is written in order. A container with no saved tabs has no entry.
 */
export class SavedTabsStore {
  private sets = new Map<ContainerId, SavedTab[]>();
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly area: StorageAreaLike) {}

  /** Reads storage; sets of containers that are gone (`known` says which exist) are dropped. */
  async load(known: (id: ContainerId) => boolean): Promise<void> {
    const raw = (await this.area.get(SAVED_TABS_KEY))[SAVED_TABS_KEY];
    this.sets = new Map();
    let pruned = false;
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      for (const [id, list] of Object.entries(raw)) {
        const tabs = normalizeSavedTabs(list);
        if (known(id) && tabs.length > 0) this.sets.set(id, tabs);
        else pruned = true;
      }
    }
    if (pruned) await this.persist();
  }

  get(id: ContainerId): SavedTab[] {
    return (this.sets.get(id) ?? []).map((t) => ({ ...t }));
  }

  count(id: ContainerId): number {
    return this.sets.get(id)?.length ?? 0;
  }

  /** Replaces the set (at most `MAX_SAVED_TABS` savable tabs); an empty one removes it. */
  set(id: ContainerId, tabs: readonly SavedTab[]): Promise<void> {
    const clean = normalizeSavedTabs(tabs).slice(0, MAX_SAVED_TABS);
    if (clean.length === 0) this.sets.delete(id);
    else this.sets.set(id, clean);
    return this.persist();
  }

  /** Forgets the set; returns how many tabs it held. */
  async clear(id: ContainerId): Promise<number> {
    const had = this.count(id);
    if (!this.sets.delete(id)) return 0;
    await this.persist();
    return had;
  }

  async clearAll(): Promise<void> {
    if (this.sets.size === 0) return;
    this.sets.clear();
    await this.persist();
  }

  private persist(): Promise<void> {
    const snapshot = Object.fromEntries(
      [...this.sets].map(([id, tabs]) => [id, tabs.map((t) => ({ ...t }))]),
    );
    this.writing = this.writing
      .then(() =>
        Object.keys(snapshot).length === 0
          ? this.area.remove(SAVED_TABS_KEY)
          : this.area.set({ [SAVED_TABS_KEY]: snapshot }),
      )
      .catch(() => {});
    return this.writing;
  }
}
