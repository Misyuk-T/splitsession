import type { ContainerId, SavedTab } from "../core";

export interface ReopenResult {
  opened: number;
  failed: number;
}

export interface ReopenStore {
  get(id: ContainerId): SavedTab[];
  /** Removes the first saved entry equal to `tab` (durably). */
  remove(id: ContainerId, tab: SavedTab): Promise<void>;
}

/**
 * Opens a container's saved tabs one after the other. Progress is durable: an entry leaves the stored set only after its
 * tab was created and assigned, so a worker or browser that dies half way leaves the rest saved. Tabs that fail to open
 * simply stay saved. One reopening per container at a time: a second request (double click, two popups) gets the result of
 * the one under way instead of opening the tabs again.
 */
export class SavedTabsReopener {
  private readonly running = new Map<ContainerId, Promise<ReopenResult>>();

  constructor(private readonly store: ReopenStore) {}

  reopen(
    id: ContainerId,
    /** Creates the tab in the container (rejects when it cannot); `first` is true for the first one that opens. */
    open: (tab: SavedTab, first: boolean) => Promise<void>,
  ): Promise<ReopenResult> {
    const running = this.running.get(id);
    if (running) return running;
    const work = this.run(id, open).finally(() => {
      if (this.running.get(id) === work) this.running.delete(id);
    });
    this.running.set(id, work);
    return work;
  }

  private async run(
    id: ContainerId,
    open: (tab: SavedTab, first: boolean) => Promise<void>,
  ): Promise<ReopenResult> {
    let opened = 0;
    let failed = 0;
    let lastError: unknown;
    for (const tab of this.store.get(id)) {
      try {
        await open(tab, opened === 0);
      } catch (error) {
        lastError = error;
        failed++;
        continue;
      }
      opened++;
      await this.store.remove(id, tab);
    }
    if (opened === 0 && lastError !== undefined)
      throw lastError instanceof Error
        ? lastError
        : new Error(String(lastError));
    return { opened, failed };
  }
}
