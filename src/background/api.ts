import type { Container, ContainerColor, ContainerId, Cookie } from '../core';
import type { StrictModeStatus } from '../engine/strict-mode';
import type { ContainerInfo, Facet, OpenOptions } from './facet';
import type { RestoreStatus } from './restore';

/**
 * Programmatic API of the background, for extension pages (Stage C UI, `open.html`) via `runtime.sendMessage`
 * (`{type: 'facet/api', method, args}`, see `src/engine/api-client.ts`) and for tests via `globalThis.facet` in the
 * service worker. Content scripts cannot call it.
 */
export interface FacetApi {
  listContainers(): Promise<ContainerInfo[]>;
  createContainer(input: { name: string; color?: ContainerColor }): Promise<Container>;
  renameContainer(id: ContainerId, name: string): Promise<Container>;
  updateContainer(id: ContainerId, patch: { name?: string; color?: ContainerColor }): Promise<Container>;
  /** Closes the container's tabs and purges its jar and rules. */
  deleteContainer(id: ContainerId): Promise<void>;
  /** By ID or case-insensitive name; creates a container with that name if none matches. */
  ensureContainer(ref: string): Promise<Container>;
  /** `null` takes the tab out of its container. Rules are active when this resolves. */
  assignTab(tabId: number, containerId: ContainerId | null, options?: { reload?: boolean }): Promise<void>;
  getTabContainer(tabId: number): Promise<ContainerId | null>;
  listTabs(): Promise<Array<{ tabId: number; containerId: ContainerId; active: boolean }>>;
  /** Opens `url` in a new tab of the container (by ID or name); its first request is already isolated. */
  openInContainer(url: string, containerId: ContainerId, options?: OpenOptions): Promise<number>;
  /**
   * Call before an extension page navigates a container tab to `url` itself (open.html): removes the origin's service
   * workers, so none of the real profile answers the first request.
   */
  prepareNavigation(url: string): Promise<void>;
  /** Strict mode: setting, consent, whether the interface must warn or ask. */
  getStrictMode(): Promise<StrictModeStatus>;
  /** The user agreed in the consent dialog: remove every service worker of the profile and refuse new ones. */
  grantStrictMode(): Promise<StrictModeStatus>;
  /** "Not now" in the consent dialog: the warning stays, the dialog no longer opens by itself. */
  dismissStrictModePrompt(): Promise<StrictModeStatus>;
  /** Container tabs that came back but could not be matched with certainty (the popup's banner). */
  getRestoreStatus(): Promise<RestoreStatus>;
  /**
   * The banner's answer for the waiting tabs (all, or `tabIds`): `restore` puts each one that has a single, certain
   * container back into it and loads it; `plain` loads them as ordinary tabs. Returns how many were handled.
   */
  resolveHeldTabs(action: 'restore' | 'plain', tabIds?: number[]): Promise<number>;
  /** Forgets closed container tabs: reopening them later gives ordinary tabs. */
  forgetClosedTabs(): Promise<void>;
  /** Tests: waits until every tab is matched and the restore records and gate are written. */
  flushRestore(): Promise<void>;
  /** Diagnostics. */
  getRestoreDebug(): Promise<unknown>;
  getJar(containerId: ContainerId): Promise<Cookie[]>;
  getSessionRules(): Promise<unknown[]>;
  getManagedSites(): Promise<string[]>;
  getLog(): Promise<unknown[]>;
  stats(): Promise<{ rules: number; regexRules: number; keys: number }>;
}

export const API_METHODS = [
  'listContainers',
  'createContainer',
  'renameContainer',
  'updateContainer',
  'deleteContainer',
  'ensureContainer',
  'assignTab',
  'getTabContainer',
  'listTabs',
  'openInContainer',
  'prepareNavigation',
  'getStrictMode',
  'grantStrictMode',
  'dismissStrictModePrompt',
  'getRestoreStatus',
  'resolveHeldTabs',
  'forgetClosedTabs',
  'flushRestore',
  'getRestoreDebug',
  'getJar',
  'getSessionRules',
  'getManagedSites',
  'getLog',
  'stats',
] as const satisfies readonly (keyof FacetApi)[];

export function createApi(facet: Facet, getSessionRules: () => Promise<unknown[]>): FacetApi {
  return {
    listContainers: async () => (await facet.ready, facet.listContainers()),
    createContainer: (input) => facet.createContainer(input),
    renameContainer: (id, name) => facet.updateContainer(id, { name }),
    updateContainer: (id, patch) => facet.updateContainer(id, patch),
    deleteContainer: (id) => facet.deleteContainer(id),
    ensureContainer: (ref) => facet.ensureContainer(ref),
    assignTab: (tabId, containerId, options) => facet.assignTab(tabId, containerId, options),
    getTabContainer: async (tabId) => (await facet.ready, facet.getTabContainer(tabId)),
    listTabs: async () => (await facet.ready, facet.listTabs()),
    openInContainer: (url, containerId, options) => facet.openInContainer(url, containerId, options),
    prepareNavigation: async (url) => (await facet.ready, facet.prepareNavigation(String(url))),
    getStrictMode: async () => (await facet.ready, facet.strict.status()),
    grantStrictMode: async () => (await facet.ready, facet.strict.grant()),
    dismissStrictModePrompt: async () => (await facet.ready, facet.strict.dismissPrompt()),
    getRestoreStatus: async () => (await facet.ready, facet.restore.status()),
    resolveHeldTabs: async (action, tabIds) => {
      await facet.ready;
      if (action !== 'restore' && action !== 'plain') throw new Error('action must be "restore" or "plain"');
      return facet.restore.resolveHeld(action, Array.isArray(tabIds) ? tabIds.map(Number) : undefined);
    },
    forgetClosedTabs: async () => (await facet.ready, facet.restore.forgetClosed()),
    flushRestore: async () => (await facet.ready, facet.restore.flush()),
    getRestoreDebug: async () => (await facet.ready, facet.restore.debugState()),
    getJar: async (id) => (await facet.ready, facet.getJar(id)),
    getSessionRules,
    getManagedSites: async () => (await facet.ready, facet.swPolicy.sites()),
    getLog: async () => facet.log.entries(),
    stats: async () => (await facet.ready, facet.rules.stats()),
  };
}

export async function dispatchApi(api: FacetApi, method: string, args: unknown[]): Promise<unknown> {
  if (!(API_METHODS as readonly string[]).includes(method)) throw new Error(`unknown API method "${method}"`);
  const fn = api[method as keyof FacetApi] as (...a: unknown[]) => Promise<unknown>;
  return fn(...(Array.isArray(args) ? args : []));
}
