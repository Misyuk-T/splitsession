import { useCallback, useEffect, useMemo, useState } from "preact/hooks";

import { resolveTheme, type ThemePreference } from "../../ui-system/preferences";
import { THEME_TOKENS, type EffectiveTheme } from "../../ui-system/theme";

/**
 * Applies the AEGOX theme tokens, text scale and animation policy to the
 * document root. Reads `prefers-color-scheme` for the `system` preference and
 * persists nothing itself — the caller (Dashboard) owns persistence.
 */
export interface DashboardThemeProps {
  preference: ThemePreference;
  textScale: number;
  animations: "full" | "reduced" | "none";
  onChange?: (next: ThemePreference) => void;
}

export const DashboardTheme = ({
  preference,
  textScale,
  animations,
  onChange,
}: DashboardThemeProps) => {
  const [systemDark, setSystemDark] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    setSystemDark(media.matches);
    media.addEventListener("change", handler);
    return () => media.removeEventListener("change", handler);
  }, []);

  const effective = useMemo(() => resolveTheme(preference, systemDark), [
    preference,
    systemDark,
  ]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.agxTheme = effective;
    root.classList.remove(
      "agx-text-scale-100",
      "agx-text-scale-110",
      "agx-text-scale-120",
      "agx-text-scale-130",
      "agx-reduced",
      "agx-animations-none",
    );
    root.classList.add(`agx-text-scale-${textScale}`);
    if (animations === "reduced") root.classList.add("agx-reduced");
    if (animations === "none") root.classList.add("agx-animations-none");

    const tokens = THEME_TOKENS[effective];
    for (const [key, value] of Object.entries(tokens)) {
      root.style.setProperty(`--agx-${key.replace(/[A-Z]/g, (l) => `-${l.toLowerCase()}`)}`, value);
    }
  }, [effective, textScale, animations]);

  return null;
};
