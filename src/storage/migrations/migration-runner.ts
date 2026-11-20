/**
 * Session Core — Storage Migrations (AEGOX_multisession).
 *
 * Executes storage format migrations when the on-disk schema changes.
 * Each migration has a version number and transforms data from the previous
 * version to the current one. Migrations are run in order and are idempotent.
 *
 * Never silently deletes user data during migration.
 *
 * Derived from SplitSession's settings migration pattern
 * (https://github.com/Misyuk-T/splitsession, MIT License).
 */

import type { StorageAreaLike } from "../../engine/storage/storage-area";

/** A single migration step. */
export interface Migration {
  /** Version this migration brings the storage to. */
  version: number;
  /** Human-readable description. */
  description: string;
  /** Transforms raw stored data from previous version to this one. */
  up(raw: unknown): Promise<unknown>;
}

/** Result of running migrations. */
export interface MigrationResult {
  /** Whether all migrations ran successfully. */
  ok: boolean;
  /** The version storage was migrated to. */
  targetVersion: number;
  /** Migrations that were applied. */
  applied: Migration[];
  /** Any errors encountered (non-fatal ones are logged). */
  errors: string[];
}

/** Current storage schema version for Session Core. */
export const CURRENT_STORAGE_VERSION = 1;

/** Key in storage where the schema version is recorded. */
export const STORAGE_VERSION_KEY = "sessionStorageVersion";

/**
 * Runs all pending migrations from the current stored version to the target.
 * Migrations are applied in order; if one fails, subsequent ones are skipped.
 */
export class MigrationRunner {
  private migrations: Migration[] = [];

  constructor(private readonly area: StorageAreaLike) {}

  /** Registers a migration (should be called with versions in ascending order). */
  register(migration: Migration): void {
    this.migrations.push(migration);
    this.migrations.sort((a, b) => a.version - b.version);
  }

  /** Returns the current stored schema version, or 0 if none. */
  async getCurrentVersion(): Promise<number> {
    const stored = (await this.area.get(STORAGE_VERSION_KEY))[STORAGE_VERSION_KEY];
    return typeof stored === "number" ? stored : 0;
  }

  /**
   * Runs all migrations from `fromVersion` to `targetVersion` (exclusive of already-applied).
   * Returns which migrations were applied and the final version.
   */
  async run(
    fromVersion: number,
    targetVersion: number = CURRENT_STORAGE_VERSION,
  ): Promise<MigrationResult> {
    const applied: Migration[] = [];
    const errors: string[] = [];

    const pending = this.migrations.filter(
      (m) => m.version > fromVersion && m.version <= targetVersion,
    );

    let currentData: unknown = null;
    for (const migration of pending) {
      try {
        currentData = await migration.up(currentData);
        applied.push(migration);
      } catch (error) {
        errors.push(
          `Migration to v${migration.version} (${migration.description}) failed: ${error}`,
        );
        break; // Stop on first failure to avoid data corruption.
      }
    }

    // Record the new version only if at least one migration applied.
    const lastApplied = applied[applied.length - 1];
    if (lastApplied) {
      await this.area.set({ [STORAGE_VERSION_KEY]: lastApplied.version });
    }

    return {
      ok: errors.length === 0,
      targetVersion: lastApplied ? lastApplied.version : fromVersion,
      applied,
      errors,
    };
  }

  /** Runs migrations from the stored current version to the target. */
  async migrateToLatest(): Promise<MigrationResult> {
    const current = await this.getCurrentVersion();
    return this.run(current, CURRENT_STORAGE_VERSION);
  }
}

/**
 * Example migration: v0 -> v1.
 * This is a template; actual migrations for Session Core data formats
 * are added here as the schema evolves.
 */
export const migrationV0ToV1: Migration = {
  version: 1,
  description: "Initialize Session Core storage schema",
  async up(raw: unknown): Promise<unknown> {
    // No data transformation needed for initial schema.
    return raw;
  },
};
