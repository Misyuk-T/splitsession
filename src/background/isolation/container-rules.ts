import {
  type CompiledRules,
  compileGroupRules,
  compileNoTabRule,
  compileNoTabWorkerScriptRule,
  type ContainerId,
  type DnrRule,
  type RuleIdAllocator,
  type Settings,
} from "../../core";
import type { SessionRuleManager } from "../../engine/dnr/session-rules";
import type { ContainerStore } from "../../engine/storage/container-store";
import type { TabRecord, TabRegistry } from "../../engine/storage/tab-registry";
import type { ServiceWorkerPolicy } from "../../engine/sw-policy";
import { RESTORE_KEY, type TabRestore } from "../restore";
import { siteOfFrameUrl, siteOfHttp } from "./urls";

/** Session-rule key of the rules for requests outside tabs (container IDs are [a-z0-9]{10}). */
export const NO_TAB_KEY = "@no-tab";
/** Frame sites remembered per tab for per-site beacon answers. */
const MAX_FRAME_SITES_PER_TAB = 64;

export interface ContainerRulesDeps {
  tabs: TabRegistry;
  containers: ContainerStore;
  swPolicy: ServiceWorkerPolicy;
  restore: TabRestore;
  /** Late-bound: the rule manager is built with `compile` as its compiler. */
  rules(): SessionRuleManager;
  settings(): Settings;
  /** Page key of (container, site): HMAC with the per-install secret. */
  pageKeyOf(containerId: ContainerId, site: string): string;
}

const asCompiled = (addRules: DnrRule[]): CompiledRules | null =>
  addRules.length > 0
    ? { addRules, ruleIds: addRules.map((r) => r.id), regexRuleCount: 0 }
    : null;

/**
 * What each session-rule key compiles to (containers, requests outside tabs, the restore gate's openers), and the
 * frame sites of container tabs that the containers' beacon answers must cover.
 */
export class ContainerRules {
  /** Per container tab: sites of the frames it requested since its last top-level navigation (beacon answers). */
  private readonly frameSites = new Map<number, Set<string>>();

  constructor(private readonly d: ContainerRulesDeps) {}

  /** The `SessionRuleManager` compiler. */
  compile(
    key: ContainerId,
    allocator: RuleIdAllocator,
    regexBudget: number,
  ): CompiledRules | null {
    if (key === RESTORE_KEY) return this.d.restore.compile(allocator);
    if (key === NO_TAB_KEY) return this.compileNoTab(allocator);
    return this.compileContainer(key, allocator, regexBudget);
  }

  private compileNoTab(allocator: RuleIdAllocator): CompiledRules | null {
    const addRules: DnrRule[] = [];
    const cookies = this.d.settings().strictMode
      ? compileNoTabRule(allocator.next(), this.d.swPolicy.sites())
      : null;
    if (cookies) addRules.push(cookies);
    // Worker scripts outside tabs: blocked on every site in strict mode only. Outside it the shim refuses service
    // workers on the sites containers use, and a network block would also break shared workers' imports there.
    const workers = this.d.swPolicy.guarded
      ? compileNoTabWorkerScriptRule(allocator.next())
      : null;
    if (workers) addRules.push(workers);
    return asCompiled(addRules);
  }

  private compileContainer(
    containerId: ContainerId,
    allocator: RuleIdAllocator,
    regexBudget: number,
  ): CompiledRules | null {
    const { tabs } = this.d;
    const container = this.d.containers.get(containerId);
    const tabIds = tabs.tabsOf(containerId);
    if (!container || tabIds.length === 0) return null;
    const jar = this.d.containers.jar(containerId);
    const now = Date.now();
    // Partitioned cookies depend on the top-level site: then tabs are grouped by site, otherwise one group.
    const partitioned = jar.all().some((c) => c.partitioned);
    const groups = new Map<string | null, number[]>();
    for (const tabId of tabIds) {
      const site = partitioned ? (tabs.get(tabId)?.topLevelSite ?? null) : null;
      const list = groups.get(site);
      if (list) list.push(tabId);
      else groups.set(site, [tabId]);
    }
    const addRules: DnrRule[] = [];
    const ruleIds: number[] = [];
    let regexRuleCount = 0;
    const pageKeyOf = (site: string) => this.d.pageKeyOf(containerId, site);
    for (const [site, group] of groups) {
      const frameSites = new Set<string>();
      for (const tabId of group) {
        const own = siteOfFrameUrl(tabs.get(tabId)?.url);
        if (own) frameSites.add(own);
        for (const s of this.frameSites.get(tabId) ?? []) frameSites.add(s);
      }
      const compiled = compileGroupRules(
        {
          tabIds: group.sort((a, b) => a - b),
          containerId,
          // Pages see the name only when the user allows it (setting "Show container name to pages"; Full edition only).
          containerName:
            __FULL__ && this.d.settings().showNameToPages
              ? container.name
              : undefined,
          jar,
          topLevelSite: site,
          now,
          regexBudget: Math.max(0, regexBudget - regexRuleCount),
          pageKeyOf,
          frameSites,
        },
        allocator,
      );
      addRules.push(...compiled.addRules);
      ruleIds.push(...compiled.ruleIds);
      regexRuleCount += compiled.regexRuleCount;
    }
    return { addRules, ruleIds, regexRuleCount };
  }

  /**
   * Adds a frame site to a container tab; resolves once the container's beacon answers cover it. `force`: a frame
   * reported the answer missing, recompile even if the site looks covered.
   */
  addFrameSite(
    tabId: number,
    containerId: ContainerId,
    site: string,
    topLevel = false,
    force = false,
  ): Promise<boolean> {
    const { tabs } = this.d;
    const rules = this.d.rules();
    // Already covered by the installed rules (some tab of the container is on that site)?
    const known = tabs
      .tabsOf(containerId)
      .some(
        (t) =>
          this.frameSites.get(t)?.has(site) ||
          siteOfFrameUrl(tabs.get(t)?.url) === site,
      );
    // A new top-level navigation starts the tab's list afresh (sites dropped here leave the rules at the next recompile).
    const set = topLevel
      ? new Set<string>()
      : (this.frameSites.get(tabId) ?? new Set<string>());
    this.frameSites.set(tabId, set);
    set.add(site);
    if (set.size > MAX_FRAME_SITES_PER_TAB)
      set.delete(set.values().next().value!);
    if (known && !force && rules.isInstalled(containerId)) return rules.sync();
    return rules.invalidate(containerId);
  }

  /**
   * A container tab's top frame committed `url`: its top-level site follows, and so do the rules when partitioned
   * cookies (which depend on it) are in the jar.
   */
  async topLevelCommitted(
    tabId: number,
    rec: TabRecord,
    url: string,
  ): Promise<void> {
    const site = siteOfHttp(url);
    if (site === rec.topLevelSite) {
      if (rec.url !== url) void this.d.tabs.update(tabId, { url });
      return;
    }
    await this.d.tabs.update(tabId, { topLevelSite: site, url });
    if (
      this.d.containers
        .jar(rec.containerId)
        .all()
        .some((c) => c.partitioned)
    )
      await this.d.rules().invalidate(rec.containerId);
  }

  forgetTab(tabId: number): void {
    this.frameSites.delete(tabId);
  }
}
