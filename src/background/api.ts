import type { Container, ContainerColor, ContainerId, Cookie } from '../core';
import type { ContainerInfo, Facet, OpenOptions } from './facet';

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
  /** Diagnostics. */
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
