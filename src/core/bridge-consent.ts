/**
 * The user's consent to the agent bridge (Full edition only; docs/decisions.md, "The store item becomes Full"). The Chrome
 * Web Store's disclosure rule asks for affirmative, informed consent before the extension hands page content to another
 * program, so the switch only turns on after the user has accepted the disclosure dialog (`BridgeConsentDialog`) once. The
 * record is a key of its own in `chrome.storage.local`: Lite and older builds never read it (a rollback is unaffected),
 * and the settings format does not change. Pure logic only; the store is src/background/bridge/consent.ts.
 */

/** `chrome.storage.local` key of the consent record. */
export const BRIDGE_CONSENT_KEY = "agentBridgeConsent";

/**
 * The version of the disclosure text the user accepts. Raise it when the dialog says something materially new (a new kind
 * of data, a new recipient): every install then has to accept again before the bridge turns on.
 */
export const BRIDGE_CONSENT_VERSION = 1;

/** What is stored: which text version was accepted, and when (ms since the epoch). */
export interface BridgeConsent {
  version: number;
  at: number;
}

/** Tolerant reader: anything that is not a well-formed record is "no consent". */
export function readBridgeConsent(raw: unknown): BridgeConsent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { version, at } = raw as Record<string, unknown>;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1)
    return null;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  return { version, at };
}

/** Consent counts only for the current text (or a newer one, written by a later build before a rollback). */
export function hasBridgeConsent(
  raw: unknown,
  current: number = BRIDGE_CONSENT_VERSION,
): boolean {
  const consent = readBridgeConsent(raw);
  return consent !== null && consent.version >= current;
}

/** The error of an attempt to switch the bridge on without consent (shown by the switch if it ever gets there). */
export const NO_CONSENT_MESSAGE =
  "the agent bridge stays off until you allow agent access in SplitSession's settings";

/**
 * The store build asks Chrome for `nativeMessaging` at runtime (an optional permission; the unpacked Full has it from install),
 * and the bridge cannot be on without it.
 */
export const NATIVE_MESSAGING = "nativeMessaging";
/** The error of an attempt to switch the bridge on while Chrome has not granted `nativeMessaging`. */
export const NO_PERMISSION_MESSAGE =
  "the agent bridge needs Chrome's permission to talk to a program on this computer; switch it on in SplitSession's settings";
