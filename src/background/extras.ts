import { browser } from 'wxt/browser';
import type { ContainerId } from '../core';
import type { StorageAreaLike } from '../engine/storage/storage-area';
import { BadgeIndicator, type ActionApi } from './badges';
import { DomainRuleEngine } from './domain-rule-engine';
import type { FacetEvent } from './events';
import { ExemptionManager } from './exemption-manager';
import type { Facet } from './facet';
import { RuleStore } from './rule-store';
import { SettingsStore } from './settings-store';
import { TabGroupProjection, type TabGroupsLike, type TabsLike } from './tab-groups';

/** Message to the title-prefix content script of a container tab. */
export const RENAMED_MESSAGE = 'facet/renamed';

/**
 * Stage C: everything around the isolation engine that users see: settings, domain rules, tab-group projection and
 * toolbar badges. It listens to `facet.events` and to the extension events registered in `extras-listeners.ts`; the
 * engine itself does not depend on any of it.
 */
export class Extras {
  readonly settings: SettingsStore;
  readonly rules: RuleStore;
  readonly exemptions: ExemptionManager;
  readonly groups: TabGroupProjection;
  readonly badges: BadgeIndicator;
  readonly engine: DomainRuleEngine;
  ready!: Promise<void>;

  constructor(
    readonly facet: Facet,
    private readonly b: typeof browser = browser,
  ) {
    const local = b.storage.local as unknown as StorageAreaLike;
    const session = b.storage.session as unknown as StorageAreaLike;
    this.settings = new SettingsStore(local);
    this.rules = new RuleStore(local, () => new Set(facet.containers.list().map((c) => c.id)));
    this.exemptions = new ExemptionManager(session);
    this.groups = new TabGroupProjection({
      tabs: b.tabs as unknown as TabsLike,
      tabGroups: b.tabGroups as unknown as TabGroupsLike,
      area: session,
      settings: () => this.settings.get(),
      container: (id) => facet.containers.get(id),
      containerTabs: () => facet.tabs.entries().map(([tabId, rec]) => ({ tabId, containerId: rec.containerId })),
      log: facet.log,
    });
    this.badges = new BadgeIndicator(b.action as unknown as ActionApi, {
      containerOf: (tabId) => facet.getTabContainer(tabId),
      container: (id) => facet.containers.get(id),
      ...(__FULL__ ? { bridgeOn: () => this.settings.get().agentBridge } : {}),
      isHeld: (tabId) => facet.restore.isHeld(tabId),
      heldCount: () => facet.restore.heldCount(),
    });
    this.engine = new DomainRuleEngine(this.exemptions, {
      rules: () => this.rules.all(),
      containerOf: (tabId) => facet.getTabContainer(tabId),
      markerContainer: (details) => facet.ctrDecision(details),
      replaceTab: async (tabId, containerId, url, onCreated) => {
        const newTabId = await facet.replaceTab(tabId, containerId, url, onCreated);
        await b.tabs.remove(tabId).catch(() => {});
        return newTabId;
      },
      navigate: async (tabId, url) => {
        // A rule moving a tab: no service worker of the target may answer the repeated navigation.
        if (facet.getTabContainer(tabId) !== null) await facet.prepareNavigation(url);
        await b.tabs.update(tabId, { url });
      },
      chooseUrl: (url, tabId) => `${b.runtime.getURL('/choose.html' as never)}?url=${encodeURIComponent(url)}&tab=${tabId}`,
      log: facet.log,
    });

    facet.events.on((event) => this.onFacetEvent(event));
    this.settings.onChange((next, previous) => {
      void facet.applySettings(next).catch((error) => facet.log('error', 'applying settings failed', String(error)));
      if (next.tabGroups === previous.tabGroups) return;
      void (next.tabGroups ? this.groups.reconcileAll() : this.groups.releaseAll());
    });
  }

