import type { ContainerId } from "../core";

export interface TabReopenerDeps {
  /** Opens `url` in a fresh tab of the container at the old tab's place (`Facet.replaceTab`); resolves with its ID. */
  replaceTab(
    tabId: number,
    containerId: ContainerId,
    url: string,
  ): Promise<number>;
  /** The new tab has joined its group (`TabGroupProjection.idle`). */
  groupsIdle(): Promise<void>;
  /** Closes the old tab (waits for a drag to end). */
  removeTab(tabId: number): Promise<void>;
}

/**
 * Moves a loaded website into a container by reopening it in a fresh tab (new browsing context, no opener) and closing the old
 * tab. Everything that does this goes through here (the group guard, the restore from leftover groups), and the work is
 * **one per original tab**: a second caller for a tab whose move is under way gets that move's result. Two moves of one tab would
 * each create a fresh tab and each close the original, leaving two survivors.
 */
export class TabReopener {
  private readonly inFlight = new Map<number, Promise<number>>();

  constructor(private readonly deps: TabReopenerDeps) {}

  reopen(
    tabId: number,
    containerId: ContainerId,
    url: string,
  ): Promise<number> {
    const running = this.inFlight.get(tabId);
    if (running) return running;
    const work = this.run(tabId, containerId, url).finally(() =>
      this.inFlight.delete(tabId),
    );
    this.inFlight.set(tabId, work);
    return work;
  }

  private async run(
    tabId: number,
    containerId: ContainerId,
    url: string,
  ): Promise<number> {
    const fresh = await this.deps.replaceTab(tabId, containerId, url);
    await this.deps.groupsIdle(); // the new tab joins the group before the old one leaves it
    await this.deps.removeTab(tabId);
    return fresh;
  }
}
