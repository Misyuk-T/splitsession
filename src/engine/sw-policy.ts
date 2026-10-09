import { beaconSiteOf, compileManagedBeaconRule, hostnameOf, type DnrRule } from '../core';
import type { StorageAreaLike } from './storage/storage-area';

export const MANAGED_SITES_KEY = 'managedSites';
/** Dynamic rule ID of the "managed origin" beacon answer (the only dynamic rule Facet owns). */
export const MANAGED_BEACON_RULE_ID = 1;

export interface DnrDynamicApi {
  updateDynamicRules(options: { removeRuleIds?: number[]; addRules?: DnrRule[] }): Promise<void>;
}

export interface BrowsingDataApi {
  remove(options: { origins: string[] }, dataToRemove: { serviceWorkers: boolean }): Promise<void>;
}

export interface ServiceWorkerPolicyOptions {
  now?: () => number;
  /** Minimum gap between two service-worker removals for the same origin (default 30 s). */
  removalThrottleMs?: number;
  log?: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
}

/**
 * "SW-free zone": every site seen inside a container tab becomes managed.
 *  - Its service workers are removed (`browsingData`, origin-filtered) when a container tab goes there: a worker
 *    registered by the real profile would answer container navigations with the real profile's cookies (its own
 *    fetches carry tabId -1, outside every per-tab rule).
 *  - A dynamic DNR rule answers the beacon with `{m:1}` for these sites in tabs WITHOUT a container, so the shim
 *    there rejects `serviceWorker.register` too and hides container-namespaced storage. The rule is dynamic so it
 *    survives browser restarts before the worker runs.
 * Cache Storage is deliberately not wiped: it would also erase the containers' own (namespaced) caches.
 */
export class ServiceWorkerPolicy {
  private managed = new Set<string>();
  private readonly lastRemoval = new Map<string, number>();
  private ruleWrite: Promise<void> = Promise.resolve();
  private ruleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;
  private readonly throttleMs: number;
  private readonly log: NonNullable<ServiceWorkerPolicyOptions['log']>;

  constructor(
    private readonly area: StorageAreaLike,
    private readonly dnr: DnrDynamicApi,
    private readonly browsingData: BrowsingDataApi,
    options: ServiceWorkerPolicyOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.throttleMs = options.removalThrottleMs ?? 30_000;
    this.log = options.log ?? (() => {});
  }

  async load(): Promise<void> {
    const stored = (await this.area.get(MANAGED_SITES_KEY))[MANAGED_SITES_KEY];
    this.managed = new Set(Array.isArray(stored) ? stored.filter((s): s is string => typeof s === 'string') : []);
    await this.writeRule();
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
    let host: string;
    try {
      const url = new URL(origin);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
      host = hostnameOf(url.hostname);
      origin = url.origin;
    } catch {
      return;
    }
    const site = beaconSiteOf(host);
    if (!this.managed.has(site)) {
      this.managed.add(site);
      void this.area.set({ [MANAGED_SITES_KEY]: this.sites() });
      this.scheduleRuleWrite();
    }
    const last = this.lastRemoval.get(origin);
    if (last !== undefined && this.now() - last < this.throttleMs) return;
    this.lastRemoval.set(origin, this.now());
    try {
      await this.browsingData.remove({ origins: [origin] }, { serviceWorkers: true });
    } catch (error) {
      this.log('warn', `removing service workers of ${origin} failed`, String(error));
    }
  }

  /** Waits until the dynamic rule reflects every site marked so far. */
  async settle(): Promise<void> {
    if (this.ruleTimer !== null) {
      clearTimeout(this.ruleTimer);
      this.ruleTimer = null;
      await this.writeRule();
    }
    await this.ruleWrite;
  }

  private scheduleRuleWrite(): void {
    if (this.ruleTimer !== null) return;
    this.ruleTimer = setTimeout(() => {
      this.ruleTimer = null;
      void this.writeRule();
    }, 50);
  }

  private writeRule(): Promise<void> {
    const rule = compileManagedBeaconRule(MANAGED_BEACON_RULE_ID, this.sites());
    this.ruleWrite = this.ruleWrite
      .then(() => this.dnr.updateDynamicRules({ removeRuleIds: [MANAGED_BEACON_RULE_ID], addRules: rule ? [rule] : [] }))
      .catch((error) => this.log('error', 'updating the managed-origin beacon rule failed', String(error)));
    return this.ruleWrite;
  }
}
