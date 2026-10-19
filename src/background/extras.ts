import { browser } from "wxt/browser";

import { type ContainerId, ruleKeyOf } from "../core";
import type { StorageAreaLike } from "../engine/storage/storage-area";
import { type ActionApi, BadgeIndicator } from "./badges";
import { DomainRuleEngine } from "./domain-rule-engine";
import type { FacetEvent } from "./events";
import { ExemptionManager } from "./exemption-manager";
import type { Facet } from "./facet";
import { GroupGuard, type GuardTab } from "./group-guard";
import { GroupMark, OUTSIDE_GROUP_MESSAGE } from "./group-mark";
import { RuleStore } from "./rule-store";
import { SavedTabsRecorder, type SeenTab } from "./saved-tabs-recorder";
import { SettingsStore } from "./settings-store";
import {
  TabGroupProjection,
  type TabGroupsLike,
  type TabsLike,
} from "./tab-groups";
import { TabReopener } from "./tab-reopener";

/** Message to the title-prefix content script of a container tab. */
export const RENAMED_MESSAGE = "facet/renamed";
/** Alarm of the group guard's periodic sweep (exists while some tab group stands for a container). */
export const GROUP_SWEEP_ALARM = "splitsession-group-sweep";
/** The sweep after the worker starts waits this long, so the tabs Chrome restores and the restore's decisions come first. */
const START_SWEEP_DELAY_MS = 1_500;

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
  readonly guard: GroupGuard;
  readonly mark: GroupMark;
  /** Remembers a container's tabs when its last tab closes (`saved-tabs-recorder.ts`). */
  readonly saved: SavedTabsRecorder;
  private readonly reopener: TabReopener;
  ready!: Promise<void>;

  constructor(
    readonly facet: Facet,
    private readonly b: typeof browser = browser,
  ) {
    const local = b.storage.local as unknown as StorageAreaLike;
    const session = b.storage.session as unknown as StorageAreaLike;
    this.settings = new SettingsStore(local);
    this.rules = new RuleStore(
      local,
      () => new Set(facet.containers.list().map((c) => c.id)),
    );
    this.exemptions = new ExemptionManager(session);
    this.groups = new TabGroupProjection({
      tabs: b.tabs as unknown as TabsLike,
      tabGroups: b.tabGroups as unknown as TabGroupsLike,
      area: session,
      settings: () => this.settings.get(),
      container: (id) => facet.containers.get(id),
      containers: () => facet.containers.list(),
      updateContainer: (id, patch) => facet.updateContainer(id, patch),
      containerTabs: () =>
        facet.tabs
          .entries()
          .map(([tabId, rec]) => ({ tabId, containerId: rec.containerId })),
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
        const newTabId = await facet.replaceTab(
          tabId,
          containerId,
          url,
          onCreated,
        );
        this.saved.willMove(tabId);
        await b.tabs.remove(tabId).catch(() => {});
        return newTabId;
      },
      navigate: async (tabId, url) => {
        // A rule moving a tab: no service worker of the target may answer the repeated navigation.
        if (facet.getTabContainer(tabId) !== null)
          await facet.prepareNavigation(url);
        await b.tabs.update(tabId, { url });
      },
      chooseUrl: (url, tabId) =>
        `${b.runtime.getURL("/choose.html" as never)}?url=${encodeURIComponent(url)}&tab=${tabId}`,
      log: facet.log,
    });

    this.saved = new SavedTabsRecorder({
      session,
      queryTabs: () => b.tabs.query({}) as Promise<SeenTab[]>,
      windowCount: async () => (await b.windows.getAll()).length,
      containerOf: (tabId) => facet.tabs.containerOf(tabId),
      tabsOf: (containerId) => facet.tabs.tabsOf(containerId),
      containerName: (id) => facet.containers.get(id)?.name,
      enabled: () => this.settings.get().rememberTabs,
      save: (id, tabs) => facet.savedTabs.set(id, tabs),
      log: facet.log,
    });

    this.reopener = new TabReopener({
      replaceTab: (tabId, containerId, url) => {
        const key = ruleKeyOf(url);
        // The container was chosen for this tab (a group, the user's restore): the repeated navigation is not judged by domain rules.
        return facet.replaceTab(tabId, containerId, url, (newTabId) => {
          if (key !== null)
            this.exemptions.markSite(newTabId, containerId, key);
        });
      },
      groupsIdle: () => this.groups.idle(),
      removeTab: (tabId) => this.removeWithRetry(tabId),
    });

    this.guard = new GroupGuard({
      getTab: (tabId) =>
        b.tabs.get(tabId).then(
          (t) => t as GuardTab,
          () => null,
        ),
      groupedTabs: async () =>
        ((await b.tabs.query({})) as GuardTab[]).filter((t) => t.groupId >= 0),
      groupContainer: (groupId) => this.groups.containerOfGroup(groupId),
      groupsIdle: () => this.groups.idle(),
      containerOf: (tabId) => facet.getTabContainer(tabId),
      isAssigning: (tabId) => facet.isAssigning(tabId),
      isWaiting: (tabId) => facet.restore.isWaiting(tabId),
      ownTab: (tabId) => facet.ownTabState(tabId),
      containerName: (id) => facet.containers.get(id)?.name,
      assignInPlace: (tabId, containerId) =>
        facet.assignInPlace(tabId, containerId),
      move: (tabId, containerId, url) =>
        this.reopenInContainer(tabId, containerId, url),
      splitTabs: (splitViewId) =>
        b.tabs.query({ splitViewId } as never).then(
          (tabs) => tabs as GuardTab[],
          () => [],
        ),
      ungroupSplit: (tabIds) => this.groups.ungroupSplit(tabIds),
      placeOwn: (tabId, containerId) =>
        this.groups.placeOwn(tabId, containerId),
      moved: (newTabId, _containerId, name) =>
        void this.badges.notice(newTabId, `moved to “${name}”`),
      periodic: (on) => void this.setSweepAlarm(on),
      log: facet.log,
    });

    this.mark = new GroupMark({
      containerOf: (tabId) => facet.getTabContainer(tabId),
      groupOf: (tabId) =>
        b.tabs.get(tabId).then(
          (t) => t.groupId,
          () => null,
        ),
      groupContainer: (groupId) => this.groups.containerOfGroup(groupId),
      groupsOn: () => this.settings.get().tabGroups,
      groupsIdle: () => this.groups.idle(),
      send: (tabId, message) =>
        b.tabs.sendMessage(tabId, message, { frameId: 0 }).then(
          () => undefined,
          () => undefined,
        ),
    });
    // The page asks once when it starts; changes are pushed (`refreshMark`).
    facet.addContentHandler(OUTSIDE_GROUP_MESSAGE, async (tabId, sender) => {
      if (sender.frameId !== 0) return { ok: false };
      await this.ready;
      return { ok: true, outside: await this.mark.isOutside(tabId) };
    });

    facet.events.on((event) => this.onFacetEvent(event));
    this.settings.onChange((next, previous) => {
      void facet
        .applySettings(next)
        .catch((error) =>
          facet.log("error", "applying settings failed", String(error)),
        );
      if (next.tabGroups === previous.tabGroups) return;
      void (
        next.tabGroups ? this.groups.reconcileAll() : this.groups.releaseAll()
      ).then(() =>
        this.mark.refreshMany(this.facet.tabs.entries().map(([id]) => id)),
      );
    });
  }

  /** Call right after `facet.start()`; resolves once settings, rules and exemptions are loaded. */
  start(facetReady: Promise<void>): Promise<void> {
    this.ready = facetReady.then(async () => {
      await Promise.all([
        this.settings.load(),
        this.exemptions.load(),
        this.groups.load(),
        this.rules.load(),
      ]);
      await this.saved.start();
      void this.groups.adoptExisting(); // groups Chrome kept through a restart; titles of earlier versions get the glyph
      const tabIds = [
        ...this.facet.tabs.entries().map(([id]) => id),
        ...this.facet.restore.heldIds(),
      ];
      await this.badges.applyGlobal();
      await this.badges.applyMany(tabIds);
      if (__FULL__ && this.settings.get().agentBridge)
        await this.refreshAllBadges();
      // Tabs that sit in a container's group without being in it (left from before, or missed while the worker slept).
      void this.facet
        .settled()
        .then(
          () =>
            new Promise((resolve) => setTimeout(resolve, START_SWEEP_DELAY_MS)),
        )
        .then(() => this.guard.sweep("worker started"));
    });
    return this.ready;
  }

  /**
   * Moves a loaded website into a container the only safe way: `Facet.replaceTab` opens `url` in a FRESH tab of the container at
   * the old tab's place (no opener, a new browsing context, so no other window keeps a reference to the document), the new tab
   * joins the container's group, then the old tab is closed. Resolves with the new tab's ID. Used by the group guard and by the
   * restore from leftover groups; one move per original tab at a time (`TabReopener`).
   */
  reopenInContainer(
    tabId: number,
    containerId: ContainerId,
    url: string,
  ): Promise<number> {
    return this.reopener.reopen(tabId, containerId, url);
  }

  /** The periodic sweep's alarm, created only when missing (creating it again would restart its period). */
  private async setSweepAlarm(on: boolean): Promise<void> {
    try {
      const existing = await this.b.alarms.get(GROUP_SWEEP_ALARM);
      if (on && !existing)
        await this.b.alarms.create(GROUP_SWEEP_ALARM, { periodInMinutes: 0.5 });
      else if (!on && existing) await this.b.alarms.clear(GROUP_SWEEP_ALARM);
    } catch (error) {
      this.facet.log(
        "warn",
        "group guard: could not set its alarm",
        String(error),
      );
    }
  }

  /** The agent bridge was switched on or off: every tab's badge says so (or stops saying so). */
  async refreshAllBadges(): Promise<void> {
    await this.badges.applyGlobal();
    const tabs = await this.b.tabs.query({}).catch(() => []);
    await this.badges.applyMany(
      tabs.map((t) => t.id).filter((id): id is number => id !== undefined),
    );
  }

  private onFacetEvent(event: FacetEvent): void {
    switch (event.type) {
      case "tab-assigned":
        void this.ready.then(() => {
          this.saved.tabAssigned(event.containerId);
          this.saved.layoutChanged();
        });
        // Synchronous: this placement exempts the tab's next navigation from domain rules, and that navigation may
        // follow immediately.
        this.exemptions.markPlacement(event.tabId, event.containerId);
        void this.ready.then(() => {
          void this.groups.tabAssigned(event.tabId, event.containerId);
          void this.badges.apply(event.tabId);
          void this.mark.refresh(event.tabId);
        });
        break;
      case "tab-unassigned":
        void this.ready.then(() => {
          this.saved.layoutChanged();
          void this.groups.tabUnassigned(event.tabId, event.containerId);
          void this.badges.apply(event.tabId);
          void this.mark.refresh(event.tabId, true);
        });
        break;
      case "tab-replaced":
        this.exemptions.move(event.removed, event.added);
        void this.ready.then(() =>
          this.saved.tabReplaced(event.added, event.removed),
        );
        void this.ready.then(() => this.badges.apply(event.added));
        break;
      case "container-updated":
        this.handleGroupsChanged();
        void this.ready.then(async () => {
          void this.groups.containerUpdated(event.container);
          const tabIds = this.facet.tabs.tabsOf(event.container.id);
          await this.badges.applyMany(tabIds);
          if (__FULL__ && event.renamed) {
            for (const tabId of tabIds) {
              void this.b.tabs
                .sendMessage(tabId, {
                  type: RENAMED_MESSAGE,
                  name: event.container.name,
                })
                .catch(() => {});
            }
          }
        });
        break;
      case "restore-held":
        // Waiting tabs: their badge, and the hint on the button for every other tab.
        void this.ready.then(async () => {
          await this.badges.applyGlobal();
          await this.badges.applyMany(event.tabIds);
        });
        break;
      case "container-deleted":
        this.handleGroupsChanged();
        void this.ready.then(async () => {
          await this.groups.containerDeleted(event.id);
          await this.rules.pruneDeleted();
        });
        break;
    }
  }

  /** Closes a tab; while the user still holds a dragged tab Chrome refuses, so this waits for the drop (up to ~20 s). */
  private async removeWithRetry(tabId: number): Promise<void> {
    this.saved.willMove(tabId);
    for (let attempt = 0; attempt < 80; attempt++) {
      try {
        await this.b.tabs.remove(tabId);
        return;
      } catch (error) {
        if (
          !/cannot be edited|dragging/i.test(
            String((error as Error)?.message ?? error),
          )
        )
          return; // already gone
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }

  // ---- called from extras-listeners.ts ----

  /** `tabs.onCreated`: Chrome may create a tab inside a group (it then reports no group change). */
  handleTabCreated(tab: GuardTab): void {
    if (tab.id === undefined || !(tab.groupId >= 0)) return;
    void this.facet.ready
      .then(() => this.ready)
      .then(() => this.guard.tabCreated(tab));
  }

  /** `tabs.onUpdated`: a container tab navigated or got a new title (the saved tabs need the address and title). */
  handleTabUpdated(tab: SeenTab): void {
    void this.facet.ready
      .then(() => this.ready)
      .then(() => this.saved.tabUpdated(tab));
  }

  /** A tab was created, moved, attached or detached: where container tabs stand changed. */
  handleTabLayout(): void {
    void this.facet.ready
      .then(() => this.ready)
      .then(() => this.saved.layoutChanged());
  }

  /** `tabs.onUpdated` with a `groupId`: the user may have dragged the tab into a group that stands for a container. */
  handleGroupChanged(tabId: number, groupId: number): void {
    if (groupId < 0) return;
    void this.facet.ready
      .then(() => this.ready)
      .then(() => this.guard.groupChanged(tabId, groupId));
  }

  /** `tabs.onUpdated` with a `groupId` (joined, left or moved to another group): the "⧉ " mark of a container tab follows. */
  handleGroupMembership(tabId: number): void {
    void this.facet.ready
      .then(() => this.ready)
      .then(() => this.mark.refresh(tabId));
  }

  /** `tabGroups.onUpdated`: the user may have renamed or recoloured a group of ours in Chrome's menu. */
  handleGroupEdited(group: {
    id: number;
    title?: string;
    color: string;
  }): void {
    void this.facet.ready
      .then(() => this.ready)
      .then(() => this.groups.groupUpdated(group));
  }

  /** A tab attached from another window, a group created or retitled, a container renamed or deleted: sweep soon. */
  handleGroupsChanged(): void {
    void this.facet.ready
      .then(() => this.ready)
      .then(() => this.guard.scheduleSweep());
  }

  /** `alarms.onAlarm` for the periodic sweep. */
  handleAlarm(name: string): void {
    if (name !== GROUP_SWEEP_ALARM) return;
    void this.facet.ready.then(() => this.ready).then(() => this.guard.sweep());
  }

  async handleBeforeNavigate(details: {
    tabId: number;
    frameId: number;
    url: string;
    documentLifecycle?: string;
    timeStamp?: number;
  }): Promise<void> {
    if (details.frameId !== 0) return;
    await this.facet.ready;
    await this.ready;
    try {
      await this.engine.handleBeforeNavigate(details);
    } catch (error) {
      this.facet.log("error", "domain rule failed", String(error));
    }
  }

  handleCreatedNavigationTarget(details: {
    sourceTabId: number;
    tabId: number;
  }): void {
    void this.ready.then(() =>
      this.engine.noteChildOfContainerTab(details.tabId, details.sourceTabId),
    );
  }

  /** Re-applies the badge after navigation, which resets tab-specific action state. */
  handleTabRefresh(tabId: number): void {
    void this.ready.then(() =>
      this.facet.getTabContainer(tabId) !== null ||
      (__FULL__ && this.settings.get().agentBridge) ||
      this.facet.restore.isHeld(tabId)
        ? this.badges.apply(tabId)
        : undefined,
    );
  }

  handleTabAttached(tabId: number): void {
    void this.ready.then(() => {
      const containerId: ContainerId | null = this.facet.getTabContainer(tabId);
      if (containerId !== null) {
        void this.groups.tabAssigned(tabId, containerId);
        void this.mark.refresh(tabId);
      }
    });
  }

  handleTabRemoved(
    tabId: number,
    info: { isWindowClosing?: boolean } = {},
  ): void {
    const at = Date.now();
    void this.facet.ready
      .then(() => this.ready)
      .then(() =>
        this.saved.tabRemoved(tabId, info.isWindowClosing === true, at),
      );
    this.exemptions.forget(tabId);
    this.engine.forgetTab(tabId);
    this.mark.forget(tabId);
    this.badges.forget(tabId);
  }
}
