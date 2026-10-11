import { browser } from 'wxt/browser';
import { API_METHODS, createApi, type FacetApi } from './api';
import { createExtrasApi, EXTRAS_METHODS, type ExtrasApi } from './extras-api';
import type { Extras } from './extras';
import { BRIDGE_METHODS, type BridgeApi } from './bridge/bridge-api';
import type { Facet } from './facet';

/**
 * Everything extension pages and tests may call on the background. The bridge's methods exist in the Full edition only:
 * in Lite they are neither implemented nor dispatched (and no page calls them).
 */
export type FullApi = FacetApi & ExtrasApi & BridgeApi;

export const FULL_API_METHODS: readonly string[] = [...API_METHODS, ...EXTRAS_METHODS, ...(__FULL__ ? BRIDGE_METHODS : [])];

export function createFullApi(
  facet: Facet,
  extras: Extras,
  getSessionRules: () => Promise<unknown[]>,
  b: typeof browser = browser,
  bridgeApi?: BridgeApi,
): FullApi {
  const base = createApi(facet, getSessionRules);
  return { ...base, ...createExtrasApi(facet, extras, b), ...bridgeApi } as FullApi;
}

export async function dispatchFullApi(api: FullApi, method: string, args: unknown[]): Promise<unknown> {
  if (!FULL_API_METHODS.includes(method)) throw new Error(`unknown API method "${method}"`);
  const fn = api[method as keyof FullApi] as (...a: unknown[]) => Promise<unknown>;
  return fn(...(Array.isArray(args) ? args : []));
}
