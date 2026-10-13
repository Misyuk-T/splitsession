import { type Browser, browser } from "wxt/browser";

import {
  type Container,
  type ContainerColor,
  type ContainerId,
  type Cookie,
  normalizeSettings,
  type Settings,
  SETTINGS_KEY,
  sleep,
} from "../core";
import { networkOrigin } from "../engine/capture/headers";
import { StaleNavigationDetector } from "../engine/capture/stale-detector";
import {
  ContentScriptLifecycle,
  type ContentScriptLifecycleDeps,
  DEFAULT_BEACON_RULESET,
} from "../engine/content-scripts";
import {
  type DnrSessionApi,
  SessionRuleManager,
} from "../engine/dnr/session-rules";
import {
  ContainerError,
  ContainerStore,
} from "../engine/storage/container-store";
import type { StorageAreaLike } from "../engine/storage/storage-area";
import { TabRegistry } from "../engine/storage/tab-registry";
import { migrateStrictMode, StrictMode } from "../engine/strict-mode";
import {
  type BrowsingDataApi,
  type DnrDynamicApi,
  ServiceWorkerPolicy,
} from "../engine/sw-policy";
import { restoreTabsAfterUpdate } from "./isolation/after-update";
import { Assignments } from "./isolation/assignments";
import { BrowserEvents } from "./isolation/browser-events";
import { ContainerRules, NO_TAB_KEY } from "./isolation/container-rules";
import {
  type ContentMessage,
  type ContentMessageDeps,
  handleContentMessage,
} from "./isolation/content-messages";
import { CookieCapture } from "./isolation/cookie-capture";
import { CtrMarkers } from "./isolation/ctr-marker";
import { OwnTabs } from "./isolation/own-tabs";
import {
  loadPageKeys,
  PAGE_KEY_SECRET_KEY,
  type PageKeyOf,
} from "./isolation/page-keys";
import { PopupChildren } from "./isolation/popup-children";
import { type InternalOpenOptions, TabOpener } from "./isolation/tab-opener";
import type { EngineCore, NavigationDetails } from "./isolation/types";
import { FacetEvents } from "./events";
import { createLogger, logFailure, type Logger } from "./log";
import { RESTORE_KEY, type RestoreBrowser, TabRestore } from "./restore";

export { NO_TAB_KEY } from "./isolation/container-rules";
export { PAGE_KEY_SECRET_KEY } from "./isolation/page-keys";
export { CHILD_NONCE } from "./isolation/popup-children";
export type { InternalOpenOptions, OpenOptions } from "./isolation/tab-opener";

export const PURGE_ALARM = "facet-purge";
/** Browser start: matching the previous session's tabs may hold `ready` this long at most. */
const STARTUP_PASS_LIMIT_MS = 10_000;

type MessageSender = Browser.runtime.MessageSender;

export interface ContainerInfo extends Container {
  tabCount: number;
}

/**
 * The isolation engine: containers, tab assignments, cookie capture, session rules, inheritance and navigation
 * helpers. This class wires the parts (`./isolation/*`) and is the API the rest of the extension uses. Event
 * listeners live in `listeners.ts` (registered synchronously at the top level of the worker) and forward to
 * `browserEvents` (tabs, navigation, webRequest) or to the `handle*` methods here (runtime events, content-script
 * messages); every handler awaits `ready`, so events that wake the worker are processed after rehydration.
 */
export class Facet {
  readonly containers: ContainerStore;
  readonly tabs: TabRegistry;
  readonly rules: SessionRuleManager;
  readonly swPolicy: ServiceWorkerPolicy;
  readonly strict: StrictMode;
  readonly detector: StaleNavigationDetector;
  /** Container tabs that come back (browser restart, reopened tabs and groups): `restore.ts`. */
  readonly restore: TabRestore;
  /** Content scripts registered only while containers are in use (`engine/content-scripts.ts`). */
  readonly scripts: ContentScriptLifecycle;
  readonly log: Logger;
  /** Assignment and container changes, for the Stage C modules (tab groups, badges, domain rules). */
  readonly events = new FacetEvents();
  /** What each tab, navigation and webRequest event does (`listeners.ts` forwards there). */
  readonly browserEvents: BrowserEvents;
  ready!: Promise<void>;

