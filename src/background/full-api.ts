import { browser } from 'wxt/browser';
import { API_METHODS, createApi, type FacetApi } from './api';
import { createExtrasApi, EXTRAS_METHODS, type ExtrasApi } from './extras-api';
import type { Extras } from './extras';
import type { AgentBridge, BridgeState } from './bridge/agent-bridge';
import type { Facet } from './facet';
import { readProfileLabel, writeProfileLabel } from './bridge/profile-label';
import type { StorageAreaLike } from '../engine/storage/storage-area';

/** The agent bridge's part of the API (the switch itself is the `agentBridge` setting). */
export interface BridgeApi {
  /** Connection status, the last error and the action counter, for the popup and the options page. */
  getBridgeState(): Promise<BridgeState>;
  /** "Check again": connect now instead of waiting for the next automatic attempt. */
  retryBridge(): Promise<BridgeState>;
  /** The name the user gave this Chrome profile (empty: none); the agent reads it through `bridge_info`. */
  getBridgeProfileLabel(): Promise<string>;
  /** Stores the label (cleaned: one line, at most 40 characters) and returns what was stored. */
  setBridgeProfileLabel(label: string): Promise<string>;
}

export const BRIDGE_METHODS = ['getBridgeState', 'retryBridge', 'getBridgeProfileLabel', 'setBridgeProfileLabel'] as const satisfies readonly (keyof BridgeApi)[];

/** Everything extension pages and tests may call on the background. */
export type FullApi = FacetApi & ExtrasApi & BridgeApi;

export const FULL_API_METHODS: readonly string[] = [...API_METHODS, ...EXTRAS_METHODS, ...BRIDGE_METHODS];

export function createFullApi(
  facet: Facet,
  extras: Extras,
  getSessionRules: () => Promise<unknown[]>,
  b: typeof browser = browser,
  bridge?: AgentBridge,
): FullApi {
  const base = createApi(facet, getSessionRules);
  const bridgeApi: BridgeApi = {
    getBridgeState: async () => bridge?.state() ?? { status: 'off', error: null, actions: 0, lastTool: null, lastAt: null, recent: [] },
    retryBridge: async () => {
      bridge?.retry();
      return bridge?.state() ?? { status: 'off', error: null, actions: 0, lastTool: null, lastAt: null, recent: [] };
    },
    getBridgeProfileLabel: () => readProfileLabel(b.storage.local as unknown as StorageAreaLike),
    setBridgeProfileLabel: (label) => writeProfileLabel(b.storage.local as unknown as StorageAreaLike, label),
  };
  return { ...base, ...createExtrasApi(facet, extras, b), ...bridgeApi };
}

export async function dispatchFullApi(api: FullApi, method: string, args: unknown[]): Promise<unknown> {
  if (!FULL_API_METHODS.includes(method)) throw new Error(`unknown API method "${method}"`);
  const fn = api[method as keyof FullApi] as (...a: unknown[]) => Promise<unknown>;
  return fn(...(Array.isArray(args) ? args : []));
}
