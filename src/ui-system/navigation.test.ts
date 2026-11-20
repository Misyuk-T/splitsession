import { describe, expect, it } from "vitest";

import {
  NAVIGATION_ITEMS,
  PAGE_IDS,
  hasSidebar,
  hasTopbar,
  isPageId,
  navigationClass,
  pageForShortcut,
  pageFromLocation,
} from "./navigation";
import { THEME_TOKENS, contrastRatio, cssVariableName, luminance, themeStyle } from "./theme";

describe("navigation", () => {
  it("lists only implemented pages", () => {
    expect(NAVIGATION_ITEMS.map((item) => item.id)).toEqual([...PAGE_IDS]);
    expect(NAVIGATION_ITEMS.every((item) => item.label && item.description)).toBe(true);
  });

  it("recognizes real pages and rejects future modules", () => {
    expect(isPageId("sessions")).toBe(true);
    expect(isPageId("workspace")).toBe(false);
    expect(isPageId("automation")).toBe(false);
  });

  it("maps hashes and query parameters", () => {
    expect(pageFromLocation("#sessions")).toBe("sessions");
    expect(pageFromLocation("#unknown")).toBe("dashboard");
    expect(pageFromLocation("", "?page=profiles")).toBe("profiles");
    expect(pageFromLocation("#settings", "?page=sessions")).toBe("settings");
  });

  it("describes each navigation mode", () => {
    expect(navigationClass("sidebar")).toContain("agx-shell--nav-sidebar");
    expect(hasSidebar("sidebar")).toBe(true);
    expect(hasTopbar("sidebar")).toBe(false);
    expect(hasSidebar("combined")).toBe(true);
    expect(hasTopbar("combined")).toBe(true);
    expect(hasSidebar("top")).toBe(false);
    expect(hasTopbar("top")).toBe(true);
  });

  it("maps Alt shortcuts to pages", () => {
    expect(pageForShortcut("1")).toBe("dashboard");
    expect(pageForShortcut("4")).toBe("settings");
    expect(pageForShortcut("9")).toBeNull();
  });
});

describe("theme tokens", () => {
  it("provides every token for both themes", () => {
    expect(Object.keys(THEME_TOKENS.light)).toEqual(Object.keys(THEME_TOKENS.dark));
  });

  it("keeps body text at WCAG AA contrast in both themes", () => {
    for (const theme of ["light", "dark"] as const) {
      const tokens = THEME_TOKENS[theme];
      expect(contrastRatio(tokens.text, tokens.bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(tokens.text, tokens.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(tokens.muted, tokens.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(tokens.accentText, tokens.accent)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps focus and border indicators distinguishable", () => {
    for (const theme of ["light", "dark"] as const) {
      const tokens = THEME_TOKENS[theme];
      expect(contrastRatio(tokens.focus, tokens.bg)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(tokens.borderStrong, tokens.surface)).toBeGreaterThanOrEqual(1.2);
    }
  });

  it("computes luminance and contrast correctly", () => {
    expect(luminance("#000000")).toBe(0);
    expect(luminance("#ffffff")).toBeCloseTo(1, 5);
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
    expect(contrastRatio("#777777", "#777777")).toBeCloseTo(1, 5);
  });

  it("emits CSS custom properties for inline application", () => {
    const style = themeStyle("dark");
    expect(style[cssVariableName("bg")]).toBe(THEME_TOKENS.dark.bg);
    expect(style[cssVariableName("surfaceHover")]).toBe(THEME_TOKENS.dark.surfaceHover);
  });
});