  /** What every isolation module reads (`isolation/types.ts`). */
  private readonly core: EngineCore;
  private readonly containerRules: ContainerRules;
  private readonly assignments: Assignments;
  private readonly capture: CookieCapture;
  private readonly ctr: CtrMarkers;
  private readonly children: PopupChildren;
  private readonly own: OwnTabs;
  private readonly opener: TabOpener;
  private readonly messageDeps: ContentMessageDeps;

  /** Settings the engine needs: what pages may see, strict mode. Read from storage at start, then pushed by Extras. */
  private settings: Settings = normalizeSettings(undefined);
  private settingsWork: Promise<void> = Promise.resolve();
  /** Page key of (container, site): HMAC with the per-install secret, set during rehydration. */
  private pageKeyOf: PageKeyOf = () => {
    throw new Error("page keys used before start");
  };

  /** `handleInstalled` under way (an extension update puts container tabs back after `ready`). */
  private installing: Promise<void> = Promise.resolve();

  constructor(private readonly b: typeof browser = browser) {
    this.log = createLogger();
    const local = b.storage.local as unknown as ConstructorParameters<
      typeof ContainerStore
    >[0];
    const session = b.storage.session as unknown as ConstructorParameters<
      typeof TabRegistry
    >[0];
    this.containers = new ContainerStore(local);
    this.tabs = new TabRegistry(session, local);
    this.rules = new SessionRuleManager(
      b.declarativeNetRequest as unknown as DnrSessionApi,
      (key, allocator, budget) =>
        this.containerRules.compile(key, allocator, budget),
      { log: this.log },
    );
    this.swPolicy = new ServiceWorkerPolicy(
      local,
      b.declarativeNetRequest as unknown as DnrDynamicApi,
      b.browsingData as unknown as BrowsingDataApi,
      {
        log: this.log,
        onSitesChanged: () => {
          void this.rules.invalidate(NO_TAB_KEY);
          this.scripts.changed();
        },
        onGuardChanged: () => void this.rules.invalidate(NO_TAB_KEY),
      },
    );
    this.strict = new StrictMode(this.swPolicy);
    this.detector = new StaleNavigationDetector({
      containerOf: (tabId) => this.tabs.containerOf(tabId),
    });
    this.restore = new TabRestore({
      b: b as unknown as RestoreBrowser,
      local: local as never,
      session: session as never,
      log: this.log,
      containerTabs: () =>
        this.tabs.entries().map(([tabId, rec]) => [tabId, rec.containerId]),
      hasContainer: (id) => this.containers.get(id) !== undefined,
      isContainerTab: (tabId) => this.tabs.has(tabId),
      assign: async (tabId, containerId) =>
        void (await this.assign(tabId, containerId)),
      invalidate: () => this.rules.invalidate(RESTORE_KEY),
      prepareNavigation: (url) => this.prepareNavigation(url),
      heldPage: b.runtime.getURL("/held.html" as never),
      heldChanged: (tabIds) =>
        this.events.emit({ type: "restore-held", tabIds }),
      waitingChanged: () => this.scripts.changed(),
    });
    this.scripts = new ContentScriptLifecycle({
      scripting:
        b.scripting as unknown as ContentScriptLifecycleDeps["scripting"],
      setBeaconRules: async (on) => {
        const dnr = b.declarativeNetRequest;
        // On: the answers before any script can ask. Off: only after the scripts are gone (the lifecycle's order).
        if (on)
          await dnr.updateEnabledRulesets({
            enableRulesetIds: [DEFAULT_BEACON_RULESET],
          });
        await this.swPolicy.setBeacon(on);
        if (!on)
          await dnr.updateEnabledRulesets({
            disableRulesetIds: [DEFAULT_BEACON_RULESET],
          });
      },
      usage: () => ({
        tabs: this.tabs.entries().length,
        waiting: this.restore.waitingCount(),
        starting: this.restore.isStarting(),
      }),
      managedSites: () => this.swPolicy.sites(),
      log: this.log,
    });

    this.core = {
      b,
      ready: () => this.ready,
      tabs: this.tabs,
      containers: this.containers,
      log: this.log,
      prepareNavigation: (url) => this.prepareNavigation(url),
    };
    const { core } = this;
    const assign = (tabId: number, containerId: ContainerId) =>
      this.assign(tabId, containerId);
    this.containerRules = new ContainerRules({
      tabs: this.tabs,
      containers: this.containers,
      swPolicy: this.swPolicy,
      restore: this.restore,
      rules: () => this.rules,
      settings: () => this.settings,
      pageKeyOf: (containerId, site) => this.pageKeyOf(containerId, site),
    });
    this.assignments = new Assignments({
      ...core,
      rules: this.rules,
      scripts: this.scripts,
      restore: this.restore,
      swPolicy: this.swPolicy,
      events: this.events,
    });
    this.capture = new CookieCapture({
      ...core,
      rules: this.rules,
      detector: this.detector,
    });
    this.ctr = new CtrMarkers({ ...core, detector: this.detector, assign });
    this.children = new PopupChildren({
      ...core,
      restore: this.restore,
      detector: this.detector,
      capture: this.capture,
      assign,
      assignment: (tabId) => this.assignments.current(tabId),
    });
    this.own = new OwnTabs(this.log);
    this.opener = new TabOpener({
      ...core,
      own: this.own,
      restore: this.restore,
      assign,
    });
    this.browserEvents = new BrowserEvents({
      ...core,
      rules: this.rules,
      swPolicy: this.swPolicy,
      restore: this.restore,
      events: this.events,
      assignments: this.assignments,
      containerRules: this.containerRules,
      capture: this.capture,
      ctr: this.ctr,
      children: this.children,
      own: this.own,
    });
    this.messageDeps = {
      ...core,
      capture: this.capture,
      children: this.children,
      containerRules: this.containerRules,
      openInContainer: (url, containerId, options) =>
        this.openInContainer(url, containerId, options),
    };

    // Where container tabs are (and what they show) is what a restore has to recognise.
    this.events.on(() => this.restore.scheduleSnapshot());
    // The last container tab gone (or the first one back): the content scripts follow.
    this.events.on(() => this.scripts.changed());
  }

