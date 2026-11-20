/**
 * Session Core — Session Manager (AEGOX_multisession).
 *
 * Business logic for session CRUD, duplicate detection, and metadata management.
 * Pure TypeScript: delegates persistence to a provided `StorageAreaLike`.
 *
 * Derived from SplitSession's `ContainerStore` pattern
 * (https://github.com/Misyuk-T/splitsession, MIT License).
 */

import {
  createSession,
  DEFAULT_PROFILE_ID,
  isDuplicateSession,
  MAX_SESSION_NAME,
  MIN_SESSION_NAME,
  validateSessionMetadata,
} from "./session";
import type {
  Session,
  SessionId,
  SessionCreated,
  SessionMetadata,
  SessionState,
} from "./session";
import type { StorageAreaLike } from "../../engine/storage/storage-area";

/** `chrome.storage.local` key holding the session list. */
export const SESSIONS_KEY = "sessions";

/** Error thrown by the session manager. */
export class SessionError extends Error {}

function isSession(x: unknown): x is Session {
  if (typeof x !== "object" || x === null) return false;
  const s = x as Record<string, unknown>;
  return (
    typeof s.id === "string" &&
    typeof s.state === "string" &&
    typeof s.metadata === "object" &&
    s.metadata !== null &&
    typeof (s.metadata as Record<string, unknown>).name === "string" &&
    typeof (s.metadata as Record<string, unknown>).createdAt === "number"
  );
}

/** Options for the session manager. */
export interface SessionManagerOptions {
  /** Debounce for session metadata writes (ms). Default 150 ms. */
  debounceMs?: number;
  /** Now function (ms). Default Date.now. */
  now?: () => number;
  /** Random function for ID generation. Default Math.random. */
  random?: () => number;
}

/**
 * Manages sessions in memory with persisted backup to storage.
 * Sessions are the user's top-level grouping for isolated browsing contexts.
 */
export class SessionManager {
  private sessions = new Map<SessionId, Session>();
  private writing: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly debounceMs: number;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(
    private readonly area: StorageAreaLike,
    options: SessionManagerOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? 150;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  /** Loads sessions from storage. Invalid entries are dropped. */
  async load(): Promise<void> {
    const stored = (await this.area.get(SESSIONS_KEY))[SESSIONS_KEY];
    this.sessions = new Map();
    if (Array.isArray(stored)) {
      for (const item of stored) {
        if (isSession(item)) this.sessions.set(item.id, { ...item });
      }
    }
  }

  /** Returns a copy of all sessions. */
  list(): Session[] {
    return [...this.sessions.values()].map((s) => ({ ...s }));
  }

  /** Returns a session by ID, or undefined. */
  get(id: SessionId): Session | undefined {
    const found = this.sessions.get(id);
    return found ? { ...found } : undefined;
  }

  /** Finds a session by exact ID first, then by case-insensitive name. */
  resolve(ref: string): Session | undefined {
    return this.get(ref) ?? this.findByName(ref);
  }

  /** Finds a session by case-insensitive name. */
  findByName(name: string): Session | undefined {
    const wanted = name.trim().toLowerCase();
    const found = [...this.sessions.values()].find(
      (s) => s.metadata.name.toLowerCase() === wanted,
    );
    return found ? { ...found } : undefined;
  }

  /** Returns the names of all existing sessions (for duplicate checks). */
  existingNames(): string[] {
    return [...this.sessions.values()].map((s) => s.metadata.name);
  }

  /**
   * Creates a new session from validated metadata.
   * Throws `SessionError` if validation fails or a duplicate name exists.
   * Returns duplicate detection info based on domain + profile.
   */
  async create(
    raw: {
      name?: unknown;
      domain?: unknown;
      profileId?: unknown;
      persistent?: unknown;
      restorable?: unknown;
    },
  ): Promise<SessionCreated> {
    const existing = this.existingNames();
    const validation = validateSessionMetadata(raw, existing, undefined);
    if (!validation.ok) {
      throw new SessionError(validation.message);
    }

    const metadata: SessionMetadata = {
      ...validation.metadata,
      createdAt: this.now(),
    };
    const session = createSession(metadata);
    // Detect duplicate by domain + profile (not by name).
    const duplicateDetected = this.hasDuplicateDomainProfile(session);

    this.sessions.set(session.id, session);
    await this.persist();
    return { session: { ...session }, duplicateDetected };
  }

  /** Creates a session under a given ID (used for restore/import). */
  async createWithId(input: {
    id: SessionId;
    name: string;
    domain?: string | null;
    profileId?: string | null;
    state?: SessionState;
  }): Promise<Session> {
    if (!/^[a-z0-9-]{1,64}$/.test(input.id)) {
      throw new SessionError(`invalid session ID "${input.id}"`);
    }
    if (this.sessions.has(input.id)) {
      throw new SessionError(`a session "${input.id}" already exists`);
    }
    const existing = this.existingNames();
    const validation = validateSessionMetadata(
      { name: input.name, domain: input.domain, profileId: input.profileId },
      existing,
    );
    if (!validation.ok) {
      throw new SessionError(validation.message);
    }

    const session: Session = {
      id: input.id,
      state: input.state ?? "active",
      metadata: {
        ...validation.metadata,
        profileId: input.profileId ?? DEFAULT_PROFILE_ID,
        createdAt: this.now(),
      },
    };
    this.sessions.set(session.id, session);
    await this.persist();
    return { ...session };
  }

  /** Updates session metadata by ID. */
  async update(
    id: SessionId,
    patch: Partial<SessionMetadata> & { state?: SessionState },
  ): Promise<Session> {
    const session = this.sessions.get(id);
    if (!session) throw new SessionError(`no session "${id}"`);

    const existing = this.existingNames();
    const validation = validateSessionMetadata(
      {
        name: patch.name ?? session.metadata.name,
        domain: patch.domain ?? session.metadata.domain,
        profileId: patch.profileId ?? session.metadata.profileId,
        persistent: patch.persistent ?? session.metadata.persistent,
        restorable: patch.restorable ?? session.metadata.restorable,
      },
      existing,
      session.metadata.name,
    );
    if (!validation.ok) {
      throw new SessionError(validation.message);
    }

    session.metadata = {
      ...session.metadata,
      ...validation.metadata,
      // Validation describes a new object; keep the real timestamps.
      createdAt: session.metadata.createdAt,
      lastUsedAt: session.metadata.lastUsedAt,
    };
    if (patch.state !== undefined) session.state = patch.state;
    await this.persist();
    return { ...session };
  }

  /** Changes only the lifecycle state of a session. */
  async setState(id: SessionId, state: SessionState): Promise<Session> {
    const session = this.sessions.get(id);
    if (!session) throw new SessionError(`no session "${id}"`);
    session.state = state;
    await this.persist();
    return { ...session };
  }

  /** Deletes a session by ID. Returns false if not found. */
  async delete(id: SessionId): Promise<boolean> {
    if (!this.sessions.delete(id)) return false;
    await this.persist();
    return true;
  }

  /** Returns true if any existing session shares domain + profile (not name). */
  private hasDuplicateDomainProfile(session: Session): boolean {
    return [...this.sessions.values()].some(
      (s) => s.id !== session.id && isDuplicateSession(s, session),
    );
  }

  /** Writes sessions to storage (debounced). */
  private persist(): Promise<void> {
    const snapshot = [...this.sessions.values()].map((s) => ({ ...s }));
    this.writing = this.writing
      .then(() => this.area.set({ [SESSIONS_KEY]: snapshot }))
      .catch(() => {});
    return this.writing;
  }
}
