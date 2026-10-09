/** User settings. Pure data: shared by the background, the options page and the title-prefix content script. */

export interface Settings {
  /** Show containers as Chrome tab groups (one group per window and container). */
  tabGroups: boolean;
  /** Prefix the title of container tabs with `[name] `. */
  titlePrefix: boolean;
}

/** `chrome.storage.local` key holding the settings object. */
export const SETTINGS_KEY = 'settings';

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({ tabGroups: true, titlePrefix: true });

export const SETTING_KEYS = ['tabGroups', 'titlePrefix'] as const satisfies readonly (keyof Settings)[];

export class SettingsError extends Error {}

/** Tolerant reader for data from storage: a missing or malformed field falls back to its default. */
export function normalizeSettings(raw: unknown): Settings {
  const source = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const out: Settings = { ...DEFAULT_SETTINGS };
  for (const key of SETTING_KEYS) {
    const value = source[key];
    if (typeof value === 'boolean') out[key] = value;
  }
  return out;
}

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
