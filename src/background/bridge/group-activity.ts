/** The group a tab sits in (-1: none). */
const NO_GROUP = -1;

export interface GroupActivityDeps {
  /** The tab's group (-1: none); null when the tab is gone. */
  groupOf(tabId: number): Promise<number | null>;
  /** Whether the group stands for a container (an invisible title marker; a plain group never gets a mark). */
  isContainerGroup(groupId: number): Promise<boolean>;
  /** Starts or ends the blinking glyph in the group's title (`TabGroupProjection.setActivity`: idempotent, the colour is never written). */
  setMark(groupId: number, on: boolean): Promise<void>;
}

/**
 * The agent-activity mark of tab groups (Full edition). It owns no clock: `AgentActivity` calls `start` at every action on
 * a tab and `stop` when the tab's toolbar dot stops blinking (the same timer, `BADGE_HOLD_MS` after the last action), or
 * when the display is switched off or the tab is closed. A group is marked from the first active tab in it until the last
 * one is done; a tab that moves between groups meanwhile moves the mark (`groupChanged`). All steps are best effort and
 * never throw: the mark is a decoration.
 */
export class GroupActivityMark {
  /** Tabs the agent is working with, and the group each one counts for (`NO_GROUP`: none, or not a container's). */
  private readonly tabs = new Map<number, number>();

  constructor(private readonly d: GroupActivityDeps) {}

  /** The agent acted on the tab: it counts for its group until `stop`. Repeated calls (a burst of actions) cost nothing. */
  start(tabId: number): void {
    if (this.tabs.has(tabId)) return;
    this.tabs.set(tabId, NO_GROUP); // at once, so a burst resolves the group once
    void this.resolve(tabId);
  }

  /** The tab's activity ended (or the tab is gone): the group is restored when no other tab of it is active. */
  stop(tabId: number): void {
    const group = this.tabs.get(tabId);
    if (group === undefined) return;
    this.tabs.delete(tabId);
    this.release(group);
  }

  /** `tabs.onUpdated` with a `groupId`: an active tab joined, left or changed its group. */
  groupChanged(tabId: number): void {
    if (this.tabs.has(tabId)) void this.resolve(tabId);
  }

  /** Everything off (the setting or the bridge was switched off): every marked group is restored now. */
  async stopAll(): Promise<void> {
    const groups = new Set(this.tabs.values());
    this.tabs.clear();
    await Promise.all([...groups].map((g) => this.setMark(g, false)));
  }

  /** Tabs counted as active (tests). */
  activeTabs(): number[] {
    return [...this.tabs.keys()];
  }

  /** Looks the tab's group up and moves the tab's count there. */
  private async resolve(tabId: number): Promise<void> {
    let group = (await this.d.groupOf(tabId).catch(() => null)) ?? NO_GROUP;
    if (
      group >= 0 &&
      !(await this.d.isContainerGroup(group).catch(() => false))
    )
      group = NO_GROUP;
    const before = this.tabs.get(tabId);
    if (before === undefined) return; // ended meanwhile
    if (before === group) return;
    const shown = group >= 0 && this.counts(group); // another active tab already shows the mark
    this.tabs.set(tabId, group);
    this.release(before);
    if (group >= 0 && !shown) await this.setMark(group, true);
  }

  private counts(group: number): boolean {
    for (const g of this.tabs.values()) if (g === group) return true;
    return false;
  }

  private release(group: number): void {
    if (group < 0 || this.counts(group)) return;
    void this.setMark(group, false);
  }

  private async setMark(group: number, on: boolean): Promise<void> {
    if (group < 0) return;
    await this.d.setMark(group, on).catch(() => {});
  }
}
