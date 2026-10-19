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
  tabsOf(groupId: number): Promise<RestoreTab[]>;
  createContainer(input: {
    id: ContainerId;
    name: string;
    color: ContainerColor;
  }): Promise<unknown>;
  /** Puts the tab into the container; `reload`: and loads it again (the container's isolation then applies to the page). */
  assign(tabId: number, id: ContainerId, reload: boolean): Promise<void>;
  /** The groups take over the new containers (their titles are put in the containers' form). */
  adopt(): Promise<void>;
  log(level: "info" | "warn" | "error", message: string, data?: unknown): void;
}

/**
 * A reinstall wipes `chrome.storage` (containers, cookie jars) but Chrome keeps the tab groups, and with them the title
 * marker of the container each stands for (docs/decisions.md, "Restoring containers from leftover groups"). When there are
 * no containers and such groups exist, the popup offers to bring the containers back: same ID (the marker names it, so the
 * group is already the container's group and nothing is retitled or regrouped), the name and colour of the group, and the
 * group's tabs assigned to it. Cookies are gone for good, so the logins have to be done again.
 *
 * A tab that has loaded nothing (not a website, not loaded by Chrome, discarded) is assigned where it stands, as the group
 * guard does; a loaded website is assigned and reloaded: its page holds a state of the old session and its next request
 * must go through the container's (empty) jar, which is what "Reopen in…" in the popup does too.
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
      for (const groupId of entry.groupIds) {
        for (const tab of await this.deps.tabsOf(groupId).catch(() => [])) {
          if (tab.id === undefined) continue;
          const loaded =
            isHttpUrl(tab.pendingUrl || tab.url) &&
            tab.status !== "unloaded" &&
            tab.discarded !== true;
          try {
            await this.deps.assign(tab.id, entry.id, loaded);
            result.tabs++;
          } catch (error) {
            result.failed++;
            this.deps.log(
              "warn",
              `restore from groups: tab ${tab.id} could not be put into “${entry.name}”`,
              String(error),
            );
          }
        }
      }
    }
    if (result.containers === 0) throw failure;
    await this.deps.adopt();
    await this.dismiss(); // the groups are the containers' now: nothing is left to offer
    this.deps.log("info", "containers restored from tab groups", {
      ...result,
      restored: plan.map((c) => ({ id: c.id, name: c.name })),
    });
    return result;
  }
}