  /** Call right after `facet.start()`; resolves once settings, rules and exemptions are loaded. */
  start(facetReady: Promise<void>): Promise<void> {
    this.ready = facetReady.then(async () => {
      await Promise.all([this.settings.load(), this.exemptions.load(), this.groups.load(), this.rules.load()]);
      const tabIds = [...this.facet.tabs.entries().map(([id]) => id), ...this.facet.restore.heldIds()];
      await this.badges.applyGlobal();
      await this.badges.applyMany(tabIds);
      if (__FULL__ && this.settings.get().agentBridge) await this.refreshAllBadges();
    });
    return this.ready;
  }

  /** The agent bridge was switched on or off: every tab's badge says so (or stops saying so). */
  async refreshAllBadges(): Promise<void> {
    await this.badges.applyGlobal();
    const tabs = await this.b.tabs.query({}).catch(() => []);
    await this.badges.applyMany(tabs.map((t) => t.id).filter((id): id is number => id !== undefined));
  }

  private onFacetEvent(event: FacetEvent): void {
    switch (event.type) {
      case 'tab-assigned':
        // Synchronous: this placement exempts the tab's next navigation from domain rules, and that navigation may
        // follow immediately.
        this.exemptions.markPlacement(event.tabId, event.containerId);
        void this.ready.then(() => {
          void this.groups.tabAssigned(event.tabId, event.containerId);
          void this.badges.apply(event.tabId);
        });
        break;
      case 'tab-unassigned':
        void this.ready.then(() => {
          void this.groups.tabUnassigned(event.tabId, event.containerId);
          void this.badges.apply(event.tabId);
        });
        break;
      case 'tab-replaced':
        this.exemptions.move(event.removed, event.added);
        void this.ready.then(() => this.badges.apply(event.added));
        break;
      case 'container-updated':
        void this.ready.then(async () => {
          void this.groups.containerUpdated(event.container);
          const tabIds = this.facet.tabs.tabsOf(event.container.id);
          await this.badges.applyMany(tabIds);
          if (__FULL__ && event.renamed) {
            for (const tabId of tabIds) {
              void this.b.tabs.sendMessage(tabId, { type: RENAMED_MESSAGE, name: event.container.name }).catch(() => {});
            }
          }
        });
        break;
      case 'restore-held':
        // Waiting tabs: their badge, and the hint on the button for every other tab.
        void this.ready.then(async () => {
          await this.badges.applyGlobal();
          await this.badges.applyMany(event.tabIds);
        });
        break;
      case 'container-deleted':
        void this.ready.then(async () => {
          await this.groups.containerDeleted(event.id);
          await this.rules.pruneDeleted();
        });
        break;
    }
  }

  // ---- called from extras-listeners.ts ----

  async handleBeforeNavigate(details: { tabId: number; frameId: number; url: string; documentLifecycle?: string; timeStamp?: number }): Promise<void> {
    if (details.frameId !== 0) return;
    await this.facet.ready;
    await this.ready;
    try {
      await this.engine.handleBeforeNavigate(details);
    } catch (error) {
      this.facet.log('error', 'domain rule failed', String(error));
    }
  }

  handleCreatedNavigationTarget(details: { sourceTabId: number; tabId: number }): void {
    void this.ready.then(() => this.engine.noteChildOfContainerTab(details.tabId, details.sourceTabId));
  }

  /** Re-applies the badge after navigation, which resets tab-specific action state. */
  handleTabRefresh(tabId: number): void {
    void this.ready.then(() =>
      this.facet.getTabContainer(tabId) !== null || (__FULL__ && this.settings.get().agentBridge) || this.facet.restore.isHeld(tabId) ? this.badges.apply(tabId) : undefined,
    );
  }

  handleTabAttached(tabId: number): void {
    void this.ready.then(() => {
      const containerId: ContainerId | null = this.facet.getTabContainer(tabId);
      if (containerId !== null) void this.groups.tabAssigned(tabId, containerId);
    });
  }

  handleTabRemoved(tabId: number): void {
    this.exemptions.forget(tabId);
    this.engine.forgetTab(tabId);
  }
}
