import { browser } from "wxt/browser";

import type { CopyDetector, OtherCopy } from "../core/copies";
import { BRIDGE_METHODS, type BridgeApi } from "./bridge/bridge-api";
import { API_METHODS, createApi, type FacetApi } from "./api";
import type { Extras } from "./extras";
import { createExtrasApi, EXTRAS_METHODS, type ExtrasApi } from "./extras-api";
import type { Facet } from "./facet";

/**
 * Everything extension pages and tests may call on the background. The bridge's methods exist in the Full edition only:
 * in Lite they are neither implemented nor dispatched (and no page calls them).
 */
export type FullApi = FacetApi & ExtrasApi & BridgeApi & CopiesApi;

/** Duplicate-copy detection (src/core/copies.ts). */
export interface CopiesApi {
  /** Other enabled SplitSession copies in this profile (cached for a minute), pinged by their known IDs. */
  getOtherCopies(): Promise<OtherCopy[]>;
}

export const FULL_API_METHODS: readonly string[] = [
  ...API_METHODS,
  ...EXTRAS_METHODS,
  "getOtherCopies",
  ...(__FULL__ ? BRIDGE_METHODS : []),
];

export function createFullApi(
  facet: Facet,
  extras: Extras,
  getSessionRules: () => Promise<unknown[]>,
  b: typeof browser = browser,
  bridgeApi?: BridgeApi,
  copies?: CopyDetector,
): FullApi {
  const base = createApi(facet, getSessionRules);
  return {
    ...base,
    ...createExtrasApi(facet, extras, b),
    ...bridgeApi,
    getOtherCopies: () => copies?.get() ?? Promise.resolve([]),
  } as FullApi;
}

export async function dispatchFullApi(
  api: FullApi,
  method: string,
  args: unknown[],
): Promise<unknown> {
  if (!FULL_API_METHODS.includes(method))
    throw new Error(`unknown API method "${method}"`);
  const fn = api[method as keyof FullApi] as (
    ...a: unknown[]
  ) => Promise<unknown>;
  return fn(...(Array.isArray(args) ? args : []));
}
