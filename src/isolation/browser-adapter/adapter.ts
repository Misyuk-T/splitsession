/**
 * Session Core — Browser Isolation Adapter (AEGOX_multisession).
 *
 * Common interface for browser-specific session isolation. Each supported browser
 * (Chromium, Firefox) implements this interface to provide independent cookie and
 * storage contexts per session.
 *
 * Pure TypeScript: no `chrome.*` references in the interface itself; implementations
 * live in browser-specific subfolders.
 *
 * Derived from SplitSession's isolation engine
 * (https://github.com/Misyuk-T/splitsession, MIT License).
 */

import type { SessionId } from "../../core/session-manager/session";

/** What an isolation adapter can guarantee for a session. */
export interface IsolationGuarantees {
  /** Cookies are isolated per session. */
  cookies: boolean;
  /** Local Storage is isolated per session. */
  localStorage: boolean;
  /** Session Storage is isolated per session (note: not persistent across restarts). */
  sessionStorage: boolean;
  /** IndexedDB is isolated per session. */
  indexedDB: boolean;
  /** Cache Storage is isolated per session. */
  cacheStorage: boolean;
  /** BroadcastChannel is isolated per session. */
  broadcastChannel: boolean;
  /** Service workers are blocked/refused for session contexts. */
  serviceWorkers: boolean;
  /** Shared workers are unavailable for session contexts. */
  sharedWorkers: boolean;
}

/** No browser provides complete isolation for all mechanisms. */
export const NO_ISOLATION: IsolationGuarantees = {
  cookies: false,
  localStorage: false,
  sessionStorage: false,
  indexedDB: false,
  cacheStorage: false,
  broadcastChannel: false,
  serviceWorkers: false,
  sharedWorkers: false,
};

/** All mechanisms isolated (ideal, rarely fully achievable). */
export const FULL_ISOLATION: IsolationGuarantees = {
  cookies: true,
  localStorage: true,
  sessionStorage: true,
  indexedDB: true,
  cacheStorage: true,
  broadcastChannel: true,
  serviceWorkers: true,
  sharedWorkers: true,
};

/** Result of checking whether a context is isolated for a session. */
export interface IsolationCheck {
  /** True if the context is isolated for this session. */
  isolated: boolean;
  /** Mechanisms that are NOT isolated (limitations). */
  notIsolated: string[];
  /** Human-readable explanation of limitations. */
  limitation?: string;
}

/** Context information for an isolation operation. */
export interface IsolationContext {
  /** The session ID. */
  sessionId: SessionId;
  /** The tab/window ID (browser-specific). */
  tabId?: number;
  /** The origin being isolated (scheme + host + port). */
  origin?: string;
  /** Whether this is the top frame or a sub-frame. */
  isTopFrame: boolean;
}

/** Common interface all browser isolation adapters must implement. */
export interface IsolationAdapter {
  /** Human-readable name of the browser (e.g. "Chrome", "Firefox"). */
  readonly browserName: string;

  /** What isolation guarantees this browser can provide. */
  readonly guarantees: IsolationGuarantees;

  /** Whether the adapter is initialized and ready. */
  readonly isReady: boolean;

  /** Initializes the adapter (call once at startup). */
  initialize(): Promise<void>;

  /**
   * Isolates a browsing context for a session.
   * Returns what was actually isolated and any limitations.
   */
  isolateContext(context: IsolationContext): Promise<IsolationCheck>;

  /**
   * Releases isolation for a context (e.g. when a tab is closed or session changes).
   */
  releaseContext(context: IsolationContext): Promise<void>;

  /**
   * Checks whether a given origin is managed/isolated for this session.
   */
  isOriginIsolated(sessionId: SessionId, origin: string): Promise<boolean>;

  /** Cleans up all isolation state for a session. */
  cleanupSession(sessionId: SessionId): Promise<void>;
}
