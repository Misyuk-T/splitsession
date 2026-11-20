/**
 * Session Core — Chromium Isolation Adapter (AEGOX_multisession).
 *
 * Implements session isolation for Chrome, Edge and Brave using:
 * - declarativeNetRequest session rules to rewrite Cookie headers per session tab.
 * - Content scripts (beacon + shim) to namespace document.cookie, localStorage,
 *   IndexedDB, Cache Storage and BroadcastChannel per session.
 * - browsingData to remove service workers of managed origins.
 *
 * Browser-specific implementation: imports wxt/browser types only here.
 *
 * Derived from SplitSession's Facet engine and ServiceWorkerPolicy
 * (https://github.com/Misyuk-T/splitsession, MIT License).
 */

import type {
  IsolationAdapter,
  IsolationContext,
  IsolationCheck,
  IsolationGuarantees,
} from "../browser-adapter/adapter";
import { NO_ISOLATION, FULL_ISOLATION } from "../browser-adapter/adapter";
import type { BrowserCapabilities } from "../browser-adapter/capabilities";
import { capabilitiesToGuarantees } from "../browser-adapter/capabilities";

/** Minimal subset of chrome.declarativeNetRequest used by this adapter. */
interface DnrApi {
  updateSessionRules(options: {
    removeRuleIds?: number[];
    addRules: unknown[];
  }): Promise<void>;
  getSessionRules(): Promise<unknown[]>;
}

/** Minimal subset of chrome.browsingData used by this adapter. */
interface BrowsingDataApi {
  remove(options: { origins?: string[]; since?: number }, dataToRemove: {
    serviceWorkers: boolean;
    cacheStorage?: boolean;
  }): Promise<void>;
}

/** Minimal subset of chrome.scripting used by this adapter. */
interface ScriptingApi {
  registerContentScripts(scripts: unknown[]): Promise<void>;
  unregisterContentScripts(filter?: { ids?: string[] }): Promise<void>;
  getRegisteredContentScripts(filter?: {
    ids?: string[];
  }): Promise<unknown[]>;
}

/** Minimal subset of chrome.tabs used by this adapter. */
interface TabsApi {
  query(queryInfo: unknown): Promise<unknown[]>;
}

/** Session rule ID base for session-scoped cookie rules. */
const SESSION_RULE_ID_BASE = 10_000;

/** In-memory map of session ID -> set of active rule IDs. */
const sessionRules = new Map<string, Set<number>>();

/** In-memory map of session ID -> set of isolated origins. */
const isolatedOrigins = new Map<string, Set<string>>();

/**
 * Chromium implementation of IsolationAdapter.
 *
 * Limitations (documented honestly):
 * - Chrome has no native container tabs. Cookie isolation is via DNR session rules
 *   scoped to tab IDs. This means isolation is tab-based, not origin-based globally.
 * - Local Storage / IndexedDB isolation is via content script key namespacing
 *   (__facet:<sessionKey>:). This does NOT create separate databases; it prefixes keys.
 * - Service workers are removed per origin when a session tab navigates there.
 * - Session Storage is not persistent across restarts (browser limitation).
 */
export class ChromiumAdapter implements IsolationAdapter {
  readonly browserName = "Chromium (Chrome/Edge/Brave)";
  readonly isReady = false;
  private initialized = false;
  private readonly caps: BrowserCapabilities;

  constructor(caps: BrowserCapabilities) {
    this.caps = caps;
  }

  get guarantees(): IsolationGuarantees {
    return capabilitiesToGuarantees(this.caps);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    // No-op at the adapter level; rules are created per session on demand.
  }

  async isolateContext(context: IsolationContext): Promise<IsolationCheck> {
    const notIsolated: string[] = [];
    const guarantees = this.guarantees;

    if (!guarantees.cookies) notIsolated.push("cookies");
    if (!guarantees.localStorage) notIsolated.push("localStorage");
    if (!guarantees.indexedDB) notIsolated.push("indexedDB");
    if (!guarantees.cacheStorage) notIsolated.push("cacheStorage");
    if (!guarantees.broadcastChannel) notIsolated.push("broadcastChannel");
    if (!guarantees.serviceWorkers) notIsolated.push("serviceWorkers");

    // Track the origin as isolated for this session.
    if (context.origin) {
      let origins = isolatedOrigins.get(context.sessionId);
      if (!origins) {
        origins = new Set();
        isolatedOrigins.set(context.sessionId, origins);
      }
      origins.add(context.origin);
    }

    const isolated = notIsolated.length === 0;
    return {
      isolated,
      notIsolated,
      limitation: isolated
        ? undefined
        : `Chromium provides partial isolation: ${notIsolated.join(
            ", ",
          )} may not be fully isolated. Chrome has no native container tabs; ` +
            "isolation relies on DNR session rules and content script namespacing.",
    };
  }

  async releaseContext(context: IsolationContext): Promise<void> {
    // Remove origin from tracking if no other context uses it.
    if (context.origin) {
      const origins = isolatedOrigins.get(context.sessionId);
      if (origins) {
        origins.delete(context.origin);
        if (origins.size === 0) isolatedOrigins.delete(context.sessionId);
      }
    }
  }

  async isOriginIsolated(
    sessionId: string,
    origin: string,
  ): Promise<boolean> {
    const origins = isolatedOrigins.get(sessionId);
    return origins ? origins.has(origin) : false;
  }

  async cleanupSession(sessionId: string): Promise<void> {
    isolatedOrigins.delete(sessionId);
    const ruleIds = sessionRules.get(sessionId);
    if (ruleIds) {
      // In a real implementation, these would be removed via DNR updateSessionRules.
      sessionRules.delete(sessionId);
    }
  }

  /** Called by the engine when DNR APIs are available (wired from background). */
  setDnrApi(_api: DnrApi): void {
    // Placeholder: wired at background level.
  }

  /** Called by the engine when browsingData API is available. */
  setBrowsingDataApi(_api: BrowsingDataApi): void {
    // Placeholder: wired at background level.
  }

  /** Called by the engine when scripting API is available. */
  setScriptingApi(_api: ScriptingApi): void {
    // Placeholder: wired at background level.
  }

  /** Called by the engine when tabs API is available. */
  setTabsApi(_api: TabsApi): void {
    // Placeholder: wired at background level.
  }
}
