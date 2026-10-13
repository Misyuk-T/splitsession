import type { ContainerId } from "../../core";
import { networkOrigin } from "../../engine/capture/headers";
import type { ContentScriptLifecycle } from "../../engine/content-scripts";
import type { SessionRuleManager } from "../../engine/dnr/session-rules";
import { ContainerError } from "../../engine/storage/container-store";
import type { ServiceWorkerPolicy } from "../../engine/sw-policy";
import type { FacetEvents } from "../events";
import { RESTORE_KEY, type TabRestore } from "../restore";
import type { EngineCore } from "./types";
import { siteOfHttp } from "./urls";

export interface AssignmentsDeps extends EngineCore {
  rules: SessionRuleManager;
  scripts: ContentScriptLifecycle;
  restore: TabRestore;
  swPolicy: ServiceWorkerPolicy;
  events: FacetEvents;
}

/**
 * Puts tabs into containers and takes them out. One assignment per tab at a time: a second one to the same container
 * joins the first, one to another container runs after it.
 */
export class Assignments {
  /** Assignments under way, per tab. */
  private readonly running = new Map<
    number,
    { containerId: ContainerId; work: Promise<number> }
  >();

  constructor(private readonly d: AssignmentsDeps) {}

  /** The assignment of this tab under way, if any. */
  current(tabId: number): Promise<number> | undefined {
    return this.running.get(tabId)?.work;
  }

  isRunning(tabId: number): boolean {
    return this.running.has(tabId);
  }

  /** Returns the time the rules became active. Throws (and leaves the tab unassigned) if they could not be installed. */
  assign(tabId: number, containerId: ContainerId): Promise<number> {
    const running = this.running.get(tabId);
    if (running && running.containerId === containerId) return running.work;
    const work = (
      running ? running.work.catch(() => 0) : Promise.resolve(0)
    ).then(() => this.assignNow(tabId, containerId));
    const entry = { containerId, work };
    this.running.set(tabId, entry);
    const done = () => {
      if (this.running.get(tabId) === entry) this.running.delete(tabId);
    };
    work.then(done, done);
    return work;
  }

  private async assignNow(
    tabId: number,
    containerId: ContainerId,
  ): Promise<number> {
    if (!Number.isInteger(tabId) || tabId < 0)
      throw new ContainerError(`invalid tab id ${tabId}`);
    if (!this.d.containers.get(containerId))
      throw new ContainerError(`no container "${containerId}"`);
    // Every way into a container passes here before the tab navigates or reloads: the content scripts must be
    // registered for every frame first, or the tab's first document would run without them.
    const release = this.d.scripts.hold();
    try {
      await this.d.scripts.ensure();
      return await this.assignRegistered(tabId, containerId);
    } finally {
      release();
    }
  }

  private async assignRegistered(
    tabId: number,
    containerId: ContainerId,
  ): Promise<number> {
    const { tabs, rules } = this.d;
    const tab = await this.d.b.tabs.get(tabId);
    const prev = tabs.get(tabId);
    if (prev?.containerId === containerId && prev.activeSince !== null)
      return prev.activeSince;
    const write = tabs.set(tabId, {
      containerId,
      topLevelSite: siteOfHttp(tab.url ?? tab.pendingUrl),
      activeSince: null,
      windowId: tab.windowId,
      url: tab.url,
    });
    const keys =
      prev && prev.containerId !== containerId
        ? [containerId, prev.containerId]
        : [containerId];
    // A container tab is always known to the restore gate; opened in the same batch as its cookie rules.
    if (this.d.restore.clearSync(tabId)) keys.push(RESTORE_KEY);
    const ok = await rules.invalidate(...keys);
    if (!ok || !rules.isInstalled(containerId)) {
      await tabs.delete(tabId);
      await rules.invalidate(...keys);
      throw new ContainerError(
        "could not install the container rules (declarativeNetRequest limit?)",
      );
    }
    const activeAt = Date.now();
    await write;
    await tabs.update(tabId, { activeSince: activeAt });
    const origin = networkOrigin(tab.url ?? tab.pendingUrl);
    if (origin) void this.d.swPolicy.noteContainerOrigin(origin);
    this.d.log("info", `tab ${tabId} -> ${containerId}`);
    this.d.events.emit({ type: "tab-assigned", tabId, containerId });
    this.d.restore.afterAssign(tabId);
    return activeAt;
  }

  async unassign(tabId: number): Promise<void> {
    const rec = this.d.tabs.get(tabId);
    if (!rec) return;
    await this.d.tabs.delete(tabId);
    await this.d.rules.invalidate(rec.containerId);
    this.d.log("info", `tab ${tabId} left ${rec.containerId}`);
    this.d.events.emit({
      type: "tab-unassigned",
      tabId,
      containerId: rec.containerId,
    });
  }
}
