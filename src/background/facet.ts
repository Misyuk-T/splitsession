import { browser, type Browser } from 'wxt/browser';
import {
  beaconSiteOf,
  compileGroupRules,
  hostnameOf,
  isSecureUrl,
  scriptVisibleCookies,
  siteOf,
  type CompiledRules,
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
import { ServiceWorkerPolicy, type BrowsingDataApi, type DnrDynamicApi } from '../engine/sw-policy';
import { FacetEvents } from './events';
import { createLogger, type Logger } from './log';

export const PURGE_ALARM = 'facet-purge';
/** `about:blank#facet-<nonce>`: how the shim marks the blank child it opens before navigating it. */
export const CHILD_NONCE = /#facet-([a-z0-9]{6,32})$/;
const CTR_MARKER = /(?:^|&)ctr=([^&]*)/;
const AWAIT_CHILD_TIMEOUT_MS = 1_000;
const READY_CHILD_TTL_MS = 2_000;
const SETTLE_WAIT_MS = 60;
/** How long after `updateSessionRules` resolved a request may still have been set up with the previous rules. */
const ASSIGNMENT_LAG_MS = 1_000;

type WebRequestDetails = {
  requestHeaders?: Array<{ name: string; value?: string }>;
  requestId: string;
  url: string;
  method: string;
  tabId: number;
  type: string;
  frameId: number;
  timeStamp: number;
  statusCode?: number;
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

interface ReadyChild {
  parent: number | undefined;
  child: number;
  nonce: string | undefined;
  at: number;
}

const isHttpUrl = (url: string | undefined): url is string => !!url && /^https?:\/\//i.test(url);
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
  readonly detector: StaleNavigationDetector;
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
      { log: this.log },
    );
    this.detector = new StaleNavigationDetector({ containerOf: (tabId) => this.tabs.containerOf(tabId) });
  }

  start(): Promise<void> {
    this.ready = this.rehydrate();
    return this.ready;
  }

  private async rehydrate(): Promise<void> {
    await Promise.all([this.containers.load(), this.tabs.load()]);
    const liveTabs = new Set((await this.b.tabs.query({})).map((t) => t.id).filter((id): id is number => id !== undefined));
    const now = Date.now();
    for (const [tabId, rec] of this.tabs.entries()) {
      if (!liveTabs.has(tabId) || !this.containers.get(rec.containerId)) void this.tabs.delete(tabId);
      else if (rec.activeSince === null) void this.tabs.update(tabId, { activeSince: now });
    }
    const ok = await this.rules.reset(this.tabs.containerIds());
    if (!ok) this.log('error', 'could not reinstall session rules after start');
    await Promise.allSettled([
      this.swPolicy.load(),
      ensureContentScripts(this.b.scripting as unknown as ScriptingApi).then((r) => this.log('info', `content scripts ${r}`)),
      this.b.alarms.create(PURGE_ALARM, { periodInMinutes: 1 }),
    ]);
    this.log('info', `ready: ${this.containers.list().length} containers, ${this.tabs.entries().length} tabs`);
  }

  // ---------------------------------------------------------------- rule compilation

  private compileContainer(containerId: ContainerId, allocator: RuleIdAllocator, regexBudget: number): CompiledRules | null {
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
    for (const [site, group] of groups) {
      const compiled = compileGroupRules(
        {
          tabIds: group.sort((a, b) => a - b),
          containerId,
          containerName: container.name,
          jar,
          topLevelSite: site,
          now,
          regexBudget: Math.max(0, regexBudget - regexRuleCount),
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
    return this.containers.resolve(ref) ?? this.containers.create({ name: ref });
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
    if (containerId === null) {
      await this.unassign(tabId);
    } else {
      this.detector.forgetTab(tabId);
      await this.assign(tabId, containerId);
    }
    if (options.reload) await this.b.tabs.reload(tabId);
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

  /** New tab at about:blank (no network), into the container, then navigated: the first request is already isolated. */
  async openInContainer(url: string, ref: ContainerId, options: OpenOptions = {}): Promise<number> {
    await this.ready;
    if (!isHttpUrl(url)) throw new ContainerError('only http(s) URLs can be opened in a container');
    const container = this.containers.resolve(ref);
    if (!container) throw new ContainerError(`no container "${ref}"`);
    const tab = await this.b.tabs.create({
      url: 'about:blank',
      active: options.active ?? true,
      ...(options.windowId !== undefined ? { windowId: options.windowId } : {}),
      ...(options.index !== undefined ? { index: options.index } : {}),
    });
    if (tab.id === undefined) throw new ContainerError('tab creation failed');
    try {
      await this.assign(tab.id, container.id);
    } catch (error) {
      await this.b.tabs.remove(tab.id).catch(() => {});
      throw error;
    }
    if (options.openerTabId !== undefined) await this.b.tabs.update(tab.id, { openerTabId: options.openerTabId }).catch(() => {});
    await this.b.tabs.update(tab.id, { url });
    return tab.id;
  }

  getJar(containerId: ContainerId): Cookie[] {
    return this.containers.get(containerId) ? this.containers.jar(containerId).all() : [];
  }

  // ---------------------------------------------------------------- webRequest

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

  handleRequestDone(details: { requestId: string }): void {
    this.sends.delete(details.requestId);
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
    if (!parentRec) return;
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

  handleTabRemoved(tabId: number): void {
    this.childNonces.delete(tabId);
    this.recentResponses.delete(tabId);
    void this.ready.then(() => this.unassign(tabId));
  }

  handleTabReplaced(addedTabId: number, removedTabId: number): void {
    void this.ready.then(async () => {
      const rec = this.tabs.get(removedTabId);
      if (!rec) return;
      await this.tabs.delete(removedTabId);
      await this.tabs.set(addedTabId, rec);
      await this.rules.invalidate(rec.containerId);
      this.events.emit({ type: 'tab-replaced', added: addedTabId, removed: removedTabId });
    });
  }

  handleBeforeNavigate(details: { tabId: number; frameId: number; url: string }): void {
    if (details.tabId < 0) return;
    void this.ready.then(async () => {
      if (details.frameId === 0 && (await this.handleCtrMarker(details.tabId, details.url))) return;
      if (!this.tabs.get(details.tabId)) return;
      const origin = networkOrigin(details.url);
      if (origin) void this.swPolicy.noteContainerOrigin(origin);
    });
  }

  handleFragmentUpdated(details: { tabId: number; frameId: number; url: string }): void {
    if (details.tabId < 0 || details.frameId !== 0) return;
    void this.ready.then(() => this.handleCtrMarker(details.tabId, details.url));
  }

  /**
   * `https://site/#ctr=<name or id>`: assign the tab to that EXISTING container, drop the marker, navigate again.
   * Unknown names are ignored (the marker can come from any web page's link; creating containers stays with
   * `open.html`, which pages cannot reach).
   */
  private async handleCtrMarker(tabId: number, url: string): Promise<boolean> {
    if (!isHttpUrl(url)) return false;
    const hashAt = url.indexOf('#');
    if (hashAt === -1) return false;
    const fragment = url.slice(hashAt + 1);
    const match = CTR_MARKER.exec(fragment);
    if (!match) return false;
    let ref: string;
    try {
      ref = decodeURIComponent(match[1]!);
    } catch {
      return false;
    }
    const rest = fragment.replace(CTR_MARKER, '').replace(/^&/, '');
    const clean = url.slice(0, hashAt) + (rest ? `#${rest}` : '');
    const container = this.containers.resolve(ref);
    if (!container) {
      this.log('warn', `#ctr marker names no container: ${ref}`);
      return false;
    }
    try {
      this.detector.suppress(tabId);
      await this.assign(tabId, container.id);
      await this.b.tabs.update(tabId, { url: clean });
      this.log('info', `#ctr marker put tab ${tabId} into ${container.id}`);
    } catch (error) {
      this.log('error', '#ctr marker failed', String(error));
    }
    return true;
  }

  handleCommitted(details: { tabId: number; frameId: number; url: string }): void {
    if (details.tabId < 0) return;
    void this.ready.then(async () => {
      const rec = this.tabs.get(details.tabId);
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
    if (reason !== 'update') return;
    await this.ready;
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
      await this.b.tabs.reload(tabId).catch(() => {});
    }
    this.log('info', `restored ${restored.length} container tabs after an update`);
  }

  /** Browser start: tab IDs from the last session mean nothing now. */
  handleStartup(): void {
    void this.tabs.clearBackup();
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
        return child === null ? { ok: false } : { ok: true, tabId: child };
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
