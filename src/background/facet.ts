import { browser, type Browser } from 'wxt/browser';
import {
  beaconSiteOf,
  bytesToHex,
  compileGroupRules,
  compileNoTabRule,
  compileNoTabWorkerScriptRule,
  createPageKeyCache,
  ctrMarkerRef,
  hexToBytes,
  hostnameOf,
  isSecureUrl,
  normalizeSettings,
  PAGE_KEY_SECRET_BYTES,
  scriptVisibleCookies,
  SETTINGS_KEY,
  siteOf,
  type CompiledRules,
  type Settings,
  type Container,
  type ContainerColor,
  type ContainerId,
  type Cookie,
  type CookieSnapshotReply,
  type DnrRule,
  type RuleIdAllocator,
  type UpsertOutcome,
} from '../core';
import { setCookieHeaders, networkOrigin } from '../engine/capture/headers';
import {
  parseCookieHeader,
  StaleNavigationDetector,
  type CookieChange,
  type MainFrameSend,
  type Renavigation,
} from '../engine/capture/stale-detector';
import { ensureContentScripts, type ScriptingApi } from '../engine/content-scripts';
import { SessionRuleManager, type DnrSessionApi } from '../engine/dnr/session-rules';
import { ContainerError, ContainerStore } from '../engine/storage/container-store';
import { TabRegistry } from '../engine/storage/tab-registry';
import { migrateStrictMode, StrictMode } from '../engine/strict-mode';
import type { StorageAreaLike } from '../engine/storage/storage-area';
import { ServiceWorkerPolicy, type BrowsingDataApi, type DnrDynamicApi } from '../engine/sw-policy';
import { FacetEvents } from './events';
import { createLogger, type Logger } from './log';
import { RESTORE_KEY, TabRestore, type RestoreBrowser } from './restore';

export const PURGE_ALARM = 'facet-purge';
/** `about:blank#facet-<nonce>`: how the shim marks the blank child it opens before navigating it. */
export const CHILD_NONCE = /#facet-([a-z0-9]{6,32})$/;
const CTR_MARKER = /(?:^|&)ctr=([^&]*)/;
/** Session-rule key of the strict-mode rule for requests outside tabs (container IDs are [a-z0-9]{10}). */
export const NO_TAB_KEY = '@no-tab';
/** `storage.local` key of the per-install secret behind page keys (hex). */
export const PAGE_KEY_SECRET_KEY = 'pageKeySecret';
/** How long the `#ctr=` check waits for the navigation's request (to learn its initiator). */
const CTR_INITIATOR_WAIT_MS = 2_000;
const BLANK_COMMIT_WAIT_MS = 3_000;
/** Frame sites remembered per tab for per-site beacon answers. */
const MAX_FRAME_SITES_PER_TAB = 64;
const AWAIT_CHILD_TIMEOUT_MS = 1_000;
const READY_CHILD_TTL_MS = 2_000;
const SETTLE_WAIT_MS = 60;
/** How long after `updateSessionRules` resolved a request may still have been set up with the previous rules. */
const ASSIGNMENT_LAG_MS = 1_000;
/** Browser start: matching the previous session's tabs may hold `ready` this long at most. */
const STARTUP_PASS_LIMIT_MS = 10_000;

type WebRequestDetails = {
  requestHeaders?: Array<{ name: string; value?: string }>;
  /** Origin that started the request; absent for browser-initiated navigations (address bar, tabs.update, CDP). */
  initiator?: string;
  requestId: string;
  url: string;
  method: string;
  tabId: number;
  type: string;
  frameId: number;
  timeStamp: number;
  statusCode?: number;
  /** onErrorOccurred only. */
  error?: string;
  responseHeaders?: Array<{ name: string; value?: string; binaryValue?: ArrayLike<number> }>;
};

type MessageSender = Browser.runtime.MessageSender;

export interface ContainerInfo extends Container {
  tabCount: number;
}

export interface OpenOptions {
  active?: boolean;
  windowId?: number;
  index?: number;
  openerTabId?: number;
}

/** Options only background code can pass (functions do not travel through the message API). */
export interface InternalOpenOptions extends OpenOptions {
  pinned?: boolean;
  /** Called once the new tab is in the container and has not navigated yet. */
  onAssigned?: (tabId: number) => void;
}

interface SendRecord {
  tabId: number;
  sentAt: number;
  /** Cookie header actually sent (after DNR), null when none. */
  cookie: string | null;
}

interface ChildWaiter {
  parent: number;
  nonce: string;
  resolve: (tabId: number | null) => void;
}

interface MainFrameStart {
  url: string;
  initiator: string | undefined;
  at: number;
}

interface ReadyChild {
  parent: number | undefined;
  child: number;
  nonce: string | undefined;
  at: number;
}

const isHttpUrl = (url: string | undefined): url is string => !!url && /^https?:\/\//i.test(url);
const withoutFragment = (url: string): string => {
  const hash = url.indexOf('#');
  return hash === -1 ? url : url.slice(0, hash);
};
const siteOfFrameUrl = (url: string | undefined): string | null => {
  if (!isHttpUrl(url)) return null;
  try {
    return beaconSiteOf(hostnameOf(new URL(url).hostname));
  } catch {
    return null;
  }
};
const siteOfHttp = (url: string | undefined): string | null => {
  if (!isHttpUrl(url)) return null;
  try {
    return siteOf(url);
  } catch {
    return null;
  }
};
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const CHANGED: ReadonlySet<UpsertOutcome> = new Set(['added', 'updated', 'deleted']);
const toChange = (cookie: Cookie, outcome: UpsertOutcome): CookieChange => ({
  name: cookie.name,
  value: outcome === 'deleted' ? null : cookie.value,
  domain: cookie.domain,
  hostOnly: cookie.hostOnly,
  secure: cookie.secure,
  partitioned: cookie.partitioned,
  sameSite: cookie.sameSite,
});
const cookieHeaderOf = (headers: WebRequestDetails['requestHeaders']): string | null =>
  headers?.find((h) => h.name.toLowerCase() === 'cookie')?.value ?? null;