  start(): Promise<void> {
    this.ready = this.rehydrate();
    return this.ready;
  }

  private async rehydrate(): Promise<void> {
    const local = this.b.storage.local;
    // Before the settings are read: strict mode moves from "consent" to a plain setting (once).
    await migrateStrictMode(local as unknown as StorageAreaLike).catch(
      logFailure(this.log, "strict mode migration failed"),
    );
    const stored = await local.get([SETTINGS_KEY, PAGE_KEY_SECRET_KEY]);
    this.settings = normalizeSettings(stored[SETTINGS_KEY]);
    this.pageKeyOf = await loadPageKeys(local, stored[PAGE_KEY_SECRET_KEY]);
    await Promise.all([this.containers.load(), this.tabs.load()]);
    // What Chrome kept registered decides whether the global beacon answers belong in the dynamic rules.
    await this.scripts.readRegistered();
    // Managed sites and the strict state first: the no-tab rule compiled below depends on both.
    await this.swPolicy
      .load(
        this.strict.load(this.settings.strictMode),
        this.scripts.beaconRules,
      )
      .catch(logFailure(this.log, "service-worker policy failed to load"));
    const liveTabList = await this.b.tabs.query({});
    const liveTabs = new Set(
      liveTabList
        .map((t) => t.id)
        .filter((id): id is number => id !== undefined),
    );
    const now = Date.now();
    for (const [tabId, rec] of this.tabs.entries()) {
      if (!liveTabs.has(tabId) || !this.containers.get(rec.containerId))
        void this.tabs.delete(tabId);
      else if (rec.activeSince === null)
        void this.tabs.update(tabId, { activeSince: now });
    }
    // Before the session rules: the gate's openers are compiled from what this decides.
    const startup = await this.restore
      .load(liveTabList, this.settings.restoreTabs)
      .catch((error) => {
        this.log("error", "restore state failed to load", String(error));
        return false;
      });
    const ok = await this.rules.reset([
      ...this.tabs.containerIds(),
      NO_TAB_KEY,
      RESTORE_KEY,
    ]);
    if (!ok) this.log("error", "could not reinstall session rules after start");
    await this.b.alarms
      .create(PURGE_ALARM, { periodInMinutes: 1 })
      .catch(() => {});
    if (startup) {
      // Browser start (or an extension update): tabs with the address of a container tab wait, blocked, until matched.
      const pass = this.restore
        .startupPass()
        .catch(logFailure(this.log, "restoring container tabs failed"));
      await Promise.race([pass, sleep(STARTUP_PASS_LIMIT_MS)]);
    } else {
      this.restore.afterLoad();
    }
    // Registered iff containers are in use, derived from the tab registry and the restore state just loaded.
    await this.scripts
      .start()
      .catch(logFailure(this.log, "content-script registration failed"));
    this.log(
      "info",
      `ready: ${this.containers.list().length} containers, ${this.tabs.entries().length} tabs`,
    );
  }

