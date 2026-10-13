/** Constants of container tabs that come back (`core/restore.ts`). */

/** `chrome.storage.local`: records of container tabs (open and closed) and signatures of windows. */
export const RESTORE_STATE_KEY = "restoreState";
/** Dynamic rule IDs of the gate: [base, base + MAX_GATE_RULES). The service-worker policy uses IDs 1 and 2. */
export const GATE_RULE_ID_BASE = 1000;
export const MAX_GATE_RULES = 500;
/**
 * Priority of the gate (dynamic `block`) and of the session `allow` rules that open it for known tabs. At equal
 * priority `allow` beats `block`; an `allow` also cancels every `modifyHeaders` rule of the same or lower priority,
 * which is why every cookie rule of SplitSession sits at 2 or above (`CATCH_ALL_PRIORITY`). Measured in Chromium 156.
 */
export const GATE_PRIORITY = 1;
export const MAX_RECORDS = 400;
/** A closed tab whose recently-closed entry has not been found yet stays restorable this long. */
export const CLOSED_GRACE_MS = 60_000;
/** A whole SplitSession group that was closed (Chrome keeps it as a saved group) stays restorable this long. */
export const SAVED_GROUP_TTL_MS = 30 * 24 * 3600_000;
export const WINDOW_TTL_MS = 7 * 24 * 3600_000;
/**
 * How long after a browser start windows that come late (Chrome's "Restore pages?" after a crash, a slow restore) are
 * still matched against the previous session.
 */
export const STARTUP_GRACE_MS = 5 * 60_000;
