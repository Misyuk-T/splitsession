/** User settings. Pure data: shared by the background, the options page and the title-prefix content script. */

export interface Settings {
  /** Show containers as Chrome tab groups (one group per window and container). */
  tabGroups: boolean;
  /** Prefix the title of container tabs with `[name] ` (needs `showNameToPages`: pages can read their title). */
  titlePrefix: boolean;
  /**
   * Strict mode: once the user agrees, Facet removes every service worker of this Chrome profile and refuses new
   * registrations on every site (and blocks worker scripts outside tabs), so no worker of the real profile can answer a
   * container tab's requests. Also strips `Cookie` and `Set-Cookie` of requests that belong to no tab (service workers,
   * shared workers, other extensions) on sites containers use. Off: the per-site policy only (docs/limits.md).
   */
  strictMode: boolean;
  /**
   * Let pages of container tabs see the container's name (`data-ctr` on the top document, the title prefix, the
   * beacon answer). Meant for AI agents driving the browser; any script on the page can read it too, and the same
   * name on every site lets trackers link the visits. Off by default.
   */
  showNameToPages: boolean;
  /**
   * Agent bridge: one all-or-nothing switch. On: the extension connects to the local native-messaging host
   * (`com.facet.bridge`) and the user's own AI agent (an MCP server on the same machine) can list, read and operate
   * every tab of every window. Off (default): no connection, no host process, nothing reachable. Docs: docs/agents.md.
   */
  agentBridge: boolean;
  /**
   * While the agent bridge is on, show the user what the agent touches: an overlay and a pill in the tab it reads or
   * operates, a mark in front of that tab's title and an "AI" toolbar badge, all gone ~2.5 s after the last action.
   * Off: nothing is injected or changed for the sake of showing. Default on.
   */
  agentActivity: boolean;
  /**
   * Container tabs that come back (browser restart with "Continue where you left off", Ctrl/Cmd+Shift+T, History's
   * "Recently closed", a closed tab group opened again) return to their container before their first request. Facet
   * keeps the addresses of container tabs in `storage.local` for that and holds such tabs until it has matched them.
   * Off: they come back as ordinary tabs. Default on.
   */
  restoreTabs: boolean;
}

/** `chrome.storage.local` key holding the settings object. */
export const SETTINGS_KEY = 'settings';

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({ tabGroups: true, titlePrefix: true, strictMode: true, showNameToPages: false, agentBridge: false, agentActivity: true, restoreTabs: true });

export const SETTING_KEYS = ['tabGroups', 'titlePrefix', 'strictMode', 'showNameToPages', 'agentBridge', 'agentActivity', 'restoreTabs'] as const satisfies readonly (keyof Settings)[];

export type SettingKey = (typeof SETTING_KEYS)[number];

/**
 * What `chrome.storage.local.settings` holds: every value, plus the keys the user (or the API) set explicitly. A key
 * that was never set follows the current default, so changing a default reaches installs that never touched it.
 */
export interface StoredSettings extends Settings {
  explicit: SettingKey[];
}

/**
 * The format before `explicit` existed stored every value on any change, so a value equal to the default of that time
 * cannot be told apart from a default. Every default was `true` then: a `false` was the user's choice, a `true` is
 * read as "never set" (the one that matters: `showNameToPages`, whose default is now off).
 */
const LEGACY_DEFAULTS: Readonly<Settings> = Object.freeze({ tabGroups: true, titlePrefix: true, strictMode: true, showNameToPages: true, agentBridge: false, agentActivity: true, restoreTabs: true });

export interface ReadSettings {
  settings: Settings;
  explicit: SettingKey[];
  /** Stored in the format without `explicit` (rewrite it). */
  legacy: boolean;
}

/** Tolerant reader for data from storage: a missing, malformed or never-set field falls back to its default. */
export function readSettings(raw: unknown): ReadSettings {
  const source = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const settings: Settings = { ...DEFAULT_SETTINGS };
  const legacy = !Array.isArray(source.explicit) && SETTING_KEYS.some((key) => typeof source[key] === 'boolean');
  const explicit: SettingKey[] = Array.isArray(source.explicit)
    ? SETTING_KEYS.filter((key) => (source.explicit as unknown[]).includes(key) && typeof source[key] === 'boolean')
    : SETTING_KEYS.filter((key) => typeof source[key] === 'boolean' && source[key] !== LEGACY_DEFAULTS[key]);
  for (const key of explicit) settings[key] = source[key] as boolean;
  return { settings, explicit, legacy };
}

export function normalizeSettings(raw: unknown): Settings {
  return readSettings(raw).settings;
}

export function storedSettings(settings: Settings, explicit: Iterable<SettingKey>): StoredSettings {
  const keys = new Set(explicit);
  return { ...settings, explicit: SETTING_KEYS.filter((key) => keys.has(key)) };
}

export class SettingsError extends Error {}

/** Strict merge of a change request: unknown keys and non-boolean values are errors, not silently dropped. */
export function applySettingsPatch(current: Settings, patch: unknown): Settings {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw new SettingsError('settings patch must be an object');
  const next: Settings = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (!(SETTING_KEYS as readonly string[]).includes(key)) throw new SettingsError(`unknown setting "${key}"`);
    if (typeof value !== 'boolean') throw new SettingsError(`setting "${key}" must be true or false`);
    next[key as keyof Settings] = value;
  }
  return next;
}
