import { browser } from 'wxt/browser';
import { API_METHODS, createApi, type FacetApi } from './api';
import { createExtrasApi, EXTRAS_METHODS, type ExtrasApi } from './extras-api';
import type { Extras } from './extras';
import type { Facet } from './facet';

/** Everything extension pages and tests may call on the background. */
export type FullApi = FacetApi & ExtrasApi;

export const FULL_API_METHODS: readonly string[] = [...API_METHODS, ...EXTRAS_METHODS];

export function createFullApi(
  facet: Facet,
  extras: Extras,
  getSessionRules: () => Promise<unknown[]>,
  b: typeof browser = browser,
): FullApi {
  const base = createApi(facet, getSessionRules);
  return { ...base, ...createExtrasApi(facet, extras, b) };
}

export async function dispatchFullApi(api: FullApi, method: string, args: unknown[]): Promise<unknown> {
  if (!FULL_API_METHODS.includes(method)) throw new Error(`unknown API method "${method}"`);
  const fn = api[method as keyof FullApi] as (...a: unknown[]) => Promise<unknown>;
  return fn(...(Array.isArray(args) ? args : []));
}
