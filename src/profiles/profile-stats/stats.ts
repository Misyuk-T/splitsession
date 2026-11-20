/**
 * Profile Manager — Profile Statistics (AEGOX_multisession).
 *
 * Optional, local, aggregate counters per profile. Nothing here identifies a
 * website, a page or a person: only counts and timestamps. The future Analytics
 * module can persist these records through `ProfileStatsStore`.
 *
 * Pure TypeScript: no `chrome.*` references.
 *
 * Derived from SplitSession's statistics patterns
 * (https://github.com/Misyuk-T/splitsession, MIT License).
 */

import type { ProfileId } from "../profile-manager/profile";

/** Statistics for a single profile. */
export interface ProfileStats {
  profileId: ProfileId;
  /** Sessions currently associated with the profile. */
  sessionCount: number;
  /** Sessions in the `active` state. */
  activeSessionCount: number;
  /** Last time the profile was used (epoch ms), or null. */
  lastAccessedAt: number | null;
  /** Number of times the profile was switched to. */
  switchCount: number;
  /** Timestamp of the first recorded activity (epoch ms), or null. */
  firstUsedAt: number | null;
}

/** Aggregate counters across profiles. */
export interface AggregateStats {
  totalProfiles: number;
  /** Profiles with at least one active session. */
  activeProfiles: number;
  totalSessions: number;
  totalActiveSessions: number;
  totalSwitches: number;
}

/** Persistence boundary for a future Analytics module. */
export interface ProfileStatsStore {
  load(): Promise<ProfileStats[]>;
  save(stats: ProfileStats[]): Promise<void>;
}

/** A store that keeps statistics only in memory (default; nothing touches disk). */
export class MemoryProfileStatsStore implements ProfileStatsStore {
  private saved: ProfileStats[] = [];

  async load(): Promise<ProfileStats[]> {
    return this.saved.map((stats) => ({ ...stats }));
  }

  async save(stats: ProfileStats[]): Promise<void> {
    this.saved = stats.map((entry) => ({ ...entry }));
  }
}

/** Empty statistics for a profile. */
export function emptyStats(profileId: ProfileId): ProfileStats {
  return {
    profileId,
    sessionCount: 0,
    activeSessionCount: 0,
    lastAccessedAt: null,
    switchCount: 0,
    firstUsedAt: null,
  };
}

/** Computes aggregate counters from per-profile statistics. */
export function computeAggregate(stats: ProfileStats[]): AggregateStats {
  return {
    totalProfiles: stats.length,
    activeProfiles: stats.filter((entry) => entry.activeSessionCount > 0).length,
    totalSessions: stats.reduce((sum, entry) => sum + entry.sessionCount, 0),
    totalActiveSessions: stats.reduce(
      (sum, entry) => sum + entry.activeSessionCount,
      0,
    ),
    totalSwitches: stats.reduce((sum, entry) => sum + entry.switchCount, 0),
  };
}

/**
 * Collects statistics only while enabled. The caller decides whether to enable
 * it from `ProfileSettings.collectStatistics`; disabled means every recording
 * method is a no-op and nothing is stored.
 */
export class ProfileStatsManager {
  private stats = new Map<ProfileId, ProfileStats>();
  private enabled = false;
  private readonly now: () => number;
  private readonly store: ProfileStatsStore | null;

  constructor(
    options: {
      enabled?: boolean;
      now?: () => number;
      store?: ProfileStatsStore;
    } = {},
  ) {
    this.enabled = options.enabled === true;
    this.now = options.now ?? Date.now;
    this.store = options.store ?? null;
  }

  /** Enables or disables collection. Disabling does not erase existing records. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /** Returns whether collection is enabled. */
  isEnabled(): boolean {
    return this.enabled;
  }

  /** Loads persisted statistics from the configured store. */
  async load(): Promise<void> {
    if (!this.store) return;
    this.stats = new Map();
    for (const entry of await this.store.load()) {
      if (typeof entry.profileId === "string") {
        this.stats.set(entry.profileId, { ...entry });
      }
    }
  }

  /** Persists statistics when a store is configured. */
  async save(): Promise<void> {
    await this.store?.save(this.listStats());
  }

  /** Returns statistics for a profile, or empty stats if none exist. */
  getStats(profileId: ProfileId): ProfileStats {
    const found = this.stats.get(profileId);
    return found ? { ...found } : emptyStats(profileId);
  }

  /** Sets the session counts for a profile (derived from Session Core). */
  setSessionCounts(
    profileId: ProfileId,
    sessionCount: number,
    activeSessionCount: number,
  ): void {
    if (!this.enabled) return;
    const current = this.ensure(profileId);
    current.sessionCount = Math.max(0, Math.floor(sessionCount));
    current.activeSessionCount = Math.max(
      0,
      Math.min(current.sessionCount, Math.floor(activeSessionCount)),
    );
    current.lastAccessedAt = this.now();
    this.commit(profileId, current);
  }

  /** Records that a profile was switched to. */
  recordSwitch(profileId: ProfileId): void {
    if (!this.enabled) return;
    const current = this.ensure(profileId);
    current.switchCount += 1;
    current.lastAccessedAt = this.now();
    if (current.firstUsedAt === null) current.firstUsedAt = current.lastAccessedAt;
    this.commit(profileId, current);
  }

  /** Returns all statistics (copies). */
  listStats(): ProfileStats[] {
    return [...this.stats.values()].map((entry) => ({ ...entry }));
  }

  /** Aggregate counters over all recorded profiles. */
  aggregate(): AggregateStats {
    return computeAggregate(this.listStats());
  }

  /** Forgets one profile's statistics (e.g. after permanent deletion). */
  forget(profileId: ProfileId): void {
    this.stats.delete(profileId);
  }

  /** Erases all statistics. */
  clear(): void {
    this.stats.clear();
  }

  private ensure(profileId: ProfileId): ProfileStats {
    return this.stats.get(profileId) ?? emptyStats(profileId);
  }

  private commit(profileId: ProfileId, stats: ProfileStats): void {
    this.stats.set(profileId, { ...stats });
  }
}
