/**
 * Session Core — Session Persistence (AEGOX_multisession).
 *
 * Continuous state persistence and configurable restoration.
 * Sessions survive browser restarts when the browser supports storage persistence.
 *
 * Pure TypeScript: delegates to a provided `StorageAreaLike`.
 *
 * Derived from SplitSession's TabRegistry and SavedTabsStore patterns
 * (https://github.com/Misyuk-T/splitsession, MIT License).
 */

import type { Session, SessionId, SessionState } from "../session-manager/session";
import type { StorageAreaLike } from "../../engine/storage/storage-area";

/** `chrome.storage.local` key for the persistence state. */
export const PERSISTENCE_STATE_KEY = "sessionPersistence";

/** Which sessions should be restored at startup. */
export type RestorationPolicy = "all" | "selected" | "none";

/** The persistence state saved to storage. */
export interface PersistenceState {
  /** Policy for which sessions to restore at startup. */
  restorationPolicy: RestorationPolicy;
  /** IDs of sessions to restore when policy is "selected". */
  selectedSessionIds: SessionId[];
  /** Last time the state was written (epoch ms). */
  lastWrittenAt: number;
  /** Whether automatic restoration is enabled. */
  autoRestore: boolean;
}

/** Default persistence state. */
export const DEFAULT_PERSISTENCE_STATE: PersistenceState = {
  restorationPolicy: "all",
  selectedSessionIds: [],
  lastWrittenAt: Date.now(),
  autoRestore: true,
};

/** Result of a restore operation. */
export interface RestoreResult {
  /** Sessions that were restored. */
  restored: Session[];
  /** Sessions that were skipped (not restorable, archived, or not selected). */
  skipped: Array<{ id: SessionId; reason: string }>;
  /** Whether restoration was successful overall. */
  ok: boolean;
}

/**
 * Manages persistence state and coordinates session restoration.
 * Works with a SessionManager to persist and restore sessions.
 */
export class SessionPersistence {
  private state: PersistenceState = { ...DEFAULT_PERSISTENCE_STATE };
  private writing: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly area: StorageAreaLike) {}

  /** Loads persistence state from storage. */
  async load(): Promise<void> {
    const stored = (await this.area.get(PERSISTENCE_STATE_KEY))[PERSISTENCE_STATE_KEY];
    if (
      stored &&
      typeof stored === "object" &&
      !Array.isArray(stored)
    ) {
      const s = stored as Record<string, unknown>;
      this.state = {
        restorationPolicy:
          typeof s.restorationPolicy === "string" &&
          (s.restorationPolicy === "all" ||
            s.restorationPolicy === "selected" ||
            s.restorationPolicy === "none")
            ? (s.restorationPolicy as RestorationPolicy)
            : DEFAULT_PERSISTENCE_STATE.restorationPolicy,
        selectedSessionIds:
          Array.isArray(s.selectedSessionIds) &&
          s.selectedSessionIds.every((id): id is string => typeof id === "string")
            ? [...s.selectedSessionIds]
            : [],
        lastWrittenAt:
          typeof s.lastWrittenAt === "number" ? s.lastWrittenAt : Date.now(),
        autoRestore:
          typeof s.autoRestore === "boolean" ? s.autoRestore : true,
      };
    }
  }

  /** Returns the current persistence state (copy). */
  getState(): PersistenceState {
    return { ...this.state };
  }

  /** Sets the restoration policy. */
  async setRestorationPolicy(policy: RestorationPolicy): Promise<void> {
    this.state.restorationPolicy = policy;
    this.state.lastWrittenAt = Date.now();
    await this.persist();
  }

  /** Sets the selected session IDs for "selected" policy. */
  async setSelectedSessions(ids: SessionId[]): Promise<void> {
    this.state.selectedSessionIds = [...new Set(ids)];
    this.state.lastWrittenAt = Date.now();
    await this.persist();
  }

  /** Enables or disables automatic restoration at startup. */
  async setAutoRestore(enabled: boolean): Promise<void> {
    this.state.autoRestore = enabled;
    this.state.lastWrittenAt = Date.now();
    await this.persist();
  }

  /**
   * Determines which sessions from the provided list should be restored,
   * based on the persistence policy and session states.
   */
  selectSessionsToRestore(allSessions: Session[]): Session[] {
    if (!this.state.autoRestore) return [];

    const restorable = allSessions.filter((s) => s.metadata.restorable);

    switch (this.state.restorationPolicy) {
      case "all":
        return restorable.filter((s) => s.state !== "closed");
      case "selected": {
        const selectedSet = new Set(this.state.selectedSessionIds);
        return restorable.filter((s) => selectedSet.has(s.id));
      }
      case "none":
        return [];
    }
  }

  /**
   * Given a list of candidate sessions and the sessions currently available,
   * produces a restore result with reasons for skipping.
   */
  computeRestore(
    candidates: Session[],
    available: Map<SessionId, Session>,
  ): RestoreResult {
    const toRestore = this.selectSessionsToRestore(candidates);
    const restored: Session[] = [];
    const skipped: Array<{ id: SessionId; reason: string }> = [];

    for (const s of candidates) {
      if (isClosedState(s.state)) {
        skipped.push({ id: s.id, reason: "Session is closed." });
        continue;
      }
      if (!s.metadata.restorable) {
        skipped.push({ id: s.id, reason: "Session is not marked restorable." });
        continue;
      }
      if (!this.shouldRestore(s)) {
        skipped.push({ id: s.id, reason: "Not selected by restoration policy." });
        continue;
      }
      const existing = available.get(s.id);
      if (existing && !isClosedState(existing.state)) {
        skipped.push({ id: s.id, reason: "Session already active." });
        continue;
      }
      restored.push(s);
    }

    return { restored, skipped, ok: true };
  }

  /** Continuous save: called whenever session state changes. */
  async markDirty(): Promise<void> {
    this.state.lastWrittenAt = Date.now();
    await this.persist();
  }

  private shouldRestore(session: Session): boolean {
    if (!this.state.autoRestore) return false;
    if (session.state === "closed") return false;
    if (!session.metadata.restorable) return false;

    switch (this.state.restorationPolicy) {
      case "all":
        return true;
      case "selected":
        return this.state.selectedSessionIds.includes(session.id);
      case "none":
        return false;
    }
  }

  private persist(): Promise<void> {
    this.writing = this.writing
      .then(() =>
        this.area.set({ [PERSISTENCE_STATE_KEY]: { ...this.state } }),
      )
      .catch(() => {});
    return this.writing;
  }
}

function isClosedState(state: SessionState): boolean {
  return state === "closed";
}
