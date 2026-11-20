/**
 * Dashboard preferences (AEGOX_multisession, Module 04).
 *
 * Pure data and validation: no DOM and no `chrome.*` references. The UI layer
 * loads/saves this record through a `StorageAreaLike` and applies it visually.
 */

import type { StorageAreaLike } from "../engine/storage/storage-area";
import {
  DEFAULT_WIDGET_LAYOUT,
  normalizeWidgetLayout,
  type WidgetLayoutItem,
} from "./widgets";

/** Theme choices. `system` follows the operating system and never overrides it. */
export type ThemePreference = "light" | "dark" | "system";

/** Navigation placement. All three expose the same real pages. */
export type NavigationMode = "sidebar" | "top" | "combined";

/** Animation policy. `reduced` keeps short feedback only; `none` disables transitions. */
export type AnimationPreference = "full" | "reduced" | "none";

/** Session presentation formats required by Module 04. */
export type SessionViewMode = "compact" | "cards" | "table";

/** Notification categories the user can switch independently. */
export type NotificationCategory = "sessions" | "profiles" | "security" | "system";

/** Interface scale. Values are percentages applied as a root font-size factor. */
export const TEXT_SCALES = [100, 110, 120, 130] as const;
export type TextScale = (typeof TEXT_SCALES)[number];

/** Quiet hours use local wall-clock minutes (0-1439). */
export interface QuietHours {
  enabled: boolean;
  /** Start minute of day, inclusive. */
  start: number;
  /** End minute of day, exclusive. May be smaller than `start` to wrap midnight. */
  end: number;
}

export interface NotificationPreferences {
  /** Show notifications inside the dashboard. */
  inApp: boolean;
  /**
   * Ask the browser to show system notifications. This is only a preference:
   * the UI still checks the real permission before sending anything.
   */
  browser: boolean;
  categories: Record<NotificationCategory, boolean>;
  quietHours: QuietHours;
}

export interface DashboardPreferences {
  /** Schema version for future migrations. */
  version: 1;
  theme: ThemePreference;
  navigation: NavigationMode;
  animations: AnimationPreference;
  textScale: TextScale;
  sessionView: SessionViewMode;
  widgetLayout: WidgetLayoutItem[];
  notifications: NotificationPreferences;
  /** Profile IDs marked as favorites in the dashboard. */
  favoriteProfileIds: string[];
  /** Session IDs marked as favorites in the dashboard. */
  favoriteSessionIds: string[];
  /** Width in pixels of the main panel when the viewport allows it. */
  panelWidth: number;
  /** Panels the user folded. Purely visual; navigation is never foldable. */
  collapsedPanels: string[];
}

/** Storage key for the preference record. */
export const PREFERENCES_KEY = "aegox.dashboard.preferences.v1";

/** Bounds for the resizable main panel. */
export const PANEL_MIN_WIDTH = 720;
export const PANEL_MAX_WIDTH = 1440;

/** Sensible defaults for a new user. */
export function defaultPreferences(): DashboardPreferences {
  return {
    version: 1,
    theme: "system",
    navigation: "sidebar",
    animations: "full",
    textScale: 100,
    sessionView: "compact",
    widgetLayout: DEFAULT_WIDGET_LAYOUT.map((item) => ({ ...item })),
    notifications: {
      inApp: true,
      browser: false,
      categories: {
        sessions: true,
        profiles: true,
        security: true,
        system: false,
      },
      quietHours: { enabled: false, start: 22 * 60, end: 7 * 60 },
    },
    favoriteProfileIds: [],
    favoriteSessionIds: [],
    panelWidth: 1080,
    collapsedPanels: [],
  };
}

const THEMES: ReadonlyArray<ThemePreference> = ["light", "dark", "system"];
const NAVIGATIONS: ReadonlyArray<NavigationMode> = ["sidebar", "top", "combined"];
const ANIMATIONS: ReadonlyArray<AnimationPreference> = ["full", "reduced", "none"];
const SESSION_VIEWS: ReadonlyArray<SessionViewMode> = ["compact", "cards", "table"];
const CATEGORIES: ReadonlyArray<NotificationCategory> = [
  "sessions",
  "profiles",
  "security",
  "system",
];