  // ---------------------------------------------------------------- containers

  listContainers(): ContainerInfo[] {
    return this.containers
      .list()
      .map((c) => ({ ...c, tabCount: this.tabs.tabsOf(c.id).length }));
  }

  async createContainer(input: {
    name: string;
    color?: ContainerColor;
  }): Promise<Container> {
    await this.ready;
    return this.containers.create(input);
  }

  /**
   * Engine settings, pushed by Extras whenever they change. A name shown to pages lives in the beacon rules, strict
   * mode in the no-tab rule and the global guard.
   */
  applySettings(next: Settings): Promise<void> {
    // Serialised: a caller awaiting this also waits for an application already under way.
    const work = this.settingsWork.then(async () => {
      await this.ready;
      const previous = this.settings;
      this.settings = { ...next };
      if (__FULL__ && previous.showNameToPages !== next.showNameToPages)
        await this.rules.invalidate(...this.tabs.containerIds());
      if (previous.strictMode !== next.strictMode) {
        await this.strict.setEnabled(next.strictMode);
        await this.rules.invalidate(NO_TAB_KEY);
      }
      if (previous.restoreTabs !== next.restoreTabs)
        await this.restore.setEnabled(next.restoreTabs);
    });
    this.settingsWork = work.catch(() => {}); // a failure reaches this caller only, not the next one
    return work;
  }

  /**
   * SplitSession is about to navigate a container tab to `url` itself: the origin's service workers are removed first, so
   * none of the real profile can answer the first request (its fetches would carry no tab ID, outside the rules).
   */
  async prepareNavigation(url: string | undefined): Promise<void> {
    const origin = networkOrigin(url);
    if (origin) await this.swPolicy.prepare(origin);
  }

  async updateContainer(
    id: ContainerId,
    patch: { name?: string; color?: ContainerColor },
  ): Promise<Container> {
    await this.ready;
    const updated = await this.containers.update(id, patch);
    // The beacon echoes the name.
    if (patch.name !== undefined && this.tabs.tabsOf(id).length > 0)
      await this.rules.invalidate(id);
    this.events.emit({
      type: "container-updated",
      container: updated,
      renamed: patch.name !== undefined,
      recolored: patch.color !== undefined,
    });
    return updated;
  }

