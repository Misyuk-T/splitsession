/**
 * Session Core — Browser Capabilities Detection (AEGOX_multisession).
 *
 * Detects which isolation mechanisms are available in the current browser.
 * Chrome, Edge, Brave and Firefox have different APIs; we never claim
 * capabilities that don't exist.
 *
 * Pure TypeScript: no `chrome.*` references. Browser-specific feature detection
 * lives in the adapter implementations.
 *
 * Derived from SplitSession's isolation decisions
 * (https://github.com/Misyuk-T/splitsession, MIT License).
 */

import type { IsolationGuarantees } from "./adapter";

/** Known browser families. */
export type BrowserFamily = "chromium" | "firefox" | "unknown";

/** Capabilities reported by the running browser. */
export interface BrowserCapabilities {
  family: BrowserFamily;
  name: string;
  version: string | null;

  /** Container Tabs API (Firefox native). */
  hasContainerTabs: boolean;
  /** declarativeNetRequest session rules (Chromium). */
  hasDnrSessionRules: boolean;
  /** Content script registration at document_start (Chromium/Firefox). */
  hasContentScripts: boolean;
  /** storage.session / storage.local (Chromium/Firefox). */
  hasStorageApi: boolean;
  /** webRequest / declarativeNetRequest header modification (Chromium). */
  hasHeaderModification: boolean;
  /** browsingData API (Chromium). */
  hasBrowsingData: boolean;
  /** tabGroups API (Chromium/Firefox). */
  hasTabGroups: boolean;
}

/** Detects browser family from user agent (best-effort, never authoritative). */
export function detectBrowserFamily(userAgent: string): BrowserFamily {
  const ua = userAgent.toLowerCase();
  if (ua.includes("firefox")) return "firefox";
  if (ua.includes("chromium") || ua.includes("chrome")) return "chromium";
  return "unknown";
}

/** Default capabilities when nothing is known (safe direction: claim nothing). */
export const DEFAULT_CAPABILITIES: BrowserCapabilities = {
  family: "unknown",
  name: "Unknown Browser",
  version: null,
  hasContainerTabs: false,
  hasDnrSessionRules: false,
  hasContentScripts: false,
  hasStorageApi: false,
  hasHeaderModification: false,
  hasBrowsingData: false,
  hasTabGroups: false,
};

/**
 * Translates browser capabilities into isolation guarantees.
 * We only claim isolation for mechanisms the browser actually supports.
 */
export function capabilitiesToGuarantees(
  caps: BrowserCapabilities,
): IsolationGuarantees {
  const g: IsolationGuarantees = {
    cookies: false,
    localStorage: false,
    sessionStorage: false,
    indexedDB: false,
    cacheStorage: false,
    broadcastChannel: false,
    serviceWorkers: false,
    sharedWorkers: false,
  };

  if (caps.hasContainerTabs) {
    // Firefox native containers provide cookie + storage isolation per container tab.
    g.cookies = true;
    g.localStorage = true;
    g.sessionStorage = true;
    g.indexedDB = true;
    g.cacheStorage = true;
    g.broadcastChannel = true;
  }

  if (caps.hasContentScripts && caps.hasStorageApi) {
    // Content scripts can namespace storage keys per session.
    g.localStorage = true;
    g.sessionStorage = true;
    g.indexedDB = true;
    g.cacheStorage = true;
    g.broadcastChannel = true;
    // Firefox containers also give a separate service-worker registration per
    // cookie store, so workers do not share a jar across containers.
    g.serviceWorkers = true;
  }

  if (caps.hasDnrSessionRules && caps.hasHeaderModification) {
    // DNR can rewrite Cookie headers per tab/session.
    g.cookies = true;
  }

  if (caps.hasBrowsingData) {
    // Can remove service workers for managed origins.
    g.serviceWorkers = true;
  }

  return g;
}

/**
 * Describes limitations in plain language for the user.
 * Never claims complete isolation when it isn't available.
 */
export function describeLimitations(
  caps: BrowserCapabilities,
): string[] {
  const limitations: string[] = [];

  if (!caps.hasContainerTabs && !caps.hasContentScripts) {
    limitations.push(
      "This browser does not provide content script injection or native containers. " +
        "Session storage isolation is limited.",
    );
  }

  if (!caps.hasDnrSessionRules) {
    limitations.push(
      "Cookie header rewriting is not available. Cross-account cookie isolation " +
        "may be incomplete.",
    );
  }

  if (!caps.hasBrowsingData) {
    limitations.push(
      "Service worker removal is not available. Workers from other accounts " +
        "may answer requests in session contexts.",
    );
  }

  if (caps.family === "unknown") {
    limitations.push(
      "Browser family could not be detected. Isolation guarantees are conservative.",
    );
  }

  // Session Storage is never persistent across restarts in any browser.
  limitations.push(
    "Session Storage does not survive browser restarts by design. " +
      "Only Local Storage, IndexedDB and cookies are persistent.",
  );

  return limitations;
}
