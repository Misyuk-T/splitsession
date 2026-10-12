import type { ContainerId } from '../core';

export interface DragInTab {
  url?: string;
  pendingUrl?: string;
  groupId: number;
}

export interface DragInDeps {
  getTab(tabId: number): Promise<DragInTab | null>;
  /** The container a tab group stands for (its invisible title marker), or null for any other group. */
  groupContainer(groupId: number): Promise<ContainerId | null>;
  containerOf(tabId: number): ContainerId | null;
  /** SplitSession is still assigning the tab, or Chrome restored it and the restore has not decided yet. */
  isSettling(tabId: number): boolean;
  containerName(id: ContainerId): string | undefined;
  /**
   * Opens `url` in a fresh tab of the container at the old tab's place (`Facet.replaceTab`) and closes the old tab.
   * Throws when nothing was created. Resolves with the new tab's ID.
   */
  move(tabId: number, containerId: ContainerId, url: string): Promise<number>;
  moved(newTabId: number, containerId: ContainerId, name: string): void;
  log(level: 'info' | 'warn' | 'error', message: string, data?: unknown): void;
  delay?(ms: number): Promise<void>;
  now?(): number;
}

/** A tab younger than this is not "dragged": Chrome puts a new tab into its opener's group, SplitSession creates tabs too. */
export const YOUNG_TAB_MS = 1_000;
/** Wait after the group change before acting: the user may still be dragging, and the restore may be about to decide. */
export const SETTLE_MS = 300;
const RETRY_MS = 250;
/** Chrome refuses tab edits while the user holds a dragged tab: about this long (20 s) we keep waiting for the drop. */
const MAX_ATTEMPTS = 80;
const RATE_WINDOW_MS = 10_000;
const RATE_LIMIT = 10;

const isHttp = (url: string | undefined): url is string => !!url && /^https?:\/\//i.test(url);
const dragRefusal = (error: unknown): boolean => /cannot be edited|dragging/i.test(String((error as Error)?.message ?? error));

/**
 * A tab the user drags INTO a tab group that carries a container's marker is reopened in that container
 * (docs/decisions.md, "Dragging a tab into a group"): the group looks like the container, and a tab that is not in it
 * would be logged in as someone else under the container's name.
 *
 * Only the user's own drags count. What SplitSession itself groups is already in the container the group stands for
 * (the comparison below sees nothing to do), tabs younger than `YOUNG_TAB_MS`, tabs it is assigning or the restore
 * has not decided, and pages that are not websites (chrome://, extension pages, the blank page a popup child starts
 * with) are left alone. Leaving a group, or joining a group that is not SplitSession's, never changes anything.
 */
export class GroupDragIn {
  private readonly created = new Map<number, number>();
  private readonly moving = new Set<number>();
  private readonly recent: number[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private readonly delay: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly deps: DragInDeps) {
    this.delay = deps.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = deps.now ?? Date.now;
  }

  tabCreated(tabId: number): void {
    const now = this.now();
    this.created.set(tabId, now);
    for (const [id, at] of this.created) if (now - at > 10 * YOUNG_TAB_MS) this.created.delete(id);
  }

  /** `tabs.onUpdated` reported a new `groupId` for the tab. Resolves when this change has been dealt with. */
  groupChanged(tabId: number, groupId: number): Promise<void> {
    if (groupId < 0) return Promise.resolve(); // out of a group: the tab keeps its container
    const next = this.queue.then(() => this.handle(tabId, groupId)).catch((error) => this.deps.log('warn', 'drag into a group failed', String(error)));
    this.queue = next;
    return next;
  }

  private async handle(tabId: number, groupId: number): Promise<void> {
    if (this.moving.has(tabId)) return;
    const born = this.created.get(tabId);
    if (born !== undefined && this.now() - born < YOUNG_TAB_MS) return;
    await this.delay(SETTLE_MS);
    let counted = false;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const plan = await this.plan(tabId, groupId);
      if (!plan) return;
      if (!counted) {
        if (!this.allow()) {
          this.deps.log('warn', `tab ${tabId}: too many moves into groups, leaving it alone`);
          return;
        }
        counted = true;
      }
      this.moving.add(tabId);
      try {
        const name = this.deps.containerName(plan.target) ?? '';
        this.deps.log('info', `tab ${tabId} dragged into the group of ${plan.target}: reopening it there`);
        const fresh = await this.deps.move(tabId, plan.target, plan.url);
        this.deps.moved(fresh, plan.target, name);
        return;
      } catch (error) {
        if (!dragRefusal(error)) {
          this.deps.log('warn', `tab ${tabId} could not be moved into its group's container`, String(error));
          return;
        }
        await this.delay(RETRY_MS); // still being dragged: look again, the drop may put it somewhere else
      } finally {
        this.moving.delete(tabId);
      }
    }
  }

  /** What to do now, from the live state; null when nothing (any more). */
  private async plan(tabId: number, groupId: number): Promise<{ target: ContainerId; url: string } | null> {
    if (this.deps.isSettling(tabId)) return null;
    const target = await this.deps.groupContainer(groupId);
    if (target === null) return null;
    const tab = await this.deps.getTab(tabId);
    if (!tab || tab.groupId !== groupId) return null; // closed, or dropped somewhere else meanwhile (that change has its own event)
    if (this.deps.containerOf(tabId) === target) return null;
    const url = isHttp(tab.url) ? tab.url : !tab.url ? tab.pendingUrl : undefined;
    return isHttp(url) ? { target, url } : null;
  }

  private allow(): boolean {
    const now = this.now();
    while (this.recent.length > 0 && now - this.recent[0]! > RATE_WINDOW_MS) this.recent.shift();
    if (this.recent.length >= RATE_LIMIT) return false;
    this.recent.push(now);
    return true;
  }
}
