import { describe, expect, it } from "vitest";

import { MemoryStorageArea } from "../engine/storage/storage-area";
import {
  PREFERENCES_KEY,
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  defaultPreferences,
  loadPreferences,
  normalizePreferences,
  resolveTheme,
  savePreferences,
  toggleCollapsed,
  toggleFavorite,
} from "./preferences";
import { DEFAULT_WIDGET_LAYOUT } from "./widgets";

describe("preferences", () => {
  it("provides complete defaults without forcing dark mode", () => {
    const prefs = defaultPreferences();
    expect(prefs.theme).toBe("system");
    expect(prefs.navigation).toBe("sidebar");
    expect(prefs.sessionView).toBe("compact");
    expect(prefs.textScale).toBe(100);
    expect(prefs.notifications.inApp).toBe(true);
    expect(prefs.notifications.browser).toBe(false);
    expect(prefs.widgetLayout).toHaveLength(DEFAULT_WIDGET_LAYOUT.length);
  });

  it("resolves system themes and explicit themes", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
  });

  it("normalizes malformed stored data back to safe values", () => {
    const prefs = normalizePreferences({
      theme: "neon",
      navigation: "floating",
      sessionView: "huge",
      textScale: 999,
      panelWidth: 99,
      favoriteProfileIds: ["a", "a", 3, ""],
      notifications: { categories: { sessions: false }, browser: "yes" },
    });
    expect(prefs.theme).toBe("system");
    expect(prefs.navigation).toBe("sidebar");
    expect(prefs.sessionView).toBe("compact");
    expect(prefs.textScale).toBe(100);
    expect(prefs.panelWidth).toBe(PANEL_MIN_WIDTH);
    expect(prefs.favoriteProfileIds).toEqual(["a"]);
    expect(prefs.notifications.categories.sessions).toBe(false);
    expect(prefs.notifications.browser).toBe(false);
  });

  it("clamps the panel width both ways", () => {
    expect(normalizePreferences({ panelWidth: 99_999 }).panelWidth).toBe(PANEL_MAX_WIDTH);
    expect(normalizePreferences({ panelWidth: 0 }).panelWidth).toBe(PANEL_MIN_WIDTH);
  });

  it("persists and reloads preferences through a storage area", async () => {
    const area = new MemoryStorageArea();
    const initial = await loadPreferences(area);
    expect(initial.theme).toBe("system");

    const saved = await savePreferences(area, {
      ...initial,
      theme: "dark",
      navigation: "top",
      sessionView: "table",
      textScale: 120,
    });
    expect(saved.theme).toBe("dark");
    expect(area.data.has(PREFERENCES_KEY)).toBe(true);

    const reloaded = await loadPreferences(area);
    expect(reloaded.theme).toBe("dark");
    expect(reloaded.navigation).toBe("top");
    expect(reloaded.sessionView).toBe("table");
    expect(reloaded.textScale).toBe(120);
  });

  it("never writes malformed values to storage", async () => {
    const area = new MemoryStorageArea();
    await savePreferences(area, defaultPreferences());
    const stored = area.data.get(PREFERENCES_KEY) as Record<string, unknown>;
    await savePreferences(area, {
      ...defaultPreferences(),
      theme: "broken" as never,
      panelWidth: -5,
    });
    expect(stored).toBeDefined();
    const reloaded = await loadPreferences(area);
    expect(reloaded.theme).toBe("system");
    expect(reloaded.panelWidth).toBe(PANEL_MIN_WIDTH);
  });

  it("toggles favorites without duplicates", () => {
    expect(toggleFavorite([], "a")).toEqual(["a"]);
    expect(toggleFavorite(["a"], "a")).toEqual([]);
    expect(toggleFavorite(["a", "b"], "b")).toEqual(["a"]);
  });

  it("toggles collapsed panels", () => {
    expect(toggleCollapsed([], "recent")).toEqual(["recent"]);
    expect(toggleCollapsed(["recent"], "recent")).toEqual([]);
  });
});