  /** Closes the container's tabs, drops its rules and its jar. Namespaced page storage stays behind (see limits). */
  async deleteContainer(id: ContainerId): Promise<void> {
    await this.ready;
    if (!this.containers.get(id))
      throw new ContainerError(`no container "${id}"`);
    const tabIds = this.tabs.tabsOf(id);
    for (const tabId of tabIds) void this.tabs.delete(tabId);
    await this.containers.delete(id);
    await this.rules.invalidate(id);
    this.events.emit({ type: "container-deleted", id });
    if (tabIds.length > 0) await this.b.tabs.remove(tabIds).catch(() => {});
  }

  /** By ID or (case-insensitive) name; creates a container with that name when none matches. */
  async ensureContainer(ref: string): Promise<Container> {
    await this.ready;
    if (typeof ref !== "string" || ref.trim() === "")
      throw new ContainerError(
        "container reference must be a non-empty string",
      );
    return this.containers.resolve(ref) ?? this.createContainer({ name: ref });
  }

  getJar(containerId: ContainerId): Cookie[] {
    return this.containers.get(containerId)
      ? this.containers.jar(containerId).all()
      : [];
  }

  // ---------------------------------------------------------------- tabs

  getTabContainer(tabId: number): ContainerId | null {
    return this.tabs.containerOf(tabId) ?? null;
  }

  listTabs(): Array<{
    tabId: number;
    containerId: ContainerId;
    active: boolean;
  }> {
    return this.tabs.entries().map(([tabId, rec]) => ({
      tabId,
      containerId: rec.containerId,
      active: rec.activeSince !== null,
    }));
  }

  /**
   * Puts a tab into a container (or takes it out with `null`). Resolves once the tab's rules are active. The page
   * already loaded in the tab keeps its old JS state; pass `reload` (or navigate) to start clean.
   */
  async assignTab(
    tabId: number,
    containerId: ContainerId | null,
    options: { reload?: boolean } = {},
  ): Promise<void> {
    await this.ready;
    // A tab waiting for its restore decision: this is the user's (or an agent's) decision.
    const heldAddress = await this.restore.release(tabId);
    if (containerId === null) {
      await this.assignments.unassign(tabId);
    } else {
      this.detector.forgetTab(tabId);
      await this.assign(tabId, containerId);
    }
    if (options.reload) {
      // A waiting tab shows SplitSession's own page: it goes to the address it stood for.
      if (containerId !== null)
        await this.prepareNavigation(
          heldAddress ?? (await this.b.tabs.get(tabId).catch(() => null))?.url,
        );
      if (heldAddress !== undefined)
        await this.b.tabs.update(tabId, { url: heldAddress });
      else await this.b.tabs.reload(tabId);
    }
  }

  /**
   * Puts a tab into a container where it stands, without loading anything: for tabs with no document of another
   * identity alive (a page that is not a website, such as the new tab page; a tab Chrome has not loaded or has
   * discarded; a tab the restore holds back, blocked or on SplitSession's waiting page, which goes to its address now).
   */
  async assignInPlace(tabId: number, containerId: ContainerId): Promise<void> {
    await this.ready;
    const heldAddress = await this.restore.release(tabId);
    this.detector.forgetTab(tabId);
    await this.assign(tabId, containerId);
    if (heldAddress !== undefined) {
      await this.prepareNavigation(heldAddress);
      await this.b.tabs.update(tabId, { url: heldAddress });
    }
  }

  /** Returns the time the rules became active. Throws (and leaves the tab unassigned) if they could not be installed. */
  private assign(tabId: number, containerId: ContainerId): Promise<number> {
    return this.assignments.assign(tabId, containerId);
  }

  /** SplitSession is putting the tab into a container right now (assignment under way, or a popup child inheriting). */
  isAssigning(tabId: number): boolean {
    return (
      this.assignments.isRunning(tabId) ||
      this.children.isInheriting(tabId) ||
      this.tabs.get(tabId)?.activeSince === null
    );
  }

