/** User settings. Pure data: shared by the background, the options page and the title-prefix content script. */

export interface Settings {
  /** Show containers as Chrome tab groups (one group per window and container). */
  tabGroups: boolean;
  /** Prefix the title of container tabs with `[name] ` (needs `showNameToPages`: pages can read their title). */
  titlePrefix: boolean;
  /**
   * Strict mode: turning it on removes every service worker of this Chrome profile and refuses new registrations on
   * every site (and blocks worker scripts outside tabs), so no worker of the real profile can answer a container tab's
   * requests. Also strips `Cookie` and `Set-Cookie` of requests that belong to no tab (service workers, shared workers,
   * other extensions) on sites containers use. Costs push notifications on every site, so the default is off: the
   * per-site policy only (workers removed on sites used in containers, docs/limits.md).
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
   * (`com.splitsession.bridge`) and the user's own AI agent (an MCP server on the same machine) can list, read and operate
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
   * Tabs an agent opens itself (open_tab, open_in_container) go into one separate ordinary window of this profile, made on
   * the first open without taking focus and reused while it exists, instead of the window the user is working in. An explicit
   * `windowId` from the agent wins. Off: they open in the current window. Full only. Default on.
   */
  agentWindow: boolean;
  /**
   * Container tabs that come back (browser restart with "Continue where you left off", Ctrl/Cmd+Shift+T, History's
   * "Recently closed", a closed tab group opened again) return to their container before their first request. SplitSession
   * keeps the addresses of container tabs in `storage.local` for that and holds such tabs until it has matched them.
   * Off: they come back as ordinary tabs. Default on.
   */
  restoreTabs: boolean;
  /**
   * A container tab that is not inside its container's tab group (dragged out, or tab groups switched off) gets "⧉ " in
   * front of its title, so it does not pass for an ordinary tab. The mark carries no container name, but pages can read
   * their title and so learn that this is a container tab. Both editions. Default on.
   */
  markOutsideGroup: boolean;
  /**
   * When a container's last tab closes, keep the addresses and titles of the tabs of its last batch of closures in
   * `storage.local`; a click on the container in the popup opens them again. Off: nothing is saved, and the sets that
   * exist are forgotten. Both editions. Default on.
   */
  rememberTabs: boolean;
}

/** `chrome.storage.local` key holding the settings object. */
export const SETTINGS_KEY = "settings";

/**
 * Lite has only `tabGroups`, `strictMode`, `restoreTabs`, `markOutsideGroup` and `rememberTabs`: the agent bridge, agent activity and page-name settings are
 * not part of its schema at all (no default, not a valid key: an update naming one is an error, nothing stored, no string
 * shipped). The `Settings` type stays the Full one; Lite code never reads the other keys (every use sits behind `__FULL__`).
 */
export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze(
  __FULL__
    ? {
        tabGroups: true,
        titlePrefix: true,
        strictMode: false,
        showNameToPages: false,
        agentBridge: false,
        agentActivity: true,
        agentWindow: true,
        restoreTabs: true,
        markOutsideGroup: true,
        rememberTabs: true,
      }
    : ({
        tabGroups: true,
        strictMode: false,
        restoreTabs: true,
        markOutsideGroup: true,
        rememberTabs: true,
      } as Settings),
);

/** The edition's setting keys, in the order of `DEFAULT_SETTINGS` (the one list of them). */
export const SETTING_KEYS: readonly SettingKey[] = Object.keys(
  DEFAULT_SETTINGS,
) as SettingKey[];

export type SettingKey = keyof Settings;

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
const LEGACY_DEFAULTS: Readonly<Settings> = Object.freeze({
  ...DEFAULT_SETTINGS,
  strictMode: true,
  ...(__FULL__ ? { showNameToPages: true } : {}),
});

export interface ReadSettings {
  settings: Settings;
  explicit: SettingKey[];
  /** Stored in the format without `explicit` (rewrite it). */
  legacy: boolean;
}

/** Tolerant reader for data from storage: a missing, malformed or never-set field falls back to its default. */
export function readSettings(raw: unknown): ReadSettings {
  const source =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)
      : {};
  const settings: Settings = { ...DEFAULT_SETTINGS };
  const legacy =
    !Array.isArray(source.explicit) &&
    SETTING_KEYS.some((key) => typeof source[key] === "boolean");
  const explicit: SettingKey[] = Array.isArray(source.explicit)
    ? SETTING_KEYS.filter(
        (key) =>
          (source.explicit as unknown[]).includes(key) &&
          typeof source[key] === "boolean",
      )
    : SETTING_KEYS.filter(
        (key) =>
          typeof source[key] === "boolean" &&
          source[key] !== LEGACY_DEFAULTS[key],
      );
  for (const key of explicit) settings[key] = source[key] as boolean;
  return { settings, explicit, legacy };
}

export function normalizeSettings(raw: unknown): Settings {
  return readSettings(raw).settings;
}

export function storedSettings(
  settings: Settings,
  explicit: Iterable<SettingKey>,
): StoredSettings {
  const keys = new Set(explicit);
  return { ...settings, explicit: SETTING_KEYS.filter((key) => keys.has(key)) };
}

export class SettingsError extends Error {}

/** Strict merge of a change request: unknown keys and non-boolean values are errors, not silently dropped. */
export function applySettingsPatch(
  current: Settings,
  patch: unknown,
): Settings {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch))
    throw new SettingsError("settings patch must be an object");
  const next: Settings = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (!(SETTING_KEYS as readonly string[]).includes(key))
      throw new SettingsError(`unknown setting "${key}"`);
    if (typeof value !== "boolean")
      throw new SettingsError(`setting "${key}" must be true or false`);
    next[key as keyof Settings] = value;
  }
  return next;
}
