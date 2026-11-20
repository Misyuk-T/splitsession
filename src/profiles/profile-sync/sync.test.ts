/**
 * Unit tests for `src/profiles/profile-sync/sync.ts`.
 * Verifies that no synchronization is claimed and that snapshots reuse the
 * safe export format (no cookies, tokens or passwords).
 */

import { describe, expect, it } from "vitest";

import { MemoryStorageArea } from "../../engine/storage/storage-area";
import { ProfileManager } from "../profile-manager/profile-manager";
import {
  NoopProfileSyncProvider,
  PROFILE_SNAPSHOT_VERSION,
  ProfileSyncCoordinator,
} from "./sync";

const makeProfiles = async () => {
  const area = new MemoryStorageArea();
  const pm = new ProfileManager(area);
  await pm.load();
  await pm.create({ name: "Work" });
  return pm;
};

describe("NoopProfileSyncProvider", () => {
  it("states that synchronization is not implemented", async () => {
    const provider = new NoopProfileSyncProvider();
    expect(provider.capabilities.implemented).toBe(false);
    expect(provider.capabilities.endToEndEncryption).toBe(false);

    const pulled = await provider.pull();
    expect(pulled).toEqual({ snapshot: null, remoteRevision: null });

    const pushed = await provider.push();
    expect(pushed.ok).toBe(false);
    expect(pushed.message).toContain("not implemented");
  });
});

describe("ProfileSyncCoordinator", () => {
  it("reports not-configured by default and never claims sync", async () => {
    const coordinator = new ProfileSyncCoordinator();
    expect(coordinator.getStatus()).toBe("not-configured");

    coordinator.markSynced(3);
    expect(coordinator.getStatus()).toBe("not-configured");

    const provider = coordinator.describeProvider();
    expect(provider.id).toBe("none");
    expect(provider.capabilities.implemented).toBe(false);
  });

  it("builds a snapshot from the safe export payload", async () => {
    const pm = await makeProfiles();
    const coordinator = new ProfileSyncCoordinator(undefined, { now: () => 5000 });

    const snapshot = coordinator.createSnapshot(pm.list(), []);
    expect(snapshot.schema).toBe("aegox-multisession-profile-snapshot");
    expect(snapshot.schemaVersion).toBe(PROFILE_SNAPSHOT_VERSION);
    expect(snapshot.generatedAt).toBe(5000);
    expect(snapshot.revision).toBe(0);
    expect(snapshot.data.profiles).toHaveLength(1);
    expect(snapshot.data.includesSensitiveData).toBe(false);
  });

  it("validates snapshots and rejects unknown schemas or versions", async () => {
    const pm = await makeProfiles();
    const coordinator = new ProfileSyncCoordinator();
    const snapshot = coordinator.createSnapshot(pm.list(), []);

    expect(coordinator.validateSnapshot(snapshot)).toEqual({
      valid: true,
      errors: [],
    });
    expect(coordinator.validateSnapshot({})).toEqual({
      valid: false,
      errors: ["Unsupported snapshot format or version."],
    });
    expect(
      coordinator.validateSnapshot({ ...snapshot, schemaVersion: 99 }).valid,
    ).toBe(false);
  });

  it("rejects snapshots whose payload contains secrets", async () => {
    const pm = await makeProfiles();
    const coordinator = new ProfileSyncCoordinator();
    const snapshot = coordinator.createSnapshot(pm.list(), []);
    const tampered = structuredClone(snapshot) as unknown as {
      data: { profiles: Array<Record<string, unknown>> };
    };
    tampered.data.profiles[0]!.accessToken = "nope";

    const validation = coordinator.validateSnapshot(tampered);
    expect(validation.valid).toBe(false);
    expect(validation.errors.join(" ")).toContain("forbidden secret field");
  });

  it("tracks revisions when a real provider is supplied", () => {
    const coordinator = new ProfileSyncCoordinator(
      {
        id: "test",
        label: "Test",
        capabilities: {
          implemented: true,
          supportsMerge: true,
          endToEndEncryption: true,
        },
        pull: async () => ({ snapshot: null, remoteRevision: null }),
        push: async () => ({ ok: true, remoteRevision: "1", conflict: false }),
      },
      { now: () => 1 },
    );

    coordinator.markSynced(7);
    expect(coordinator.getStatus()).toBe("local-only");
  });
});