/**
 * The isolation engine: containers, tab assignments, cookie capture, session rules, inheritance and navigation
 * helpers. Event listeners live in `listeners.ts` (registered synchronously at the top level of the worker) and
 * forward here; every handler awaits `ready`, so events that wake the worker are processed after rehydration.
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
  readonly log: Logger;
  /** Assignment and container changes, for the Stage C modules (tab groups, badges, domain rules). */
  readonly events = new FacetEvents();
  ready!: Promise<void>;

  /** Main/sub-frame requests: last hop's send time, for trusting Set-Cookie. */
  private readonly sends = new Map<string, SendRecord>();
  /** Responses already harvested (onHeadersReceived and onBeforeRedirect both see a 302). */
  private readonly harvested = new Map<string, number>();
  /** Per tab: URLs of responses seen in the last seconds (fetch barrier). */
  private readonly recentResponses = new Map<number, Array<{ url: string; at: number }>>();
  /** Per container: Set-Cookie / document.cookie work still being applied. */
  private readonly pendingWork = new Map<ContainerId, Set<Promise<void>>>();
  private readonly inheriting = new Set<number>();
  private readonly childNonces = new Map<number, string>();
  private readonly childWaiters: ChildWaiter[] = [];
  private readonly readyChildren: ReadyChild[] = [];
  /** Re-navigations waiting for their stale request to finish, by requestId. */
  private readonly deferredRenavs = new Map<string, { renav: Renavigation; timer: ReturnType<typeof setTimeout> }>();
  /** Settings the engine needs: what pages may see, strict mode. Read from storage at start, then pushed by Extras. */
  private settings: Settings = normalizeSettings(undefined);
  private settingsWork: Promise<void> = Promise.resolve();
  /** Page key of (container, site): HMAC with the per-install secret, set during rehydration. */
  private pageKeyOf: (containerId: ContainerId, site: string) => string = () => {
    throw new Error('page keys used before start');
  };
  /** Per container tab: sites of the frames it requested since its last top-level navigation (beacon answers). */
  private readonly frameSites = new Map<number, Set<string>>();
  /** Per tab: recent main-frame requests and their initiators (`#ctr=` is honoured for browser-initiated ones only). */
  private readonly mainFrameStarts = new Map<number, MainFrameStart[]>();
  private readonly mainFrameWaiters = new Set<() => void>();
  /** Tabs whose initial about:blank has committed (`createBlankTab` waits for it) and who waits. */
  private readonly blankCommitted = new Set<number>();
  private readonly blankWaiters = new Set<() => void>();
  /** One `#ctr=` decision per navigation, shared with the domain-rule engine. */
  private readonly ctrDecisions = new Map<string, { at: number; decision: Promise<ContainerId | null> }>();

  constructor(private readonly b: typeof browser = browser) {
    this.log = createLogger();
    const local = b.storage.local as unknown as ConstructorParameters<typeof ContainerStore>[0];
    const session = b.storage.session as unknown as ConstructorParameters<typeof TabRegistry>[0];
    this.containers = new ContainerStore(local);
    this.tabs = new TabRegistry(session, local);
    this.rules = new SessionRuleManager(
      b.declarativeNetRequest as unknown as DnrSessionApi,
      (key, allocator, budget) => this.compileContainer(key, allocator, budget),
      { log: this.log },
    );
    this.swPolicy = new ServiceWorkerPolicy(
      local,
      b.declarativeNetRequest as unknown as DnrDynamicApi,
      b.browsingData as unknown as BrowsingDataApi,
      {
        log: this.log,
        onSitesChanged: () => void (this.settings.strictMode && this.rules.invalidate(NO_TAB_KEY)),
        onGuardChanged: () => void this.rules.invalidate(NO_TAB_KEY),
      },
    );
    this.strict = new StrictMode(this.swPolicy);
    this.detector = new StaleNavigationDetector({ containerOf: (tabId) => this.tabs.containerOf(tabId) });
    this.restore = new TabRestore({
      b: b as unknown as RestoreBrowser,
      local: local as never,
      session: session as never,
      log: this.log,
      containerTabs: () => this.tabs.entries().map(([tabId, rec]) => [tabId, rec.containerId]),
      hasContainer: (id) => this.containers.get(id) !== undefined,
      isContainerTab: (tabId) => this.tabs.has(tabId),
      assign: async (tabId, containerId) => void (await this.assign(tabId, containerId)),
      invalidate: () => this.rules.invalidate(RESTORE_KEY),
      prepareNavigation: (url) => this.prepareNavigation(url),
      heldPage: b.runtime.getURL('/held.html' as never),
      heldChanged: (tabIds) => this.events.emit({ type: 'restore-held', tabIds }),
    });
    // Where container tabs are (and what they show) is what a restore has to recognise.
    this.events.on(() => this.restore.scheduleSnapshot());
  }

  start(): Promise<void> {
    this.ready = this.rehydrate();
    return this.ready;
  }

  private async rehydrate(): Promise<void> {
    const local = this.b.storage.local;
    // Before the settings are read: strict mode moves from "consent" to a plain setting (once).
    await migrateStrictMode(local as unknown as StorageAreaLike).catch((error) => this.log('error', 'strict mode migration failed', String(error)));
    const stored = await local.get([SETTINGS_KEY, PAGE_KEY_SECRET_KEY]);
    this.settings = normalizeSettings(stored[SETTINGS_KEY]);
    let secret = typeof stored[PAGE_KEY_SECRET_KEY] === 'string' ? hexToBytes(stored[PAGE_KEY_SECRET_KEY]) : null;
    if (!secret || secret.length !== PAGE_KEY_SECRET_BYTES) {
      secret = crypto.getRandomValues(new Uint8Array(PAGE_KEY_SECRET_BYTES));
      await local.set({ [PAGE_KEY_SECRET_KEY]: bytesToHex(secret) });
    }
    this.pageKeyOf = createPageKeyCache(secret);
    await Promise.all([this.containers.load(), this.tabs.load()]);
    // Managed sites and the strict state first: the no-tab rule compiled below depends on both.
    await this.swPolicy.load(this.strict.load(this.settings.strictMode)).catch((error) => this.log('error', 'service-worker policy failed to load', String(error)));
    const liveTabList = await this.b.tabs.query({});
    const liveTabs = new Set(liveTabList.map((t) => t.id).filter((id): id is number => id !== undefined));
    const now = Date.now();
    for (const [tabId, rec] of this.tabs.entries()) {
      if (!liveTabs.has(tabId) || !this.containers.get(rec.containerId)) void this.tabs.delete(tabId);
      else if (rec.activeSince === null) void this.tabs.update(tabId, { activeSince: now });
    }
    // Before the session rules: the gate's openers are compiled from what this decides.
    const startup = await this.restore.load(liveTabList, this.settings.restoreTabs).catch((error) => {
      this.log('error', 'restore state failed to load', String(error));
      return false;
    });
    const ok = await this.rules.reset([...this.tabs.containerIds(), NO_TAB_KEY, RESTORE_KEY]);
    if (!ok) this.log('error', 'could not reinstall session rules after start');
    await Promise.allSettled([
      ensureContentScripts(this.b.scripting as unknown as ScriptingApi).then((r) => this.log('info', `content scripts ${r}`)),
      this.b.alarms.create(PURGE_ALARM, { periodInMinutes: 1 }),
    ]);
    if (startup) {
      // Browser start (or an extension update): tabs with the address of a container tab wait, blocked, until matched.
      const pass = this.restore.startupPass().catch((error) => this.log('error', 'restoring container tabs failed', String(error)));
      await Promise.race([pass, sleep(STARTUP_PASS_LIMIT_MS)]);
    } else {
      this.restore.afterLoad();
    }
    this.log('info', `ready: ${this.containers.list().length} containers, ${this.tabs.entries().length} tabs`);
  }

  // ---------------------------------------------------------------- rule compilation

  private compileContainer(containerId: ContainerId, allocator: RuleIdAllocator, regexBudget: number): CompiledRules | null {
    if (containerId === RESTORE_KEY) return this.restore.compile(allocator);
    if (containerId === NO_TAB_KEY) {
      const addRules: DnrRule[] = [];
      const cookies = this.settings.strictMode ? compileNoTabRule(allocator.next(), this.swPolicy.sites()) : null;
      if (cookies) addRules.push(cookies);
      if (this.swPolicy.guarded) addRules.push(compileNoTabWorkerScriptRule(allocator.next()));
      return addRules.length > 0 ? { addRules, ruleIds: addRules.map((r) => r.id), regexRuleCount: 0 } : null;
    }
    const container = this.containers.get(containerId);
    const tabIds = this.tabs.tabsOf(containerId);
    if (!container || tabIds.length === 0) return null;
    const jar = this.containers.jar(containerId);
    const now = Date.now();
    // Partitioned cookies depend on the top-level site: then tabs are grouped by site, otherwise one group.
    const partitioned = jar.all().some((c) => c.partitioned);
    const groups = new Map<string | null, number[]>();
    for (const tabId of tabIds) {
      const site = partitioned ? (this.tabs.get(tabId)?.topLevelSite ?? null) : null;
      const list = groups.get(site);
      if (list) list.push(tabId);
      else groups.set(site, [tabId]);
    }
    const addRules: DnrRule[] = [];
    const ruleIds: number[] = [];
    let regexRuleCount = 0;
    const pageKeyOf = (site: string) => this.pageKeyOf(containerId, site);
    for (const [site, group] of groups) {
      const frameSites = new Set<string>();
      for (const tabId of group) {
        const own = siteOfFrameUrl(this.tabs.get(tabId)?.url);
        if (own) frameSites.add(own);
        for (const s of this.frameSites.get(tabId) ?? []) frameSites.add(s);
      }
      const compiled = compileGroupRules(
        {
          tabIds: group.sort((a, b) => a - b),
          containerId,
          // Pages see the name only when the user allows it (setting "Show container name to pages"; Full edition only).
          containerName: __FULL__ && this.settings.showNameToPages ? container.name : undefined,
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

  // ---------------------------------------------------------------- containers

  listContainers(): ContainerInfo[] {
    return this.containers.list().map((c) => ({ ...c, tabCount: this.tabs.tabsOf(c.id).length }));
  }

  async createContainer(input: { name: string; color?: ContainerColor }): Promise<Container> {
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
      if (__FULL__ && previous.showNameToPages !== next.showNameToPages) await this.rules.invalidate(...this.tabs.containerIds());
      if (previous.strictMode !== next.strictMode) {
        await this.strict.setEnabled(next.strictMode);
        await this.rules.invalidate(NO_TAB_KEY);
      }
      if (previous.restoreTabs !== next.restoreTabs) await this.restore.setEnabled(next.restoreTabs);
    });
    this.settingsWork = work.catch(() => {}); // a failure reaches this caller only, not the next one
    return work;
  }

  /**
   * Facet is about to navigate a container tab to `url` itself: the origin's service workers are removed first, so
   * none of the real profile can answer the first request (its fetches would carry no tab ID, outside the rules).
   */
  async prepareNavigation(url: string | undefined): Promise<void> {
    const origin = networkOrigin(url);
    if (origin) await this.swPolicy.prepare(origin);
  }

  async updateContainer(id: ContainerId, patch: { name?: string; color?: ContainerColor }): Promise<Container> {
    await this.ready;
    const updated = await this.containers.update(id, patch);
    // The beacon echoes the name.
    if (patch.name !== undefined && this.tabs.tabsOf(id).length > 0) await this.rules.invalidate(id);
    this.events.emit({ type: 'container-updated', container: updated, renamed: patch.name !== undefined, recolored: patch.color !== undefined });
    return updated;
  }

  /** Closes the container's tabs, drops its rules and its jar. Namespaced page storage stays behind (see limits). */
  async deleteContainer(id: ContainerId): Promise<void> {
    await this.ready;
    if (!this.containers.get(id)) throw new ContainerError(`no container "${id}"`);
    const tabIds = this.tabs.tabsOf(id);
    for (const tabId of tabIds) void this.tabs.delete(tabId);
    await this.containers.delete(id);
    await this.rules.invalidate(id);
    this.events.emit({ type: 'container-deleted', id });
    if (tabIds.length > 0) await this.b.tabs.remove(tabIds).catch(() => {});
  }

  /** By ID or (case-insensitive) name; creates a container with that name when none matches. */
  async ensureContainer(ref: string): Promise<Container> {
    await this.ready;
    if (typeof ref !== 'string' || ref.trim() === '') throw new ContainerError('container reference must be a non-empty string');
    return this.containers.resolve(ref) ?? this.createContainer({ name: ref });
  }

  // ---------------------------------------------------------------- tabs

  getTabContainer(tabId: number): ContainerId | null {
    return this.tabs.containerOf(tabId) ?? null;
  }

  listTabs(): Array<{ tabId: number; containerId: ContainerId; active: boolean }> {
    return this.tabs.entries().map(([tabId, rec]) => ({ tabId, containerId: rec.containerId, active: rec.activeSince !== null }));
  }

  /**
   * Puts a tab into a container (or takes it out with `null`). Resolves once the tab's rules are active. The page
   * already loaded in the tab keeps its old JS state; pass `reload` (or navigate) to start clean.
   */
  async assignTab(tabId: number, containerId: ContainerId | null, options: { reload?: boolean } = {}): Promise<void> {
    await this.ready;
    // A tab waiting for its restore decision: this is the user's (or an agent's) decision.
    const heldAddress = await this.restore.release(tabId);
    if (containerId === null) {
      await this.unassign(tabId);
    } else {
      this.detector.forgetTab(tabId);
      await this.assign(tabId, containerId);
    }
    if (options.reload) {
      // A waiting tab shows Facet's own page: it goes to the address it stood for.
      if (containerId !== null) await this.prepareNavigation(heldAddress ?? (await this.b.tabs.get(tabId).catch(() => null))?.url);
      if (heldAddress !== undefined) await this.b.tabs.update(tabId, { url: heldAddress });
      else await this.b.tabs.reload(tabId);
    }
  }

  /** Returns the time the rules became active. Throws (and leaves the tab unassigned) if they could not be installed. */
  private async assign(tabId: number, containerId: ContainerId): Promise<number> {
    if (!Number.isInteger(tabId) || tabId < 0) throw new ContainerError(`invalid tab id ${tabId}`);
    if (!this.containers.get(containerId)) throw new ContainerError(`no container "${containerId}"`);
    const tab = await this.b.tabs.get(tabId);
    const prev = this.tabs.get(tabId);
    if (prev?.containerId === containerId && prev.activeSince !== null) return prev.activeSince;
    const write = this.tabs.set(tabId, {
      containerId,
      topLevelSite: siteOfHttp(tab.url ?? tab.pendingUrl),
      activeSince: null,
      windowId: tab.windowId,
      url: tab.url,
    });
    const keys = prev && prev.containerId !== containerId ? [containerId, prev.containerId] : [containerId];
    // A container tab is always known to the restore gate; opened in the same batch as its cookie rules.
    if (this.restore.clearSync(tabId)) keys.push(RESTORE_KEY);
    const ok = await this.rules.invalidate(...keys);
    if (!ok || !this.rules.isInstalled(containerId)) {
      await this.tabs.delete(tabId);
      await this.rules.invalidate(...keys);
      throw new ContainerError('could not install the container rules (declarativeNetRequest limit?)');
    }
    const activeAt = Date.now();
    await write;
    await this.tabs.update(tabId, { activeSince: activeAt });
    const origin = networkOrigin(tab.url ?? tab.pendingUrl);
    if (origin) void this.swPolicy.noteContainerOrigin(origin);
    this.log('info', `tab ${tabId} -> ${containerId}`);
    this.events.emit({ type: 'tab-assigned', tabId, containerId });
    this.restore.afterAssign(tabId);
    return activeAt;
  }

  private async unassign(tabId: number): Promise<void> {
    const rec = this.tabs.get(tabId);
    if (!rec) return;
    await this.tabs.delete(tabId);
    await this.rules.invalidate(rec.containerId);
    this.log('info', `tab ${tabId} left ${rec.containerId}`);
    this.events.emit({ type: 'tab-unassigned', tabId, containerId: rec.containerId });
  }

  /**
   * A new tab at about:blank, returned once that initial page has COMMITTED. `tabs.create` returns while the blank
   * load is still pending; a `tabs.update({ url })` issued meanwhile starts its request, and then the blank page
   * commits over it: the tab stays blank ("unloaded") although the request succeeded.
   */
  private async createBlankTab(props: { active?: boolean; windowId?: number; index?: number; pinned?: boolean }): Promise<{ id?: number }> {
    const tab = await this.b.tabs.create({ ...props, url: 'about:blank' });
    const id = tab.id;
    if (id === undefined) return tab;
    const committed = () => this.blankCommitted.has(id);
    if (!committed()) {
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          this.blankWaiters.delete(wake);
          resolve();
        };
        const wake = () => {
          if (committed()) finish();
        };
        const timer = setTimeout(() => {
          this.log('warn', `tab ${id}: about:blank did not commit in time`);
          finish();
        }, BLANK_COMMIT_WAIT_MS);
        this.blankWaiters.add(wake);
      });
    }
    this.blankCommitted.delete(id);
    return tab;
  }

  /** New tab at about:blank (no network), into the container, then navigated: the first request is already isolated. */
  async openInContainer(url: string, ref: ContainerId, options: InternalOpenOptions = {}): Promise<number> {
    await this.ready;
    if (!isHttpUrl(url)) throw new ContainerError('only http(s) URLs can be opened in a container');
    const container = this.containers.resolve(ref);
    if (!container) throw new ContainerError(`no container "${ref}"`);
    const tab = await this.createBlankTab({
      active: options.active ?? true,
      ...(options.windowId !== undefined ? { windowId: options.windowId } : {}),
      ...(options.index !== undefined ? { index: options.index } : {}),
      ...(options.pinned ? { pinned: true } : {}),
    });
    if (tab.id === undefined) throw new ContainerError('tab creation failed');
    try {
      await this.assign(tab.id, container.id);
    } catch (error) {
      await this.b.tabs.remove(tab.id).catch(() => {});
      throw error;
    }
    options.onAssigned?.(tab.id);
    if (options.openerTabId !== undefined) await this.b.tabs.update(tab.id, { openerTabId: options.openerTabId }).catch(() => {});
    await this.prepareNavigation(url);
    await this.b.tabs.update(tab.id, { url });
    return tab.id;
  }

  /**
   * Moves a tab to `containerId` (null: a plain tab) by opening `url` in a FRESH tab at the same place and returning
   * its ID; the caller closes `tabId` afterwards. The old document may be scripted by another context (its opener, a
   * popup parent, a frame that kept a reference), and a document that stays alive keeps that link: the opener of a
   * tab that a domain rule moves into a container would read the container's cookies and storage through its
   * `WindowProxy`. The new tab is created with `tabs.create` (no `window.opener`; `openerTabId` is not passed). Done
   * for every such move, whether Facet can see an opener or not (a popup's opener is not always visible). Nothing is
   * created when the tab is gone or the container rules cannot be installed.
   */
  async replaceTab(tabId: number, containerId: ContainerId | null, url: string, onCreated?: (newTabId: number) => void): Promise<number> {
    await this.ready;
    if (!isHttpUrl(url)) throw new ContainerError('only http(s) URLs can be opened in a container');
    const old = await this.b.tabs.get(tabId);
    const place = {
      active: old.active,
      windowId: old.windowId,
      index: old.index,
      ...(old.pinned ? { pinned: true } : {}),
    };
    if (containerId !== null) return this.openInContainer(url, containerId, { ...place, ...(onCreated ? { onAssigned: onCreated } : {}) });
    const tab = await this.createBlankTab(place);
    if (tab.id === undefined) throw new ContainerError('tab creation failed');
    await this.restore.clear(tab.id);
    onCreated?.(tab.id);
    await this.b.tabs.update(tab.id, { url });
    return tab.id;
  }

  getJar(containerId: ContainerId): Cookie[] {
    return this.containers.get(containerId) ? this.containers.jar(containerId).all() : [];
  }

  // ---------------------------------------------------------------- webRequest

  /**
   * `webRequest.onBeforeRequest` for frames: remembers who started each main-frame navigation (for `#ctr=`), and the
   * sites a container tab loads frames from, so their beacon answers (page keys) are installed before the frames'
   * content scripts ask.
   */
  handleBeforeRequest(details: WebRequestDetails): void {
    if (details.tabId < 0) return;
    if (details.type === 'main_frame') {
      void this.ready.then(() => this.restore.mainFrameRequest(details.tabId, details.url));
      const list = (this.mainFrameStarts.get(details.tabId) ?? []).filter((s) => details.timeStamp - s.at < 10_000);
      list.push({ url: withoutFragment(details.url), initiator: details.initiator, at: details.timeStamp });
      this.mainFrameStarts.set(details.tabId, list.slice(-8));
      for (const wake of [...this.mainFrameWaiters]) wake();
    }
    const site = siteOfFrameUrl(details.url);
    if (!site) return;
    void this.ready.then(() => {
      const rec = this.tabs.get(details.tabId);
      if (!rec) return;
      void this.addFrameSite(details.tabId, rec.containerId, site, details.type === 'main_frame');
    });
  }

  /**
   * Adds a frame site to a container tab; resolves once the container's beacon answers cover it. `force`: a frame
   * reported the answer missing, recompile even if the site looks covered.
   */
  private addFrameSite(tabId: number, containerId: ContainerId, site: string, topLevel = false, force = false): Promise<boolean> {
    // Already covered by the installed rules (some tab of the container is on that site)?
    const known = this.tabs.tabsOf(containerId).some((t) => this.frameSites.get(t)?.has(site) || siteOfFrameUrl(this.tabs.get(t)?.url) === site);
    // A new top-level navigation starts the tab's list afresh (sites dropped here leave the rules at the next recompile).
    const set = topLevel ? new Set<string>() : (this.frameSites.get(tabId) ?? new Set<string>());
    this.frameSites.set(tabId, set);
    set.add(site);
    if (set.size > MAX_FRAME_SITES_PER_TAB) set.delete(set.values().next().value!);
    if (known && !force && this.rules.isInstalled(containerId)) return this.rules.sync();
    return this.rules.invalidate(containerId);
  }

  handleSendHeaders(details: WebRequestDetails): void {
    if (details.tabId < 0) return;
    const cookie = cookieHeaderOf(details.requestHeaders);
    this.sends.set(details.requestId, { tabId: details.tabId, sentAt: details.timeStamp, cookie });
    if (this.sends.size > 5_000) {
      // Requests that never reported completion: forget the old ones.
      const cutoff = details.timeStamp - 120_000;
      for (const [id, rec] of this.sends) if (rec.sentAt < cutoff) this.sends.delete(id);
    }
    if (details.type !== 'main_frame') return;
    const send: MainFrameSend = {
      requestId: details.requestId,
      tabId: details.tabId,
      url: details.url,
      method: details.method,
      sentAt: details.timeStamp,
      cookie,
    };
    void this.ready.then(() => {
      for (const r of this.detector.noteSend(send)) this.renavigate(r);
    });
  }

  /** True when every cookie in a sent header exists in the container jar: the request went out under its rules. */
  private headerFromJar(containerId: ContainerId, header: string | null): boolean {
    const pairs = parseCookieHeader(header);
    if (pairs.length === 0) return true;
    const jar = this.containers.jar(containerId).all();
    return pairs.every(([name, value]) => jar.some((c) => c.name === name && c.value === value));
  }

  handleRequestDone(details: { requestId: string; tabId?: number; url?: string; type?: string; error?: string }): void {
    this.sends.delete(details.requestId);
    if (details.error !== undefined && details.tabId !== undefined && details.url !== undefined) {
      const failed = { tabId: details.tabId, url: details.url, type: details.type, error: details.error };
      void this.ready.then(() => this.restore.requestFailed(failed));
    }
    const deferred = this.deferredRenavs.get(details.requestId);
    if (deferred) {
      this.deferredRenavs.delete(details.requestId);
      clearTimeout(deferred.timer);
      void this.navigateAgain(deferred.renav);
    }
  }

  /** onHeadersReceived and onBeforeRedirect: harvest Set-Cookie of container tabs into their jar. */
  handleResponse(details: WebRequestDetails): void {
    if (details.tabId < 0) return;
    const key = `${details.requestId}|${details.url}|${details.statusCode ?? ''}`;
    const now = Date.now();
    if (this.harvested.has(key)) return;
    this.harvested.set(key, now);
    if (this.harvested.size > 2000) for (const [k, at] of this.harvested) if (now - at > 60_000) this.harvested.delete(k);
    const headers = setCookieHeaders(details.responseHeaders);
    // Capture the trust decision inputs now: the send record is gone once the request completes.
    const send = this.sends.get(details.requestId);
    void this.ready.then(() => this.harvest(details, headers, send));
  }

  private harvest(details: WebRequestDetails, headers: string[], send: SendRecord | undefined): void {
    const rec = this.tabs.get(details.tabId);
    if (!rec) return;
    this.noteResponse(details.tabId, details.url);
    if (headers.length === 0) return;
    const containerId = rec.containerId;
    // A request that went out before the tab's rules applied carried the real profile's cookies: never import its
    // answer. Shortly after the assignment Chrome may still apply the old (no) rules, so frames whose sent Cookie
    // header is known must also carry nothing but container cookies. (Later on, a header with an already rotated
    // value is normal and must not cost the response its Set-Cookie.)
    const sentAt = send?.sentAt ?? details.timeStamp;
    const foreign =
      rec.activeSince === null ||
      sentAt < rec.activeSince ||
      (send !== undefined && sentAt < rec.activeSince + ASSIGNMENT_LAG_MS && !this.headerFromJar(containerId, send.cookie));
    if (foreign) {
      this.log('warn', `ignored ${headers.length} Set-Cookie of a request sent outside the container's rules`, details.url);
      return;
    }
    const jar = this.containers.jar(containerId);
    const topLevelSite = details.type === 'main_frame' ? siteOfHttp(details.url) : rec.topLevelSite;
    const now = Date.now();
    const changes: CookieChange[] = [];
    for (const header of headers) {
      const { parsed, outcome } = jar.setFromHeader(header, { url: details.url, now, topLevelSite });
      if (parsed.ok && CHANGED.has(outcome)) changes.push(toChange(parsed.cookie, outcome));
    }
    if (changes.length === 0) return;
    this.containers.touchJar(containerId);
    this.track(containerId, this.afterJarChange(containerId, details.timeStamp, changes));
  }

  /** Install the new rules, then repair navigations that raced them and refresh the pages' document.cookie view. */
  private async afterJarChange(containerId: ContainerId, from: number, changes: CookieChange[]): Promise<void> {
    await this.rules.invalidate(containerId);
    const until = Date.now();
    for (const r of this.detector.noteChange({ containerId, from, until, changes })) this.renavigate(r);
    this.pushCookies(containerId, new Set(changes.map((c) => beaconSiteOf(c.domain))));
  }

  private track(containerId: ContainerId, work: Promise<void>): void {
    let set = this.pendingWork.get(containerId);
    if (!set) this.pendingWork.set(containerId, (set = new Set()));
    const guarded = work.catch((error) => this.log('error', 'jar update failed', String(error)));
    set.add(guarded);
    void guarded.finally(() => set!.delete(guarded));
  }

  private noteResponse(tabId: number, url: string): void {
    const now = Date.now();
    const list = (this.recentResponses.get(tabId) ?? []).filter((r) => now - r.at < 3_000);
    list.push({ url, at: now });
    this.recentResponses.set(tabId, list.slice(-50));
  }

  /** Repeats a navigation that went out with outdated cookies, once its stale request has finished. */
  private renavigate(r: Renavigation): void {
    if (!this.tabs.get(r.tabId) || this.deferredRenavs.has(r.requestId)) return;
    this.log('info', `re-navigating tab ${r.tabId} (${r.reason})`, r.url);
    if (!this.sends.has(r.requestId)) {
      void this.navigateAgain(r);
      return;
    }
    const timer = setTimeout(() => {
      this.deferredRenavs.delete(r.requestId);
      void this.navigateAgain(r);
    }, 3_000);
    this.deferredRenavs.set(r.requestId, { renav: r, timer });
  }

  private async navigateAgain(r: Renavigation): Promise<void> {
    // The user (or the page) navigated somewhere else meanwhile: leave the tab alone.
    const latest = this.detector.latestSend(r.tabId);
    if (latest && latest.requestId !== r.requestId) return;
    if (!this.tabs.get(r.tabId)) return;
    await this.prepareNavigation(r.url);
    await this.b.tabs.update(r.tabId, { url: r.url }).catch(() => {});
  }

  /** Sends the script-visible cookies of `sites` to every frame of every tab of the container. */
  private pushCookies(containerId: ContainerId, sites: Set<string>): void {
    const jar = this.containers.jar(containerId);
    const now = Date.now();
    for (const tabId of this.tabs.tabsOf(containerId)) {
      const visible = scriptVisibleCookies(jar, this.tabs.get(tabId)?.topLevelSite ?? null, now);
      const payload: Record<string, Cookie[]> = {};
      for (const site of sites) payload[site] = visible.filter((c) => beaconSiteOf(c.domain) === site);
      void this.b.tabs.sendMessage(tabId, { type: 'facet/cookies', sites: payload }).catch(() => {});
    }
  }

  private siteSnapshot(containerId: ContainerId, host: string, topLevelSite: string | null): Cookie[] {
    const site = beaconSiteOf(host);
    return scriptVisibleCookies(this.containers.jar(containerId), topLevelSite, Date.now()).filter((c) => beaconSiteOf(c.domain) === site);
  }

  // ---------------------------------------------------------------- tabs & navigation events

  /**
   * `openerTabId` is also set for tabs the user opens next to the active tab (Ctrl+T, bookmarks, omnibox Alt+Enter,
   * tabs created over CDP): those must NOT inherit. Here only the shim's own `about:blank#facet-<nonce>` child does
   * (early, before its navigation). Other page-initiated opens (links, `window.open` without the shim, context menu
   * "Open link in new tab") come through `webNavigation.onCreatedNavigationTarget`, which Chrome fires only for
   * navigations a page started.
   */
  handleTabCreated(tab: Browser.tabs.Tab): void {
    void this.ready.then(() => this.restore.tabCreated(tab));
    if (tab.id === undefined || tab.openerTabId === undefined) return;
    const url = tab.pendingUrl ?? tab.url ?? '';
    if (!CHILD_NONCE.test(url)) return;
    void this.inherit(tab.id, tab.openerTabId, url);
  }

  handleCreatedNavigationTarget(details: { sourceTabId: number; tabId: number; url: string }): void {
    void this.inherit(details.tabId, details.sourceTabId, details.url);
  }

  private async inherit(child: number, parent: number, url: string | undefined): Promise<void> {
    await this.ready;
    const nonce = url ? CHILD_NONCE.exec(url)?.[1] : undefined;
    if (nonce) this.childNonces.set(child, nonce);
    const existing = this.tabs.get(child);
    if (existing) {
      if (existing.activeSince !== null) this.childReady(parent, child);
      return;
    }
    if (this.inheriting.has(child)) return;
    const parentRec = this.tabs.get(parent);
    if (!parentRec) {
      // A plain page opened it: not a restored tab, whatever its address.
      this.restore.pageOpened(child);
      return;
    }
    if (url && /^(chrome|chrome-extension|devtools):/i.test(url)) return;
    this.inheriting.add(child);
    try {
      const containerId = parentRec.containerId;
      const activeAt = await this.assign(child, containerId);
      for (const r of this.detector.noteAssignment(child, activeAt, (send) => !this.headerFromJar(containerId, send.cookie))) {
        this.renavigate(r);
      }
      this.childReady(parent, child);
    } catch (error) {
      this.log('error', `tab ${child} could not inherit ${parentRec.containerId}`, String(error));
    } finally {
      this.inheriting.delete(child);
    }
  }

  private childReady(parent: number | undefined, child: number): void {
    const nonce = this.childNonces.get(child);
    let index = nonce ? this.childWaiters.findIndex((w) => w.nonce === nonce) : -1;
    if (index === -1 && parent !== undefined) index = this.childWaiters.findIndex((w) => w.parent === parent);
    if (index !== -1) {
      const [waiter] = this.childWaiters.splice(index, 1);
      waiter!.resolve(child);
      return;
    }
    const now = Date.now();
    for (let i = this.readyChildren.length - 1; i >= 0; i--) if (now - this.readyChildren[i]!.at > READY_CHILD_TTL_MS) this.readyChildren.splice(i, 1);
    this.readyChildren.push({ parent, child, nonce, at: now });
  }

  private awaitChild(parent: number, nonce: string): Promise<number | null> {
    const now = Date.now();
    let index = this.readyChildren.findIndex((c) => c.nonce === nonce && now - c.at <= READY_CHILD_TTL_MS);
    if (index === -1) index = this.readyChildren.findIndex((c) => c.parent === parent && c.nonce === undefined && now - c.at <= READY_CHILD_TTL_MS);
    if (index !== -1) {
      const [ready] = this.readyChildren.splice(index, 1);
      return Promise.resolve(ready!.child);
    }
    return new Promise((resolve) => {
      const waiter: ChildWaiter = { parent, nonce, resolve };
      this.childWaiters.push(waiter);
      setTimeout(() => {
        const i = this.childWaiters.indexOf(waiter);
        if (i !== -1) {
          this.childWaiters.splice(i, 1);
          resolve(null);
        }
      }, AWAIT_CHILD_TIMEOUT_MS);
    });
  }

  handleTabRemoved(tabId: number, info: { isWindowClosing?: boolean } = {}): void {
    void this.ready.then(() => this.restore.tabRemoved(tabId, info.isWindowClosing === true));
    this.childNonces.delete(tabId);
    this.recentResponses.delete(tabId);
    this.frameSites.delete(tabId);
    this.mainFrameStarts.delete(tabId);
    this.blankCommitted.delete(tabId);
    void this.ready.then(() => this.unassign(tabId));
  }

  handleTabReplaced(addedTabId: number, removedTabId: number): void {
    void this.ready.then(async () => {
      this.restore.tabReplaced(addedTabId, removedTabId);
      const rec = this.tabs.get(removedTabId);
      if (!rec) return;
      await this.tabs.delete(removedTabId);
      await this.tabs.set(addedTabId, rec);
      await this.rules.invalidate(rec.containerId);
      this.events.emit({ type: 'tab-replaced', added: addedTabId, removed: removedTabId });
    });
  }

  handleBeforeNavigate(details: { tabId: number; frameId: number; url: string; timeStamp?: number }): void {
    if (details.tabId < 0) return;
    void this.ready.then(async () => {
      if (details.frameId === 0 && ctrMarkerRef(details.url) !== null) {
        const containerId = await this.ctrDecision(details);
        if (containerId !== null) {
          await this.applyCtrMarker(details.tabId, details.url, containerId);
          return;
        }
      }
      if (!this.tabs.get(details.tabId)) return;
      const origin = networkOrigin(details.url);
      if (origin) void this.swPolicy.noteContainerOrigin(origin);
    });
  }

  /**
   * `https://site/#ctr=<name or id>`: which EXISTING container the navigation asks for, or null when it must be
   * ignored. Honoured only for a tab without a container, on a navigation the browser or an extension started
   * (address bar, bookmark, an agent over CDP: no `initiator` in `webRequest`; `tabs.update` from an extension:
   * `initiator` is that extension's `chrome-extension://` origin). A page cannot
   * use it, neither by setting `location.hash` (same-document, no request at all) nor by navigating itself or a
   * child to a marked URL (it would be the initiator). Unknown names are ignored too (creating containers stays with
   * `open.html`, which pages cannot reach). One decision per navigation, shared with the domain-rule engine.
   */
  ctrDecision(details: { tabId: number; frameId: number; url: string; timeStamp?: number }): Promise<ContainerId | null> {
    const ref = details.frameId === 0 && isHttpUrl(details.url) ? ctrMarkerRef(details.url) : null;
    if (ref === null || details.tabId < 0) return Promise.resolve(null);
    const now = Date.now();
    for (const [key, entry] of this.ctrDecisions) if (now - entry.at > 10_000) this.ctrDecisions.delete(key);
    // Per navigation (both onBeforeNavigate listeners see the same event), never reused by a later navigation.
    const key = `${details.tabId} ${details.timeStamp ?? now} ${details.url}`;
    const cached = this.ctrDecisions.get(key);
    if (cached) return cached.decision;
    const decision = (async (): Promise<ContainerId | null> => {
      await this.ready;
      if (this.tabs.get(details.tabId)) {
        this.log('warn', `#ctr marker ignored: tab ${details.tabId} is already in a container`);
        return null;
      }
      const container = this.containers.resolve(ref);
      if (!container) {
        this.log('warn', `#ctr marker names no container: ${ref}`);
        return null;
      }
      const start = await this.mainFrameStart(details.tabId, details.url, details.timeStamp ?? now);
      if (!start) {
        this.log('warn', `#ctr marker ignored: no request seen for the navigation in tab ${details.tabId}`);
        return null;
      }
      // No initiator: the browser itself (address bar, bookmark, CDP). An extension origin: an extension's
      // tabs.update (agents such as Claude in Chrome, Facet's own pages); pages cannot borrow that origin.
      if (start.initiator !== undefined && !start.initiator.startsWith('chrome-extension://')) {
        this.log('warn', `#ctr marker ignored: the navigation was started by ${start.initiator}, not by the browser`);
        return null;
      }
      return container.id;
    })();
    this.ctrDecisions.set(key, { at: now, decision });
    return decision;
  }

  /** The main-frame request of a navigation (same URL without fragment, started at or after `since`). */
  private async mainFrameStart(tabId: number, url: string, since: number): Promise<MainFrameStart | null> {
    const target = withoutFragment(url);
    const find = () => (this.mainFrameStarts.get(tabId) ?? []).filter((s) => s.url === target && s.at >= since - 50).at(-1) ?? null;
    const found = find();
    if (found) return found;
    return new Promise((resolve) => {
      const done = (value: MainFrameStart | null) => {
        clearTimeout(timer);
        this.mainFrameWaiters.delete(wake);
        resolve(value);
      };
      const wake = () => {
        const hit = find();
        if (hit) done(hit);
      };
      const timer = setTimeout(() => done(find()), CTR_INITIATOR_WAIT_MS);
      this.mainFrameWaiters.add(wake);
    });
  }

  /** Assign the tab to the marker's container, drop the marker, navigate again (workers of the origin removed first). */
  private async applyCtrMarker(tabId: number, url: string, containerId: ContainerId): Promise<void> {
    const hashAt = url.indexOf('#');
    const fragment = url.slice(hashAt + 1);
    const rest = fragment.replace(CTR_MARKER, '').replace(/^&/, '');
    const clean = url.slice(0, hashAt) + (rest ? `#${rest}` : '');
    try {
      this.detector.suppress(tabId);
      await this.assign(tabId, containerId);
      await this.prepareNavigation(clean);
      await this.b.tabs.update(tabId, { url: clean });
      this.log('info', `#ctr marker put tab ${tabId} into ${containerId}`);
    } catch (error) {
      this.log('error', '#ctr marker failed', String(error));
    }
  }

  handleCommitted(details: { tabId: number; frameId: number; url: string }): void {
    if (details.tabId < 0) return;
    if (details.frameId === 0 && details.url === 'about:blank') {
      this.blankCommitted.add(details.tabId);
      for (const wake of [...this.blankWaiters]) wake();
    }
    void this.ready.then(async () => {
      const rec = this.tabs.get(details.tabId);
      if (details.frameId === 0) this.restore.tabCommitted(details.tabId, details.url, rec?.containerId);
      if (!rec) return;
      const nonce = CHILD_NONCE.exec(details.url)?.[1];
      if (nonce && rec.activeSince !== null) {
        // A named window reused by window.open: no new tab, but the waiter is keyed by nonce.
        this.childNonces.set(details.tabId, nonce);
        this.childReady(undefined, details.tabId);
      }
      const origin = networkOrigin(details.url);
      if (origin) void this.swPolicy.noteContainerOrigin(origin);
      if (details.frameId !== 0) return;
      const site = siteOfHttp(details.url);
      if (site === rec.topLevelSite) {
        if (rec.url !== details.url) void this.tabs.update(details.tabId, { url: details.url });
        return;
      }
      await this.tabs.update(details.tabId, { topLevelSite: site, url: details.url });
      if (this.containers.jar(rec.containerId).all().some((c) => c.partitioned)) await this.rules.invalidate(rec.containerId);
    });
  }

  handleTabAttached(tabId: number, windowId: number): void {
    void this.ready.then(() => {
      if (this.tabs.get(tabId)) void this.tabs.update(tabId, { windowId });
    });
  }

  /**
   * Chrome wipes session rules and `storage.session` when the extension is updated or reloaded, which would turn
   * open container tabs into real-profile tabs. Put back every tab that is still the same tab (id, window and URL
   * match the `storage.local` backup), then reload it so it gets fresh content scripts.
   */
  async handleInstalled(reason: string): Promise<void> {
    await this.ready;
    await this.strict.installed(reason).catch((error) => this.log('error', 'strict mode after install failed', String(error)));
    if (reason !== 'update') return;
    const backup = await this.tabs.loadBackup();
    if (backup.size === 0 || this.tabs.entries().length > 0) return;
    const restored: number[] = [];
    for (const [tabId, rec] of backup) {
      if (!this.containers.get(rec.containerId)) continue;
      const tab = await this.b.tabs.get(tabId).catch(() => null);
      // Same tab ID and window, and still on the same origin (pushState may have changed the path). The origin check
      // guards against tab IDs reused after a browser restart in case the update is applied during startup.
      if (!tab || tab.windowId !== rec.windowId) continue;
      if (rec.url !== undefined && networkOrigin(tab.url) !== networkOrigin(rec.url)) continue;
      void this.tabs.set(tabId, { ...rec, activeSince: null });
      restored.push(tabId);
    }
    if (restored.length === 0) return;
    const ok = await this.rules.invalidate(...new Set(restored.map((id) => this.tabs.containerOf(id)!)));
    const now = Date.now();
    for (const tabId of restored) {
      if (!ok) await this.tabs.delete(tabId);
      else {
        await this.tabs.update(tabId, { activeSince: now });
        this.events.emit({ type: 'tab-assigned', tabId, containerId: this.tabs.containerOf(tabId)! });
      }
      await this.prepareNavigation((await this.b.tabs.get(tabId).catch(() => null))?.url);
      await this.b.tabs.reload(tabId).catch(() => {});
    }
    this.log('info', `restored ${restored.length} container tabs after an update`);
  }

  /** `chrome.sessions.onChanged`: a tab or window was closed or reopened. */
  handleSessionsChanged(): void {
    void this.ready.then(() => this.restore.sessionsChanged());
  }

  /** Tabs moved, grouped, regrouped, pinned or navigated: the restore snapshot follows. */
  handleLayoutChanged(): void {
    void this.ready.then(() => this.restore.scheduleSnapshot());
  }

  handleGroupRemoved(groupId: number): void {
    void this.ready.then(() => this.restore.groupRemoved(groupId));
  }

  /** Browser start: tab IDs from the last session mean nothing now. */
  handleStartup(): void {
    void this.tabs.clearBackup();
    void this.ready.then(() => this.strict.startup());
  }

  async handleAlarm(name: string): Promise<void> {
    if (name !== PURGE_ALARM) return;
    await this.ready;
    for (const container of this.containers.list()) {
      if (this.containers.jar(container.id).purgeExpired() === 0) continue;
      this.containers.touchJar(container.id);
      if (this.tabs.tabsOf(container.id).length > 0) await this.rules.invalidate(container.id);
    }
  }

  handleSuspend(): void {
    void this.containers.flush();
    // A restore change that is still waiting for its timer is written now.
    this.restore.flushPending();
  }

  // ---------------------------------------------------------------- content-script messages

  async handleContentMessage(message: { type: string; [key: string]: unknown }, sender: MessageSender): Promise<unknown> {
    await this.ready;
    const tabId = sender.tab?.id;
    if (tabId === undefined || tabId < 0) return { ok: false };
    const rec = this.tabs.get(tabId);
    switch (message.type) {
      case 'facet/ping':
        return { ok: true };
      case 'facet/cookie-write':
        return this.cookieWrite(tabId, sender, String(message.value ?? ''), String(message.path ?? '/'), Number(message.at));
      case 'facet/cookie-snapshot': {
        const host = senderHost(sender);
        if (!rec || !host) return { ok: false } satisfies CookieSnapshotReply;
        return { ok: true, cookies: this.siteSnapshot(rec.containerId, host, rec.topLevelSite) } satisfies CookieSnapshotReply;
      }
      case 'facet/settle':
        await this.settle(tabId, String(message.url ?? ''), String(message.method ?? 'GET'));
        return { ok: true };
      case 'facet/await-child': {
        if (!rec) return { ok: false };
        const nonce = String(message.nonce ?? '');
        if (!/^[a-z0-9]{6,32}$/.test(nonce)) return { ok: false };
        const child = await this.awaitChild(tabId, nonce);
        if (child === null) return { ok: false };
        // The shim navigates the child once we answer: no service worker of the target may answer that request.
        if (typeof message.url === 'string') await this.prepareNavigation(message.url);
        return { ok: true, tabId: child };
      }
      case 'facet/need-site': {
        // The beacon of a frame got the generic answer: its site has no beacon rule yet. Add it; the beacon polls.
        const site = siteOfFrameUrl(senderOrigin(sender) ?? undefined);
        if (!rec || !site) return { ok: false };
        this.log('info', `beacon answer for ${site} asked by a frame of tab ${tabId}`);
        return { ok: await this.addFrameSite(tabId, rec.containerId, site, false, true) };
      }
      case 'facet/open-tab': {
        if (!rec) return { ok: false };
        const url = String(message.url ?? '');
        if (!isHttpUrl(url)) return { ok: false };
        const childId = await this.openInContainer(url, rec.containerId, {
          active: message.active !== false,
          openerTabId: tabId,
          windowId: sender.tab?.windowId,
          index: sender.tab?.index !== undefined ? sender.tab.index + 1 : undefined,
        });
        return { ok: true, tabId: childId };
      }
      default:
        return { ok: false };
    }
  }

  private async cookieWrite(tabId: number, sender: MessageSender, value: string, path: string, at: number): Promise<CookieSnapshotReply> {
    const rec = this.tabs.get(tabId);
    const origin = senderOrigin(sender);
    if (!rec || rec.activeSince === null || !origin) return { ok: false };
    const host = hostnameOf(new URL(origin).hostname);
    const jar = this.containers.jar(rec.containerId);
    const now = Date.now();
    const { parsed, outcome } = jar.applyDocumentCookieWrite(host, value, {
      secure: isSecureUrl(`${origin}/`),
      path: path.startsWith('/') ? path : '/',
      topLevelSite: rec.topLevelSite,
      now,
    });
    if (parsed.ok && CHANGED.has(outcome)) {
      this.containers.touchJar(rec.containerId);
      const from = Number.isFinite(at) ? Math.min(now, Math.max(now - 5_000, at)) : now;
      const work = this.afterJarChange(rec.containerId, from, [toChange(parsed.cookie, outcome)]);
      this.track(rec.containerId, work);
      await work; // the reply doubles as the shim's fetch barrier: rules carry the cookie from here on
    }
    return { ok: true, cookies: this.siteSnapshot(rec.containerId, host, rec.topLevelSite) };
  }

  /** Fetch barrier: wait until the response's Set-Cookie (if any) reached the container's rules. */
  private async settle(tabId: number, url: string, method: string): Promise<void> {
    const rec = this.tabs.get(tabId);
    if (!rec) return;
    if (method.toUpperCase() !== 'GET') {
      const deadline = Date.now() + SETTLE_WAIT_MS;
      while (!this.recentResponses.get(tabId)?.some((r) => r.url === url) && Date.now() < deadline) await sleep(5);
    }
    await new Promise((resolve) => setTimeout(resolve, 0)); // let queued webRequest events run first
    await Promise.all([...(this.pendingWork.get(rec.containerId) ?? [])]);
    await this.rules.sync();
  }
}

function senderOrigin(sender: MessageSender): string | null {
  const candidate = sender.origin ?? (sender.url ? safeOrigin(sender.url) : null);
  if (!candidate || candidate === 'null') return null;
  return /^https?:\/\//.test(candidate) ? candidate : null;
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function senderHost(sender: MessageSender): string | null {
  const origin = senderOrigin(sender);
  return origin ? hostnameOf(new URL(origin).hostname) : null;
}
