import {
  BRIDGE_CONSENT_KEY,
  BRIDGE_CONSENT_VERSION,
  type BridgeConsent,
  hasBridgeConsent,
  NO_CONSENT_MESSAGE,
  readBridgeConsent,
} from "../../core/bridge-consent";
import { SettingsError } from "../../core/settings";
import type { StorageAreaLike } from "../../engine/storage/storage-area";
import type { SettingsGuard } from "../settings-store";

/**
 * The consent record in `storage.local` (src/core/bridge-consent.ts) and the settings guard built on it. Full edition only.
 * The guard is the one gate every route to `agentBridge: true` passes: `SettingsStore.update` (the options switch, the
 * popup, the API, tests) refuses it without consent, and `SettingsStore.load` turns a stored `true` without consent off
 * (an install from before the gate, data written by another build, anything that bypassed the API).
 */
export class BridgeConsentStore {
  constructor(
    private readonly area: StorageAreaLike,
    private readonly now: () => number = Date.now,
  ) {}

  async get(): Promise<BridgeConsent | null> {
    return readBridgeConsent(
      (await this.area.get(BRIDGE_CONSENT_KEY))[BRIDGE_CONSENT_KEY],
    );
  }

  async has(): Promise<boolean> {
    return hasBridgeConsent(
      (await this.area.get(BRIDGE_CONSENT_KEY))[BRIDGE_CONSENT_KEY],
    );
  }

  /**
   * The user pressed "Allow agent access" on the disclosure of text `version`. A page showing an older text (an options
   * page left open across an update) is refused, so nobody consents to words they were not shown.
   */
  async grant(version: unknown): Promise<BridgeConsent> {
    if (version !== BRIDGE_CONSENT_VERSION)
      throw new SettingsError(
        "the agent access text has changed; reload the page and read it again",
      );
    const consent: BridgeConsent = { version, at: this.now() };
    await this.area.set({ [BRIDGE_CONSENT_KEY]: consent });
    return consent;
  }

  guard(): SettingsGuard {
    return {
      loaded: async (settings) =>
        settings.agentBridge && !(await this.has())
          ? { ...settings, agentBridge: false }
          : settings,
      check: async (next, previous) => {
        if (next.agentBridge && !previous.agentBridge && !(await this.has()))
          throw new SettingsError(NO_CONSENT_MESSAGE);
      },
    };
  }
}
