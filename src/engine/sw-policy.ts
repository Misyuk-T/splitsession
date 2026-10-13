import { beaconSiteOf, compileManagedBeaconRule, compileStrictGuardRule, hostnameOf, type DnrRule } from '../core';
import type { StorageAreaLike } from './storage/storage-area';

export const MANAGED_SITES_KEY = 'managedSites';
/** Dynamic rule ID of the "managed origin" beacon answer. */
export const MANAGED_BEACON_RULE_ID = 1;
/** Dynamic rule ID of the strict-mode guard answer `{g:1}` (every frame of every tab). */
export const STRICT_GUARD_RULE_ID = 2;

export interface DnrDynamicApi {
  updateDynamicRules(options: { removeRuleIds?: number[]; addRules?: DnrRule[] }): Promise<void>;
}

export interface BrowsingDataApi {
  /** `origins` omitted: every origin. */
  remove(options: { origins?: string[]; since?: number }, dataToRemove: { serviceWorkers: boolean; cacheStorage?: boolean }): Promise<void>;
}

export interface ServiceWorkerPolicyOptions {
  now?: () => number;
  /** Minimum gap between two background service-worker removals for the same origin (default 30 s). */
  removalThrottleMs?: number;
  /** Minimum gap between two removals before SplitSession itself navigates a container tab to the origin (default 2 s). */
  prepareThrottleMs?: number;
  log?: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
  /** Called after the managed set grew (the engine recompiles its no-tab rule). */
  onSitesChanged?: () => void;
  /** Called after the strict guard was switched on or off (the engine recompiles its no-tab rules). */
  onGuardChanged?: () => void;
}

/**
 * Service workers versus containers. A worker answers requests of the pages it controls with its own fetches, which
 * belong to no tab (tabId -1): outside every per-tab rule, i.e. with the real profile's cookies, and its responses'
 * `Set-Cookie` lands in the real profile.
 *  - Every site seen inside a container tab becomes "managed": its service workers are removed (`browsingData`,
 *    origin-filtered), and a dynamic DNR rule answers the beacon with `{m:1}` for these sites in tabs WITHOUT a
 *    container, so the shim there refuses `serviceWorker.register` and hides container-namespaced storage. The rule is
 *    dynamic so it survives browser restarts before the worker runs. Only strict mode adds a network block of worker
 *    scripts outside tabs (on every site); a managed-sites-only block broke shared workers' imports in plain tabs.
 *  - `prepare(origin)` is awaited before SplitSession itself navigates a container tab to an origin (open.html, popups,
 *    domain rules, `#ctr=`...): the origin's workers are gone before the first request.
 *  - Strict mode (after consent): `removeAll()` drops every worker of the profile and `setGuard(true)` installs a
 *    global `{g:1}` beacon answer, so the shim refuses registration on every site in every tab; the engine then also
 *    blocks every script request outside tabs (worker scripts), so a realm the shim missed cannot install one either.
 * Cache Storage is deliberately not wiped: it would also erase the containers' own (namespaced) caches.
 */
export class ServiceWorkerPolicy {
  private managed = new Set<string>();
  private readonly lastRemoval = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private ruleWrite: Promise<void> = Promise.resolve();
  private ruleTimer: ReturnType<typeof setTimeout> | null = null;
  private guard = false;
  /** The global beacon answers are wanted (content scripts registered somewhere; `ContentScriptLifecycle`). */
  private beacon = true;
  private readonly now: () => number;
  private readonly throttleMs: number;
  private readonly prepareThrottleMs: number;
  private readonly log: NonNullable<ServiceWorkerPolicyOptions['log']>;
  private readonly onSitesChanged: () => void;
  private readonly onGuardChanged: () => void;

  constructor(
    private readonly area: StorageAreaLike,
    private readonly dnr: DnrDynamicApi,
    private readonly browsingData: BrowsingDataApi,
    options: ServiceWorkerPolicyOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.throttleMs = options.removalThrottleMs ?? 30_000;
    this.prepareThrottleMs = options.prepareThrottleMs ?? 2_000;
    this.log = options.log ?? (() => {});
    this.onSitesChanged = options.onSitesChanged ?? (() => {});
    this.onGuardChanged = options.onGuardChanged ?? (() => {});
  }

  /**
   * Loads the managed sites and writes both dynamic rules (`guard`: strict mode active; `beacon`: false when no content
   * script is registered, so the beacon answers are left out).
   */
  async load(guard = false, beacon = true): Promise<void> {
    const stored = (await this.area.get(MANAGED_SITES_KEY))[MANAGED_SITES_KEY];
    this.managed = new Set(Array.isArray(stored) ? stored.filter((s): s is string => typeof s === 'string') : []);
    this.guard = guard;
    this.beacon = beacon;
    await this.writeRules();
  }

