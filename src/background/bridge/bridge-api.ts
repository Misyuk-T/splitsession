import type { browser } from "wxt/browser";

import type { BridgeConsent } from "../../core/bridge-consent";
import type { StorageAreaLike } from "../../engine/storage/storage-area";
import type { AgentBridge, BridgeState } from "./agent-bridge";
import type { BridgeConsentStore } from "./consent";
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
  /** The accepted disclosure (null: never accepted, or an older text); the switch asks first while it is null. */
  getBridgeConsent(): Promise<BridgeConsent | null>;
  /**
   * "Allow agent access" in the disclosure dialog, for text `version` (`BRIDGE_CONSENT_VERSION`). Only records the consent:
   * the switch is turned on by `updateSettings` afterwards, as always. Extension pages only (like the whole API).
   */
  grantBridgeConsent(version: number): Promise<BridgeConsent>;
}

export const BRIDGE_METHODS = [
  "getBridgeState",
  "retryBridge",
  "getBridgeProfileLabel",
  "setBridgeProfileLabel",
  "getBridgeConsent",
  "grantBridgeConsent",
] as const satisfies readonly (keyof BridgeApi)[];

export function createBridgeApi(
  bridge: AgentBridge,
  b: typeof browser,
  consent: BridgeConsentStore,
): BridgeApi {
  return {
    getBridgeState: async () => bridge.state(),
    retryBridge: async () => {
      bridge.retry();
      return bridge.state();
    },
    getBridgeProfileLabel: () =>
      readProfileLabel(b.storage.local as unknown as StorageAreaLike),
    setBridgeProfileLabel: async (label) => {
      const stored = await writeProfileLabel(
        b.storage.local as unknown as StorageAreaLike,
        label,
      );
      bridge.labelChanged(stored);
      return stored;
    },
    getBridgeConsent: async () => {
      const current = await consent.get();
      return current && (await consent.has()) ? current : null;
    },
    grantBridgeConsent: (version) => consent.grant(version),
  };
}
