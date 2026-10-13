import {
  readSettings,
  type SettingKey,
  SETTINGS_KEY,
  storedSettings,
} from "../core";
import type { StorageAreaLike } from "./storage/storage-area";
import type { ServiceWorkerPolicy } from "./sw-policy";

/** `storage.local` key of the marker that the one-time move from "consent" to a plain setting is done. */
export const STRICT_STATE_KEY = "strictMode";
const STATE_VERSION = 2;

/** What the interface (and the tests) need to know about strict mode. */
export interface StrictModeStatus {
  /** The `strictMode` setting. */
  enabled: boolean;
  /** Every service worker of the profile was removed and registration is refused on every site (the shim's guard mode). */
  active: boolean;
}

/**
 * Strict mode used to be a consent prompt (setting on by default, "active" only after the user agreed in a dialog).
 * It is now a plain setting, off by default. Run once before the settings are read: an install that had agreed keeps
 * strict mode on, every other install (never asked, "Not now", never answered) gets it off. Leaves `{v: 2}` in
 * `storage.local.strictMode` (the old `{consentAt, prompt}` is dropped), so it never runs again.
 */
export async function migrateStrictMode(area: StorageAreaLike): Promise<void> {
  const stored = await area.get([SETTINGS_KEY, STRICT_STATE_KEY]);
  const state = stored[STRICT_STATE_KEY];
  if (
    typeof state === "object" &&
    state !== null &&
    (state as { v?: unknown }).v === STATE_VERSION
  )
    return;
  const consentAt =
    typeof state === "object" && state !== null
      ? (state as { consentAt?: unknown }).consentAt
      : null;
  const consented = typeof consentAt === "number" && Number.isFinite(consentAt);

  const raw = stored[SETTINGS_KEY];
  const source =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)
      : {};
  // The setting as the old code read it: on unless the user explicitly switched it off (the old default was on).
  const explicitlyOff =
    source.strictMode === false &&
    (Array.isArray(source.explicit)
      ? source.explicit.includes("strictMode")
      : true);
  const on = consented && !explicitlyOff;

  if (raw !== undefined || on) {
    const read = readSettings(raw);
    const explicit = new Set<SettingKey>(read.explicit);
    if (on) explicit.add("strictMode");
    else explicit.delete("strictMode"); // off follows the default (off)
    await area.set({
      [SETTINGS_KEY]: storedSettings(
        { ...read.settings, strictMode: on },
        explicit,
      ),
    });
  }
  await area.set({ [STRICT_STATE_KEY]: { v: STATE_VERSION } });
}

/**
 * Strict mode (setting `strictMode`, default off): a real-profile service worker can answer a container tab's first
 * request on a site before SplitSession gets to remove it (removal is asynchronous, the navigation is not). On: SplitSession removes
 * every service worker of the profile once and refuses new registrations on every site in every tab (the shim's guard
 * mode), so no such worker exists. It costs push notifications and offline mode of every site in this profile, which
 * is why it is off by default; the interface says so next to the switch. Off: the per-site policy only (workers are
 * removed on sites used in containers, and every navigation SplitSession starts waits for that removal).
 */
export class StrictMode {
  private enabled = false;

  constructor(private readonly sw: ServiceWorkerPolicy) {}

  /** Takes the setting at start; returns whether the guard should be on (call before `sw.load`). */
  load(enabled: boolean): boolean {
    this.enabled = enabled;
    return this.active;
  }

  get active(): boolean {
    return this.enabled;
  }

  status(): StrictModeStatus {
    return { enabled: this.enabled, active: this.active };
  }

  /**
   * Remove every service worker, then refuse registrations everywhere. Throws (and stays off) when the removal fails,
   * so the caller can keep the setting off and tell the user.
   */
  async turnOn(): Promise<void> {
    if (this.enabled) return;
    await this.sw.removeAll();
    this.enabled = true;
    await this.sw.setGuard(true);
  }

  /** The `strictMode` setting changed (a no-op when `turnOn` already ran for it). */
  async setEnabled(enabled: boolean): Promise<void> {
    if (enabled === this.enabled) return;
    if (enabled) return this.turnOn();
    this.enabled = false;
    await this.sw.setGuard(false);
  }

  /** Install or update: on, sweep workers again. */
  async installed(reason: string): Promise<void> {
    if (reason !== "install" && reason !== "update") return;
    if (this.active) await this.sw.removeAll().catch(() => {});
  }

  /**
   * Browser start: pages restored before SplitSession's content scripts were registered (or tabs open since before the
   * install) could have registered workers without the shim. Sweep again.
   */
  async startup(): Promise<void> {
    if (this.active) await this.sw.removeAll().catch(() => {});
  }
}