  /**
   * The global beacon answers (`{m:1}`, `{g:1}`) on or off. Off only while no content script is registered: nothing asks
   * then, and a page cannot even learn that SplitSession is installed from the beacon URL.
   */
  async setBeacon(on: boolean): Promise<void> {
    if (this.beacon === on) return this.ruleWrite;
    this.beacon = on;
    await this.writeRules();
  }

  sites(): string[] {
    return [...this.managed].sort();
  }

  isManaged(host: string): boolean {
    return this.managed.has(beaconSiteOf(hostnameOf(host)));
  }

  /**
   * A container tab is about to load / committed `origin`. Marks its site managed and removes the origin's service
   * workers (throttled). Resolves when the removal finished.
   */
  async noteContainerOrigin(origin: string): Promise<void> {
    const parsed = this.parse(origin);
    if (!parsed) return;
    this.markManaged(parsed.site);
    const last = this.lastRemoval.get(parsed.origin);
    if (last !== undefined && this.now() - last < this.throttleMs) return;
    await this.removeOrigin(parsed.origin);
  }

  /**
   * SplitSession is about to navigate a container tab to `origin`: mark the site managed (and wait until plain tabs are told
   * so), then remove the origin's service workers. Resolves when no worker of the origin can answer the navigation.
   */
  async prepare(origin: string): Promise<void> {
    const parsed = this.parse(origin);
    if (!parsed) return;
    this.markManaged(parsed.site);
    const pending = this.inFlight.get(parsed.origin);
    if (pending) {
      await pending;
    } else {
      const last = this.lastRemoval.get(parsed.origin);
      if (last === undefined || this.now() - last >= this.prepareThrottleMs) await this.removeOrigin(parsed.origin);
    }
    await this.settle();
  }

  /** Strict mode: every service worker of the profile. */
  async removeAll(): Promise<void> {
    try {
      await this.browsingData.remove({}, { serviceWorkers: true, cacheStorage: false });
      this.log('info', 'removed every service worker of the profile (strict mode)');
    } catch (error) {
      this.log('error', 'removing every service worker failed', String(error));
      throw error;
    }
  }

  /** Strict mode guard on/off: the global `{g:1}` beacon answer. */
  async setGuard(on: boolean): Promise<void> {
    if (this.guard === on) return this.ruleWrite;
    this.guard = on;
    await this.writeRules();
    this.onGuardChanged();
  }

  get guarded(): boolean {
    return this.guard;
  }

  /** Waits until the dynamic rules reflect every site marked so far. */
  async settle(): Promise<void> {
    if (this.ruleTimer !== null) {
      clearTimeout(this.ruleTimer);
      this.ruleTimer = null;
      await this.writeRules();
    }
    await this.ruleWrite;
  }

  private parse(origin: string): { origin: string; site: string } | null {
    try {
      const url = new URL(origin);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      return { origin: url.origin, site: beaconSiteOf(hostnameOf(url.hostname)) };
    } catch {
      return null;
    }
  }

  private markManaged(site: string): void {
    if (this.managed.has(site)) return;
    this.managed.add(site);
    void this.area.set({ [MANAGED_SITES_KEY]: this.sites() });
    this.scheduleRuleWrite();
    this.onSitesChanged();
  }

  private removeOrigin(origin: string): Promise<void> {
    const existing = this.inFlight.get(origin);
    if (existing) return existing;
    this.lastRemoval.set(origin, this.now());
    const work = this.browsingData
      .remove({ origins: [origin] }, { serviceWorkers: true })
      .catch((error) => this.log('warn', `removing service workers of ${origin} failed`, String(error)))
      .finally(() => this.inFlight.delete(origin));
    this.inFlight.set(origin, work);
    return work;
  }

  private scheduleRuleWrite(): void {
    if (this.ruleTimer !== null) return;
    this.ruleTimer = setTimeout(() => {
      this.ruleTimer = null;
      void this.writeRules();
    }, 50);
  }

  private writeRules(): Promise<void> {
    const managed = this.beacon ? compileManagedBeaconRule(MANAGED_BEACON_RULE_ID, this.sites()) : null;
    const addRules: DnrRule[] = [];
    if (managed) addRules.push(managed);
    if (this.guard && this.beacon) addRules.push(compileStrictGuardRule(STRICT_GUARD_RULE_ID));
    this.ruleWrite = this.ruleWrite
      .then(() => this.dnr.updateDynamicRules({ removeRuleIds: [MANAGED_BEACON_RULE_ID, STRICT_GUARD_RULE_ID], addRules }))
      .catch((error) => this.log('error', 'updating the dynamic beacon rules failed', String(error)));
    return this.ruleWrite;
  }
}
