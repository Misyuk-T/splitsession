/**
 * AEGOX dashboard UI system — public entry point (Module 04).
 *
 * Pure, browser-neutral policy used by the Preact dashboard:
 * theme tokens, preferences, widget layout, navigation, local search,
 * notification rules, session presentation and dashboard aggregation.
 */

export * from "./theme";
export * from "./preferences";
export * from "./widgets";
export * from "./navigation";
export * from "./search";
export * from "./session-presenter";
export * from "./dashboard-data";
export * from "./notifications";
// NavigationMode is re-exported from navigation.ts which imports it from preferences.ts
