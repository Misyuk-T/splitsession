import {
  type ContainerColor,
  type ContainerId,
  GROUP_RESTORE_DISMISSED_KEY,
  type GroupRestoreOffer,
  groupRestorePlan,
  type GroupRestoreResult,
  type GroupSnapshot,
  isHttpUrl,
  type RestorableContainer,
} from "../core";
import type { StorageAreaLike } from "../engine/storage/storage-area";

/** A tab of a leftover group, as far as the restore needs to know it. */
export interface RestoreTab {
  id?: number;
  groupId?: number;
  url?: string;
  pendingUrl?: string;
  /** 'unloaded': Chrome has not loaded the tab (restored lazily). */
  status?: string;
  discarded?: boolean;
}

export interface GroupRestoreDeps {
  /** `chrome.storage.local`: holds the "no thanks" flag. */
  area: StorageAreaLike;
  containerCount(): number;
  groups(): Promise<GroupSnapshot[]>;
  /** The tabs in the group now (the list the restore walks; each tab is read again before it is handled). */
  tabsOf(groupId: number): Promise<RestoreTab[]>;
  /** The tab as it is now (`tabs.get`); null when it is gone. */
  tab(tabId: number): Promise<RestoreTab | null>;
  createContainer(input: {
    id: ContainerId;
    name: string;
    color: ContainerColor;
  }): Promise<unknown>;
  /** Puts a tab that has loaded nothing into the container where it stands (`Facet.assignInPlace`). */
  assignInPlace(tabId: number, id: ContainerId): Promise<void>;
  /**
   * Moves a loaded website into the container in a fresh tab at its place and closes the old one (`Extras.reopenInContainer`).
   * Resolves with the new tab's ID.
   */
  reopen(tabId: number, id: ContainerId, url: string): Promise<number>;
  /** The groups take over the new containers: a tab put into the group then joins it instead of making a second group. */
  adopt(): Promise<void>;
  log(level: "info" | "warn" | "error", message: string, data?: unknown): void;
}

/** The address of a tab that has a website loaded (or loading) in it: http(s), loaded by Chrome, not discarded; else null. */
function websiteOf(tab: RestoreTab): string | null {
  const address = isHttpUrl(tab.pendingUrl)
    ? tab.pendingUrl
    : isHttpUrl(tab.url)
      ? tab.url
      : null;
  return address !== null && tab.status !== "unloaded" && tab.discarded !== true
    ? address
    : null;
}

/**
 * A reinstall wipes `chrome.storage` (containers, cookie jars) but Chrome keeps the tab groups, and with them the title
 * marker of the container each stands for (docs/decisions.md, "Restoring containers from leftover groups"). When there are
 * no containers and such groups exist, the popup offers to bring the containers back: same ID (the marker names it, so the
 * group is already the container's group and nothing is retitled or regrouped), the name and colour of the group, and the
 * group's tabs assigned to it. Cookies are gone for good, so the logins have to be done again.
 *
 * What happens to a tab follows the group guard: a loaded website (http(s), Chrome has loaded it, not discarded) is reopened in a
 * fresh tab of the container at its place and the old tab closed (`reopen`). Reloading the old one would keep its browsing
 * context, so a window that holds a reference to it (`window.opener` of a popup it opened) could still reach the container's
 * page and storage. The new tab joins the group that is already there (the groups are adopted first), so no group is created.
 * A tab that has loaded nothing (not a website, not loaded by Chrome, discarded) has no live document that anything can hold
 * a reference to: it is assigned where it stands and keeps its ID, and what it loads later is already the container's.
 */
export class GroupRestore {
  private running: Promise<GroupRestoreResult> | null = null;

  constructor(private readonly deps: GroupRestoreDeps) {}

  private async dismissed(): Promise<boolean> {
    const stored = await this.deps.area.get(GROUP_RESTORE_DISMISSED_KEY);
    return stored[GROUP_RESTORE_DISMISSED_KEY] === true;
  }

