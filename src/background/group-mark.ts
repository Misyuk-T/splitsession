import type { ContainerId } from "../core";

/** Message to (and question from) the top frame of a container tab: is it outside its container's tab group? */
export const OUTSIDE_GROUP_MESSAGE = "facet/outside-group";

export interface GroupMarkDeps {
  /** The container the tab is in (null: an ordinary tab). */
  containerOf(tabId: number): ContainerId | null;
  /** The tab's group (-1: none); null when the tab is gone. */
  groupOf(tabId: number): Promise<number | null>;
  /** The container a group stands for (`TabGroupProjection.containerOfGroup`). */
  groupContainer(groupId: number): Promise<ContainerId | null>;
  /** SplitSession keeps container groups (the `tabGroups` setting). */
  groupsOn(): boolean;
  /** Waits for the group changes queued so far, so a tab just assigned is not reported as outside while it is on its way in. */
  groupsIdle(): Promise<void>;
  /** Top frame of the tab; the content script may be absent (page not loaded, no access): that is fine. */
  send(
    tabId: number,
    message: { type: string; outside: boolean },
  ): Promise<void>;
}

/**
 * Tells the content script of a container tab whether the tab sits outside its container's tab group (it then puts
 * "⧉ " in front of the title, `src/content/group-mark.ts`). Outside = in a container and not in a group that stands for
 * that same container; with the `tabGroups` setting off, every container tab. Whether the user wants the mark is the
 * content script's business (the `markOutsideGroup` setting), so toggling it needs nothing from here. A tab that
 * is not (or no longer) in a container is told "not outside" once, to take a mark off a page that outlived the container.
 */
export class GroupMark {
  /** Tabs told "outside" and not yet told otherwise (a tab that left its container must be told to drop the mark). */
  private readonly told = new Set<number>();

  constructor(private readonly deps: GroupMarkDeps) {}

  /** The state now, once pending group changes have been applied. */
  async isOutside(tabId: number): Promise<boolean> {
    await this.deps.groupsIdle();
    return this.outsideNow(tabId);
  }

  /** Re-evaluates one tab and tells its page when it is (or was) outside. `leftContainer`: send even if never told. */
  async refresh(tabId: number, leftContainer = false): Promise<void> {
    if (
      this.deps.containerOf(tabId) === null &&
      !leftContainer &&
      !this.told.has(tabId)
    )
      return; // an ordinary tab, never marked
    await this.deps.groupsIdle();
    const outside = await this.outsideNow(tabId);
    if (outside) this.told.add(tabId);
    else this.told.delete(tabId);
    await this.deps.send(tabId, { type: OUTSIDE_GROUP_MESSAGE, outside });
  }

  refreshMany(tabIds: Iterable<number>): Promise<void> {
    return Promise.all([...tabIds].map((id) => this.refresh(id))).then(
      () => undefined,
    );
  }

  forget(tabId: number): void {
    this.told.delete(tabId);
  }

  private async outsideNow(tabId: number): Promise<boolean> {
    const container = this.deps.containerOf(tabId);
    if (container === null) return false;
    if (!this.deps.groupsOn()) return true;
    const group = await this.deps.groupOf(tabId);
    if (group === null) return false; // closed meanwhile
    if (group < 0) return true;
    return (await this.deps.groupContainer(group)) !== container;
  }
}
