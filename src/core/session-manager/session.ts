/**
 * Session Core — Session types (AEGOX_multisession).
 *
 * Pure data types: no `chrome.*` references. Derived from SplitSession's `Container` model,
 * extended with AEGOX session lifecycle states and metadata.
 *
 * Derived from: https://github.com/Misyuk-T/splitsession (MIT License)
 */

export type SessionId = string;

/** Stable lifecycle states for a session. */
export type SessionState =
  | "active"
  | "paused"
  | "expired"
  | "archived"
  | "closed";

/** How a session was created. */
export type SessionOrigin = "manual" | "automatic";

/** Metadata associated with a session. */
export interface SessionMetadata {
  /** Human-readable name, customizable by the user. */
  name: string;
  /** Main domain associated with the session (registrable domain or host). */
  domain: string | null;
  /** Owning profile identifier. */
  profileId: string | null;
  /** When the session was created (epoch ms). */
  createdAt: number;
  /** When the session was last used (epoch ms). */
  lastUsedAt: number | null;
  /** Whether persistence is enabled for this session. */
  persistent: boolean;
  /** Whether restoration is enabled after browser restart. */
  restorable: boolean;
}

/** One session: an isolated browsing context with its own cookies and storage. */
export interface Session {
  /** Unique identifier (UUID). Never changes during the session's lifetime. */
  id: SessionId;
  /** Current lifecycle state. */
  state: SessionState;
  /** Session metadata. */
  metadata: SessionMetadata;
}

/** Result of creating a session. */
export interface SessionCreated {
  session: Session;
  /** True if a session with the same domain/profile already existed (not merged). */
  duplicateDetected: boolean;
}

/** Validation result for session metadata. */
export type SessionValidation =
  | { ok: true; metadata: SessionMetadata }
  | { ok: false; message: string };

/** Maximum length for a session name (UI-level; store tolerates more). */
export const MAX_SESSION_NAME = 64;

/** Minimum length for a session name. */
export const MIN_SESSION_NAME = 1;

/** Default profile ID when none is specified. */
export const DEFAULT_PROFILE_ID = "default";

/** Generates a UUID v4-style identifier (lowercase hex, 32 chars + 4 dashes). */
export function generateSessionId(random: () => number = Math.random): SessionId {
  const r = (n: number): string =>
    Math.floor(random() * n).toString(16).padStart(2, "0");
  return [
    r(256) + r(256) + r(256) + r(256) + r(256) + r(256) + r(256) + r(256), // 128 bits
    "4", // version 4
    r(15) & 0x3, // variant bits
    r(256) + r(256),
    r(256) + r(256) + r(256) + r(256) + r(256) + r(256) + r(256) + r(256) + r(256) + r(256) + r(256) + r(256),
  ].join("");
}

/** Collapses whitespace in a session name (same convention as container names). */
export const collapseSessionName = (raw: string): string =>
  raw.replace(/\s+/g, " ").trim();

/** Sanitizes raw user input for a session name while typing. */
export function sanitizeSessionNameInput(
  raw: string,
  max: number = MAX_SESSION_NAME,
): string {
  const kept = Array.from(raw)
    .filter((ch) => !isStrippable(ch.codePointAt(0)!))
    .join("")
    .replace(/^\s+/, "");
  return Array.from(kept).slice(0, max).join("");
}

/** Control characters, zero-width characters, bidi overrides, byte-order mark. */
function isStrippable(cp: number): boolean {
  return (
    cp <= 0x1f ||
    (cp >= 0x7f && cp <= 0x9f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x2028 && cp <= 0x202e) ||
    cp === 0x2060 ||
    cp === 0xfeff
  );
}

/** Validates session metadata as the user types. */
export function validateSessionMetadata(
  raw: {
    name?: unknown;
    domain?: unknown;
    profileId?: unknown;
    persistent?: unknown;
    restorable?: unknown;
  },
  existingNames: readonly string[],
  ownName?: string,
): SessionValidation {
  const nameRaw = typeof raw.name === "string" ? raw.name : "";
  const name = collapseSessionName(nameRaw);
  if (name.length < MIN_SESSION_NAME) {
    return { ok: false, message: "Give the session a name." };
  }
  if (Array.from(name).length > MAX_SESSION_NAME) {
    return {
      ok: false,
      message: `Use at most ${MAX_SESSION_NAME} characters.`,
    };
  }
  const lower = name.toLowerCase();
  const ownLower =
    ownName === undefined ? undefined : collapseSessionName(ownName).toLowerCase();
  if (
    existingNames.some(
      (n) => collapseSessionName(n).toLowerCase() === lower && lower !== ownLower,
    )
  ) {
    return {
      ok: false,
      message: `A session named “${name}” already exists.`,
    };
  }

  let domain: string | null = null;
  if (raw.domain !== undefined && raw.domain !== null && raw.domain !== "") {
    if (typeof raw.domain !== "string") {
      return { ok: false, message: "Domain must be a text address." };
    }
    const trimmed = raw.domain.trim();
    if (trimmed !== "") {
      // Accept http(s) URLs or bare hosts; reduce to host only.
      try {
        const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
          ? new URL(trimmed)
          : new URL(`http://${trimmed}`);
        domain = url.hostname.toLowerCase();
      } catch {
        return { ok: false, message: "That does not look like a site address." };
      }
    }
  }

  let profileId: string | null = null;
  if (raw.profileId !== undefined && raw.profileId !== null) {
    if (typeof raw.profileId !== "string" || raw.profileId === "") {
      return { ok: false, message: "Profile must be a text identifier." };
    }
    profileId = raw.profileId;
  }

  const persistent =
    typeof raw.persistent === "boolean" ? raw.persistent : true;
  const restorable =
    typeof raw.restorable === "boolean" ? raw.restorable : true;

  return {
    ok: true,
    metadata: {
      name,
      domain,
      profileId: profileId ?? DEFAULT_PROFILE_ID,
      createdAt: Date.now(),
      lastUsedAt: null,
      persistent,
      restorable,
    },
  };
}

/** Creates a fresh `Session` from validated metadata. */
export function createSession(
  metadata: SessionMetadata,
  id?: SessionId,
): Session {
  return {
    id: id ?? generateSessionId(),
    state: "active",
    metadata: {
      ...metadata,
      lastUsedAt: Date.now(),
    },
  };
}

/** Checks whether a session's metadata looks like a duplicate of another. */
export function isDuplicateSession(
  a: Session,
  b: Session,
): boolean {
  return (
    a.metadata.domain !== null &&
    a.metadata.domain === b.metadata.domain &&
    a.metadata.profileId === b.metadata.profileId
  );
}
