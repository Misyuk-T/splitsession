import type { browser } from "wxt/browser";

import type { StorageAreaLike } from "../../engine/storage/storage-area";
import type { AgentBridge, BridgeState } from "./agent-bridge";
import { readProfileLabel, writeProfileLabel } from "./profile-label";

/** The agent bridge's part of the API (the switch itself is the `agentBridge` setting). Full edition only. */
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

export const BRIDGE_METHODS = [
  "getBridgeState",
  "retryBridge",
  "getBridgeProfileLabel",
  "setBridgeProfileLabel",
] as const satisfies readonly (keyof BridgeApi)[];

export function createBridgeApi(
  bridge: AgentBridge,
  b: typeof browser,
): BridgeApi {
  return {
    getBridgeState: async () => bridge.state(),
    retryBridge: async () => {
      bridge.retry();
      return bridge.state();
    },
    getBridgeProfileLabel: () =>
      readProfileLabel(b.storage.local as unknown as StorageAreaLike),
    setBridgeProfileLabel: (label) =>
      writeProfileLabel(b.storage.local as unknown as StorageAreaLike, label),
  };
}