  /** See `TabOpener.openInContainer`: the first request of the new tab is already isolated. */
  openInContainer(
    url: string,
    ref: ContainerId,
    options: InternalOpenOptions = {},
  ): Promise<number> {
    return this.opener.openInContainer(url, ref, options);
  }

  /** See `TabOpener.replaceTab`: a fresh tab at the same place, so no other context keeps a link to the document. */
  replaceTab(
    tabId: number,
    containerId: ContainerId | null,
    url: string,
    onCreated?: (newTabId: number) => void,
  ): Promise<number> {
    return this.opener.replaceTab(tabId, containerId, url, onCreated);
  }

  /** See `OwnTabs.track`: the group guard must not take a tab SplitSession is placing. */
  trackOwnCreation<T extends { id?: number }>(
    creation: Promise<T>,
  ): Promise<T> {
    return this.own.track(creation);
  }

  ownTabDone(tabId: number): void {
    this.own.done(tabId);
  }

  /** See `OwnTabs.state`. */
  ownTabState(tabId: number): Promise<"busy" | "own" | null> {
    return this.own.state(tabId);
  }

  /** Resolves once start-up work is over: rehydration, and the container tabs an extension update puts back. */
  async settled(): Promise<void> {
    await this.ready;
    await this.installing;
  }

  /** See `CtrMarkers.decision`: one decision per navigation, shared with the domain-rule engine. */
  ctrDecision(details: NavigationDetails): Promise<ContainerId | null> {
    return this.ctr.decision(details);
  }

  /** Install or update: strict mode's install step, and after an update the container tabs go back in (`after-update.ts`). */
  handleInstalled(reason: string): Promise<void> {
    const work = this.installed(reason);
    this.installing = work.catch(() => {});
    return work;
  }

  private async installed(reason: string): Promise<void> {
    await this.ready;
    await this.strict
      .installed(reason)
      .catch(logFailure(this.log, "strict mode after install failed"));
    if (reason !== "update") return;
    await restoreTabsAfterUpdate({
      ...this.core,
      rules: this.rules,
      scripts: this.scripts,
      events: this.events,
    });
  }

  /** Browser start: tab IDs from the last session mean nothing now. */
  handleStartup(): void {
    void this.tabs.clearBackup();
    void this.ready.then(() => this.strict.startup());
  }

  async handleAlarm(name: string): Promise<void> {
    if (name !== PURGE_ALARM) return;
    await this.ready;
    // Catches a grace period the worker did not live to see, and restore decisions that emitted no event.
    this.scripts.changed();
    for (const container of this.containers.list()) {
      if (this.containers.jar(container.id).purgeExpired() === 0) continue;
      this.containers.touchJar(container.id);
      if (this.tabs.tabsOf(container.id).length > 0)
        await this.rules.invalidate(container.id);
    }
  }

  handleSuspend(): void {
    void this.containers.flush();
    // A restore change that is still waiting for its timer is written now.
    this.restore.flushPending();
  }

  /** Answers for `facet/*` messages that belong to the extras (tab groups, ...) and not to the isolation engine. */
  private readonly contentHandlers = new Map<
    string,
    (tabId: number, sender: MessageSender) => Promise<unknown>
  >();

  addContentHandler(
    type: string,
    handler: (tabId: number, sender: MessageSender) => Promise<unknown>,
  ): void {
    this.contentHandlers.set(type, handler);
  }

  /** A `facet/*` message from a content script (`isolation/content-messages.ts`). */
  handleContentMessage(
    message: ContentMessage,
    sender: MessageSender,
  ): Promise<unknown> {
    const extra = this.contentHandlers.get(message.type);
    const tabId = sender.tab?.id;
    if (extra && tabId !== undefined && tabId >= 0)
      return this.ready.then(() => extra(tabId, sender));
    return handleContentMessage(this.messageDeps, message, sender);
  }
}