  private async plan(): Promise<RestorableContainer[]> {
    return groupRestorePlan({
      containerCount: this.deps.containerCount(),
      dismissed: await this.dismissed(),
      groups: await this.deps.groups().catch(() => []),
    });
  }

  /** What the popup offers; null when nothing (containers exist, said no, or no leftover group). */
  async offer(): Promise<GroupRestoreOffer | null> {
    const plan = await this.plan();
    if (plan.length === 0) return null;
    return {
      containers: plan.length,
      groups: plan.reduce((n, c) => n + c.groupIds.length, 0),
    };
  }

  /** The user said no: not offered again in this install. */
  async dismiss(): Promise<void> {
    await this.deps.area.set({ [GROUP_RESTORE_DISMISSED_KEY]: true });
  }

  /** Creates the containers and assigns the groups' tabs. Throws when there is nothing to restore. */
  restore(): Promise<GroupRestoreResult> {
    this.running ??= this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /**
   * One tab of a group, judged by its state NOW, not by the list taken earlier (the restore awaits every tab in turn, and a tab
   * may have loaded, moved to another group or closed meanwhile). False: left alone (gone, or no longer in this group: the
   * group guard decides about it).
   * - A loaded website is reopened in a fresh tab (`reopen`).
   * - A tab that loaded nothing is assigned where it stands, then read once more: a navigation that began before the
   *   container's rules were active shows as a changed state (a website that is loading or loaded, no longer unloaded or
   *   discarded), and such a tab holds a live plain document, so it is reopened as well. A navigation that begins after the
   *   assignment is the container's own.
   */
  private async handleTab(
    tabId: number,
    groupId: number,
    containerId: ContainerId,
  ): Promise<boolean> {
    const now = await this.deps.tab(tabId);
    if (now === null || now.groupId !== groupId) return false;
    const address = websiteOf(now);
    if (address !== null) {
      await this.deps.reopen(tabId, containerId, address);
      return true;
    }
    await this.deps.assignInPlace(tabId, containerId);
    const after = await this.deps.tab(tabId);
    const loadedMeanwhile = after === null ? null : websiteOf(after);
    if (loadedMeanwhile !== null) {
      this.deps.log(
        "info",
        `restore from groups: tab ${tabId} started loading while it was assigned, reopened in the container`,
      );
      await this.deps.reopen(tabId, containerId, loadedMeanwhile);
    }
    return true;
  }

  private async run(): Promise<GroupRestoreResult> {
    const plan = await this.plan();
    if (plan.length === 0)
      throw new Error("there are no tab groups to restore containers from");
    const result: GroupRestoreResult = { containers: 0, tabs: 0, failed: 0 };
    let failure: unknown = null;
    for (const entry of plan) {
      try {
        await this.deps.createContainer({
          id: entry.id,
          name: entry.name,
          color: entry.color,
        });
      } catch (error) {
        failure = error;
        this.deps.log(
          "warn",
          `restore from groups: “${entry.name}” could not be created`,
          String(error),
        );
        continue;
      }
      result.containers++;
      await this.deps.adopt();
      for (const groupId of entry.groupIds) {
        for (const listed of await this.deps.tabsOf(groupId).catch(() => [])) {
          if (listed.id === undefined) continue;
          const tabId = listed.id;
          try {
            const done = await this.handleTab(tabId, groupId, entry.id);
            if (done) result.tabs++;
          } catch (error) {
            result.failed++;
            this.deps.log(
              "warn",
              `restore from groups: tab ${tabId} could not be put into “${entry.name}”`,
              String(error),
            );
          }
        }
      }
    }
    if (result.containers === 0) throw failure;
    await this.dismiss(); // the groups are the containers' now: nothing is left to offer
    this.deps.log("info", "containers restored from tab groups", {
      ...result,
      restored: plan.map((c) => ({ id: c.id, name: c.name })),
    });
    return result;
  }
}