function oneOf<T extends string>(value: unknown, allowed: ReadonlyArray<T>, fallback: T): T {
  return typeof value === "string" && (allowed as ReadonlyArray<string>).includes(value)
    ? (value as T)
    : fallback;
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback;
}

function stringIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && item !== ""))];
}

function minute(value: unknown, fallback: number): number {
  return clamp(value, 0, 23 * 60 + 59, fallback);
}

function normalizeQuietHours(raw: unknown, fallback: QuietHours): QuietHours {
  if (typeof raw !== "object" || raw === null) return { ...fallback };
  const record = raw as Record<string, unknown>;
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : fallback.enabled,
    start: minute(record.start, fallback.start),
    end: minute(record.end, fallback.end),
  };
}

function normalizeNotifications(raw: unknown, fallback: NotificationPreferences): NotificationPreferences {
  if (typeof raw !== "object" || raw === null) {
    return {
      ...fallback,
      categories: { ...fallback.categories },
      quietHours: { ...fallback.quietHours },
    };
  }
  const record = raw as Record<string, unknown>;
  const rawCategories =
    typeof record.categories === "object" && record.categories !== null
      ? (record.categories as Record<string, unknown>)
      : {};
  const categories = {} as Record<NotificationCategory, boolean>;
  for (const category of CATEGORIES) {
    const value = rawCategories[category];
    categories[category] =
      typeof value === "boolean" ? value : fallback.categories[category];
  }
  return {
    inApp: typeof record.inApp === "boolean" ? record.inApp : fallback.inApp,
    browser: typeof record.browser === "boolean" ? record.browser : fallback.browser,
    categories,
    quietHours: normalizeQuietHours(record.quietHours, fallback.quietHours),
  };
}

/**
 * Coerces any stored value into a complete, safe preference record. Unknown
 * versions and malformed fields fall back to defaults instead of breaking the
 * dashboard; widget layout is sanitized by `normalizeWidgetLayout`.
 */
export function normalizePreferences(raw: unknown): DashboardPreferences {
  const fallback = defaultPreferences();
  if (typeof raw !== "object" || raw === null) return fallback;
  const record = raw as Record<string, unknown>;
  return {
    version: 1,
    theme: oneOf(record.theme, THEMES, fallback.theme),
    navigation: oneOf(record.navigation, NAVIGATIONS, fallback.navigation),
    animations: oneOf(record.animations, ANIMATIONS, fallback.animations),
    textScale: TEXT_SCALES.includes(record.textScale as TextScale)
      ? (record.textScale as TextScale)
      : fallback.textScale,
    sessionView: oneOf(record.sessionView, SESSION_VIEWS, fallback.sessionView),
    widgetLayout: normalizeWidgetLayout(record.widgetLayout),
    notifications: normalizeNotifications(record.notifications, fallback.notifications),
    favoriteProfileIds: stringIds(record.favoriteProfileIds),
    favoriteSessionIds: stringIds(record.favoriteSessionIds),
    panelWidth: clamp(record.panelWidth, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH, fallback.panelWidth),
    collapsedPanels: stringIds(record.collapsedPanels),
  };
}

/** Resolves the effective theme. `systemDark` comes from the media query. */
export function resolveTheme(
  preference: ThemePreference,
  systemDark: boolean,
): "light" | "dark" {
  if (preference === "system") return systemDark ? "dark" : "light";
  return preference;
}

/** Loads preferences, falling back to defaults on missing or invalid data. */
export async function loadPreferences(area: StorageAreaLike): Promise<DashboardPreferences> {
  const stored = (await area.get(PREFERENCES_KEY))[PREFERENCES_KEY];
  return normalizePreferences(stored);
}

/** Persists preferences. The record is normalized first, so bad input is never written. */
export async function savePreferences(
  area: StorageAreaLike,
  preferences: DashboardPreferences,
): Promise<DashboardPreferences> {
  const safe = normalizePreferences(preferences);
  await area.set({ [PREFERENCES_KEY]: safe });
  return safe;
}

/** Toggles an ID in a favorite list without duplicating entries. */
export function toggleFavorite(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((existing) => existing !== id) : [...ids, id];
}

/** Adds or removes a collapsed panel key. */
export function toggleCollapsed(keys: readonly string[], key: string): string[] {
  return keys.includes(key) ? keys.filter((existing) => existing !== key) : [...keys, key];
}
