/**
 * Unit tests for `src/storage/migrations/migration-runner.ts`.
 * Uses MemoryStorageArea (no real browser storage required).
 */

import { describe, expect, it } from "vitest";

import { MemoryStorageArea } from "../../engine/storage/storage-area";
import {
  MigrationRunner,
  CURRENT_STORAGE_VERSION,
  STORAGE_VERSION_KEY,
  migrationV0ToV1,
} from "./migration-runner";

describe("MigrationRunner", () => {
  it("starts at version 0 when nothing stored", async () => {
    const area = new MemoryStorageArea();
    const runner = new MigrationRunner(area);
    const version = await runner.getCurrentVersion();
    expect(version).toBe(0);
  });

  it("registers migrations in order", async () => {
    const area = new MemoryStorageArea();
    const runner = new MigrationRunner(area);
    runner.register(migrationV0ToV1);

    const result = await runner.migrateToLatest();
    expect(result.ok).toBe(true);
    expect(result.applied.length).toBe(1);
    expect(result.targetVersion).toBe(1);

    const storedVersion = (await area.get(STORAGE_VERSION_KEY))[STORAGE_VERSION_KEY];
    expect(storedVersion).toBe(1);
  });

  it("does not re-apply already applied migrations", async () => {
    const area = new MemoryStorageArea();
    await area.set({ [STORAGE_VERSION_KEY]: 1 });

    const runner = new MigrationRunner(area);
    runner.register(migrationV0ToV1);

    const result = await runner.migrateToLatest();
    expect(result.applied.length).toBe(0);
    expect(result.targetVersion).toBe(1);
  });

  it("stops on migration failure", async () => {
    const area = new MemoryStorageArea();
    const runner = new MigrationRunner(area);

    const failingMigration = {
      version: 2,
      description: "failing migration",
      async up(): Promise<unknown> {
        throw new Error("boom");
      },
    };
    runner.register(failingMigration);

    const result = await runner.run(0, 2);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.targetVersion).toBe(0); // none applied because first one failed
  });

  it("reports current storage version constant", () => {
    expect(CURRENT_STORAGE_VERSION).toBe(1);
  });
});
