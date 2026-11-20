/**
 * Dashboard navigation model (AEGOX_multisession, Module 04).
 *
 * Only pages that exist in this module are listed. Future modules (Workspace
 * Manager, Automation, Security Manager, Backup, Analytics, MCP/AI) have no
 * navigation entries, so nothing is presented as implemented when it is not.
 */

import type { NavigationMode } from "./preferences";

export type { NavigationMode } from "./preferences";

export const PAGE_IDS = ["dashboard", "sessions", "profiles", "settings"] as const;
export type PageId = (typeof PAGE_IDS)[number];

export interface NavigationItem {
  id: PageId;
  label: string;
  /** Short text shown in compact navigation. */
  shortLabel: string;
  description: string;
  /** Keyboard shortcut digit (1-4) used with Alt. */
  shortcut: string;
}

export const NAVIGATION_ITEMS: ReadonlyArray<NavigationItem> = [
  {
    id: "dashboard",
    label: "Dashboard",
    shortLabel: "Home",
    description: "Overview, activity and customizable widgets",
    shortcut: "1",
  },
  {
    id: "sessions",
    label: "Sessions",
    shortLabel: "Sessions",
    description: "Compact, card and table views of Session Core data",
    shortcut: "2",
  },
  {
    id: "profiles",
    label: "Profiles",
    shortLabel: "Profiles",
    description: "Profile Manager profiles and favorites",
    shortcut: "3",
  },
  {
    id: "settings",
    label: "Appearance & settings",
    shortLabel: "Settings",
    description: "Theme, navigation, motion, text size and notifications",
    shortcut: "4",
  },
];

export function isPageId(value: unknown): value is PageId {
  return typeof value === "string" && (PAGE_IDS as ReadonlyArray<string>).includes(value);
}

/** Maps a hash or query value to a page. Unknown values open the dashboard. */
export function pageFromLocation(hash: string, search = ""): PageId {
  const fromHash = decodeURIComponent(hash.replace(/^#/, "")).trim();
  if (isPageId(fromHash)) return fromHash;
  const params = new URLSearchParams(search);
  const fromQuery = params.get("page");
  return isPageId(fromQuery) ? fromQuery : "dashboard";
}

/**
 * Combined navigation shows a sidebar plus a compact top bar on wide screens,
 * and only the top bar on narrow screens (see dashboard.css). This helper keeps
 * the class name logic testable.
 */
export function navigationClass(mode: NavigationMode): string {
  return `agx-shell agx-shell--nav-${mode}`;
}

/** Whether the sidebar is part of the layout for a given mode. */
export function hasSidebar(mode: NavigationMode): boolean {
  return mode !== "top";
}

/** Whether the top bar is part of the layout for a given mode. */
export function hasTopbar(mode: NavigationMode): boolean {
  return mode !== "sidebar";
}

/** Keyboard shortcut lookup: Alt+1..4. */
export function pageForShortcut(key: string): PageId | null {
  return NAVIGATION_ITEMS.find((item) => item.shortcut === key)?.id ?? null;
}
