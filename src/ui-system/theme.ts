/**
 * AEGOX theme tokens (AEGOX_multisession, Module 04).
 *
 * One restrained violet identity, completed for both light and dark. The UI
 * applies these as CSS custom properties, so components never hard-code
 * colours and tests can verify real contrast values.
 */

export type EffectiveTheme = "light" | "dark";

export interface ThemeTokens {
  bg: string;
  surface: string;
  surfaceRaised: string;
  surfaceHover: string;
  text: string;
  muted: string;
  border: string;
  borderStrong: string;
  accent: string;
  accentHover: string;
  accentText: string;
  accentSoft: string;
  danger: string;
  dangerSoft: string;
  warning: string;
  warningSoft: string;
  ok: string;
  okSoft: string;
  focus: string;
  /** Ring drawn around focused interactive elements. */
  focusRing: string;
  shadow: string;
  gridLine: string;
  /** Height of the top navigation bar. */
  headerHeight: string;
  /** Width of the sidebar navigation panel. */
  sidebarWidth: string;
}

/** Layout constants exposed as CSS custom properties. */
export const LAYOUT_TOKENS: Readonly<Record<string, string>> = {
  headerHeight: "56px",
  sidebarWidth: "260px",
};

/** Restrained dark + violet is the brand direction; light is equally complete. */
export const THEME_TOKENS: Readonly<Record<EffectiveTheme, ThemeTokens>> = {
  light: {
    bg: "#f7f6fb",
    surface: "#ffffff",
    surfaceRaised: "#ffffff",
    surfaceHover: "#f0edf8",
    text: "#16131f",
    muted: "#5b5568",
    border: "#ddd7e8",
    borderStrong: "#bdb3cf",
    accent: "#5b3fd6",
    accentHover: "#4a30bd",
    accentText: "#ffffff",
    accentSoft: "#ece7ff",
    danger: "#b3261e",
    dangerSoft: "#fbe9e7",
    warning: "#7a5300",
    warningSoft: "#fff4d6",
    ok: "#146c3c",
    okSoft: "#dcf3e5",
    focus: "#5b3fd6",
    shadow: "0 10px 30px rgba(35, 22, 70, 0.12), 0 1px 3px rgba(35, 22, 70, 0.08)",
    gridLine: "#e9e4f2",
    focusRing: "rgba(91, 63, 214, 0.35)",
    headerHeight: "56px",
    sidebarWidth: "260px",
  },
  dark: {
    bg: "#121018",
    surface: "#1a1722",
    surfaceRaised: "#211d2c",
    surfaceHover: "#2a2438",
    text: "#efeaf7",
    muted: "#aaa1bb",
    border: "#332c42",
    borderStrong: "#4b4160",
    accent: "#a794ff",
    accentHover: "#bcadff",
    accentText: "#16101f",
    accentSoft: "#2b2444",
    danger: "#ff8a80",
    dangerSoft: "#3a2220",
    warning: "#f2c66d",
    warningSoft: "#3a2f12",
    ok: "#67d99a",
    okSoft: "#153a26",
    focus: "#b9a8ff",
    shadow: "0 14px 34px rgba(0, 0, 0, 0.55), 0 1px 3px rgba(0, 0, 0, 0.4)",
    gridLine: "#292335",
    focusRing: "rgba(185, 168, 255, 0.4)",
    headerHeight: "56px",
    sidebarWidth: "260px",
  },
};

/** CSS variable name for a token key. */
export function cssVariableName(key: keyof ThemeTokens): string {
  return `--agx-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

/** Inline style object applied to the dashboard root. */
export function themeStyle(theme: EffectiveTheme): Record<string, string> {
  const tokens = THEME_TOKENS[theme];
  const style: Record<string, string> = {};
  for (const [key, value] of Object.entries(tokens)) {
    style[cssVariableName(key as keyof ThemeTokens)] = value;
  }
  return style;
}

function channel(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.03928
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance of a `#rrggbb` colour. */
export function luminance(hex: string): number {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match?.[1]) throw new Error(`Expected a #rrggbb colour, got "${hex}"`);
  const int = Number.parseInt(match[1], 16);
  return (
    0.2126 * channel((int >> 16) & 0xff) +
    0.7152 * channel((int >> 8) & 0xff) +
    0.0722 * channel(int & 0xff)
  );
}

/** WCAG contrast ratio between two `#rrggbb` colours (1..21). */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [light, dark] = la > lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
}
