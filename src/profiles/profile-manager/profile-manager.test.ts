/**
 * Unit tests for `src/profiles/profile-manager/profile-manager.ts`.
 * Uses MemoryStorageArea (no real browser storage required).
 */

import { describe, expect, it } from "vitest";

import { MemoryStorageArea } from "../../engine/storage/storage-area";
import {
  PROFILE_FOLDERS_KEY,
  PROFILES_KEY,
  ProfileError,
  ProfileManager,
  normalizeRuleDomain,
} from "./profile-manager";
import { createProfile } from "./profile";

const setup = (now = 1000) => {
  const area = new MemoryStorageArea();
  const mgr = new ProfileManager(area, { now: () => now });
  return { area, mgr };
};

describe("ProfileManager — create / read", () => {
  it("starts empty and persists created profiles", async () => {
    const { area, mgr } = setup();
    await mgr.load();
    expect(mgr.list()).toEqual([]);

    const created = await mgr.create({ name: "Work", color: "#4f46e5" });
    expect(created.profile.metadata.name).toBe("Work");
    expect(created.profile.state).toBe("active");
    expect(created.profile.metadata.createdAt).toBe(1000);
    expect(created.duplicateDetected).toBe(false);
    expect(mgr.list()).toHaveLength(1);

    const stored = area.data.get(PROFILES_KEY);
    expect(Array.isArray(stored)).toBe(true);
    expect((stored as unknown[]).length).toBe(1);
  });

  it("rejects empty and duplicate names", async () => {
    const { mgr } = setup();
    await expect(mgr.create({ name: "  " })).rejects.toThrow(ProfileError);
    await mgr.create({ name: "Work" });
    await expect(mgr.create({ name: "WORK" })).rejects.toThrow(/already exists/);
  });

  it("resolves by ID and case-insensitive name", async () => {
    const { mgr } = setup();
    const { profile } = await mgr.create({ name: "Work" });

    expect(mgr.get(profile.id)?.id).toBe(profile.id);
    expect(mgr.resolve("work")?.id).toBe(profile.id);
    expect(mgr.findByName("WORK")?.id).toBe(profile.id);
    expect(mgr.has(profile.id)).toBe(true);
    expect(mgr.get("missing")).toBeUndefined();
  });

  it("returns the default profile", async () => {
    const { mgr } = setup();
    await mgr.create({ name: "First" });
    const second = await mgr.create({ name: "Second", isDefault: true });
    expect(mgr.getDefault()?.id).toBe(second.profile.id);
    await mgr.archive(second.profile.id);
    expect(mgr.getDefault()?.metadata.name).toBe("First");
  });

  it("normalizes tags and de-duplicates them case-insensitively", async () => {
    const { mgr } = setup();
    const { profile } = await mgr.create({ name: "Work", tags: ["Work", "work", " urgent "] });
    expect(profile.tags).toEqual(["Work", "urgent"]);
    expect(mgr.allTags()).toEqual(["urgent", "Work"].sort((a, b) => a.localeCompare(b)));
  });

  it("stores only website rules with valid domains", async () => {
    const { mgr } = setup();
    const { profile } = await mgr.create({ name: "Work" });
    const updated = await mgr.setWebsiteRules(profile.id, [
      { domain: "https://Example.com/path", action: "block", enabled: true, createdAt: 1 },
      { domain: "not a domain", action: "allow", enabled: true, createdAt: 1 },
    ]);
    expect(updated.websiteRules).toHaveLength(1);
    expect(updated.websiteRules[0]!.domain).toBe("example.com");
    expect(updated.websiteRules[0]!.action).toBe("block");
  });

  it("rejects an invalid profile ID on createWithId", async () => {
    const { mgr } = setup();
    await expect(
      mgr.createWithId({ id: "Not A Valid Id!", name: "X" }),
    ).rejects.toThrow(/invalid profile ID/);
  });
});

describe("ProfileManager — update / lifecycle", () => {
  it("updates metadata while preserving creation data", async () => {
    const { mgr } = setup();
    const { profile } = await mgr.create({ name: "Work", color: "#4f46e5" });

    const updated = await mgr.update(profile.id, {
      name: "Work Updated",
      color: "#ff0000",
    });
    expect(updated.metadata.name).toBe("Work Updated");
    expect(updated.metadata.color).toBe("#ff0000");
    expect(updated.metadata.createdAt).toBe(profile.metadata.createdAt);
  });

  it("rejects renaming to another profile's name", async () => {
    const { mgr } = setup();
    const a = await mgr.create({ name: "A" });
    await mgr.create({ name: "B" });
    await expect(mgr.update(a.profile.id, { name: "B" })).rejects.toThrow(
      /already exists/,
    );
  });

  it("archives and restores a profile", async () => {
    const { mgr } = setup();
    const { profile } = await mgr.create({ name: "Work" });

    const archived = await mgr.archive(profile.id);
    expect(archived.state).toBe("archived");
    expect(mgr.listFiltered().profiles).toHaveLength(0);
    expect(mgr.listFiltered({ includeArchived: true }).profiles).toHaveLength(1);

    const restored = await mgr.restore(profile.id);
    expect(restored.state).toBe("active");
  });

  it("refuses to restore a profile that is not archived", async () => {
    const { mgr } = setup();
    const { profile } = await mgr.create({ name: "Work" });
    await expect(mgr.restore(profile.id)).rejects.toThrow(/not archived/);
  });

  it("soft-deletes and hard-deletes", async () => {
    const { mgr } = setup();
    const { profile } = await mgr.create({ name: "Work" });

    const deleted = await mgr.markDeleted(profile.id);
    expect(deleted.state).toBe("deleted");
    expect(mgr.listFiltered().profiles).toHaveLength(0);

    expect(await mgr.delete(profile.id)).toBe(true);
    expect(mgr.get(profile.id)).toBeUndefined();
    expect(await mgr.delete(profile.id)).toBe(false);
  });

  it("records last use", async () => {
    const { mgr } = setup();
    const { profile } = await mgr.create({ name: "Work" });
    const touched = await mgr.touch(profile.id);
    expect(touched.metadata.lastUsedAt).toBe(1000);
  });

  it("duplicates a profile without the independent password", async () => {
    const { mgr } = setup();
    const { profile } = await mgr.create({ name: "Work", tags: ["a"] });
    await mgr.update(profile.id, {
      hasIndependentPassword: true,
      description: "Original",
    });
    await mgr.create({ name: "Work copy" });

    const copy = await mgr.duplicate(profile.id);
    expect(copy.id).not.toBe(profile.id);
    expect(copy.metadata.name).toBe("Work copy 2");
    expect(copy.tags).toEqual(["a"]);
    expect(copy.hasIndependentPassword).toBe(false);
    expect(mgr.list()).toHaveLength(3);
  });
});

describe("ProfileManager — folders", () => {
  it("creates, renames and lists folders in order", async () => {
    const { mgr } = setup();
    const work = await mgr.createFolder("Work", "#111111");
    await mgr.createFolder("Personal");

    expect(mgr.listFolders().map((f) => f.name)).toEqual(["Work", "Personal"]);
    expect(mgr.getFolder(work.id)?.color).toBe("#111111");

    const renamed = await mgr.renameFolder(work.id, "Clients");
    expect(renamed.name).toBe("Clients");
    await expect(mgr.createFolder("clients")).rejects.toThrow(/already exists/);
  });

  it("unassigns profiles when a folder is deleted, never deletes them", async () => {
    const { mgr } = setup();
    const folder = await mgr.createFolder("Work");
    const { profile } = await mgr.create({ name: "A", folderId: folder.id });

    const unassigned = await mgr.deleteFolder(folder.id);
    expect(unassigned).toEqual([profile.id]);
    expect(mgr.get(profile.id)?.folderId).toBeNull();
    expect(mgr.listFolders()).toHaveLength(0);
  });

  it("ignores unknown folder IDs", async () => {
    const { mgr } = setup();
    const { profile } = await mgr.create({ name: "A", folderId: "missing" });
    expect(profile.folderId).toBeNull();
  });

  it("imports a folder preserving its ID", async () => {
    const { mgr } = setup();
    const folder = await mgr.importFolder({
      id: "folder-1",
      name: "Imported",
      color: null,
      createdAt: 5,
      order: 3,
    });
    expect(folder.id).toBe("folder-1");
    expect(mgr.getFolder("folder-1")?.name).toBe("Imported");
  });
});

describe("ProfileManager — tags and ordering", () => {
  it("adds and removes tags", async () => {
    const { mgr } = setup();
    const { profile } = await mgr.create({ name: "A" });

    const added = await mgr.addTag(profile.id, "Work");
    expect(added.tags).toEqual(["Work"]);
    await mgr.addTag(profile.id, "work");
    expect(mgr.get(profile.id)!.tags).toEqual(["Work"]);

    const removed = await mgr.removeTag(profile.id, "WORK");
    expect(removed.tags).toEqual([]);
  });

  it("moves profiles and renumbers their order", async () => {
    const { mgr } = setup();
    const a = await mgr.create({ name: "A" });
    const b = await mgr.create({ name: "B" });
    const c = await mgr.create({ name: "C" });

    await mgr.move(c.profile.id, a.profile.id);
    expect(mgr.listFiltered().profiles.map((p) => p.metadata.name)).toEqual([
      "C",
      "A",
      "B",
    ]);

    await mgr.move(c.profile.id, null);
    expect(mgr.listFiltered().profiles.map((p) => p.metadata.name)).toEqual([
      "A",
      "B",
      "C",
    ]);
    expect(mgr.get(b.profile.id)!.order).toBe(1);
  });

  it("rejects moving a missing profile", async () => {
    const { mgr } = setup();
    await expect(mgr.move("missing", null)).rejects.toThrow(/no profile/);
  });
});

describe("ProfileManager — filtering and sorting", () => {
  it("filters by search, folder, tags, state and archived flag", async () => {
    const { mgr } = setup();
    const folder = await mgr.createFolder("Clients");
    await mgr.create({
      name: "Acme",
      description: "Important client",
      tags: ["work"],
      folderId: folder.id,
    });
    await mgr.create({ name: "Personal", tags: ["home"] });
    const archived = await mgr.create({ name: "Old", tags: ["work"] });
    await mgr.archive(archived.profile.id);

    expect(mgr.listFiltered({ search: "important" }).profiles.map((p) => p.metadata.name)).toEqual(["Acme"]);
    expect(mgr.listFiltered({ search: "clients" }).profiles.map((p) => p.metadata.name)).toEqual(["Acme"]);
    expect(mgr.listFiltered({ folderId: folder.id }).profiles).toHaveLength(1);
    expect(mgr.listFiltered({ tags: ["work"] }).profiles.map((p) => p.metadata.name)).toEqual(["Acme"]);
    expect(mgr.listFiltered({ tags: ["work"], includeArchived: true }).profiles).toHaveLength(2);
    expect(mgr.listFiltered({ state: "archived", includeArchived: true }).profiles).toHaveLength(1);
    expect(mgr.listFiltered().total).toBe(3);
    expect(mgr.listFiltered().filtered).toBe(2);
  });

  it("sorts by name in both directions", async () => {
    const { mgr } = setup();
    await mgr.create({ name: "Zebra" });
    await mgr.create({ name: "Apple" });
    await mgr.create({ name: "Mango" });

    expect(
      mgr.listFiltered({}, { field: "name", direction: "asc" }).profiles.map(
        (p) => p.metadata.name,
      ),
    ).toEqual(["Apple", "Mango", "Zebra"]);
    expect(
      mgr.listFiltered({}, { field: "name", direction: "desc" }).profiles.map(
        (p) => p.metadata.name,
      ),
    ).toEqual(["Zebra", "Mango", "Apple"]);
  });
});

describe("ProfileManager — duplicates and persistence", () => {
  it("reports a similar profile without merging or deleting", async () => {
    const { mgr } = setup();
    await mgr.create({ name: "Work", color: "#4f46e5", description: "Same" });
    const result = await mgr.create({ name: "Workspace", color: "#4f46e5", description: "Same" });
    expect(result.duplicateDetected).toBe(true);
    expect(mgr.list()).toHaveLength(2);
  });

  it("allows duplicate names only through createWithId (import)", async () => {
    const { mgr } = setup();
    await mgr.create({ name: "Work" });
    const imported = await mgr.createWithId({ id: "imported-1", name: "Work" });
    expect(imported.metadata.name).toBe("Work");
    expect(mgr.list()).toHaveLength(2);
    await expect(
      mgr.createWithId({ id: "imported-1", name: "Other" }),
    ).rejects.toThrow(/already exists/);
  });

  it("does not restore protection flags on import", async () => {
    const { mgr } = setup();
    const imported = await mgr.createWithId({
      id: "imported-1",
      name: "Imported",
      hasIndependentPassword: true,
    });
    expect(imported.hasIndependentPassword).toBe(false);
  });

  it("loads persisted profiles and drops invalid entries", async () => {
    const { area, mgr } = setup();
    const valid = createProfile({
      name: "Persisted",
      color: "#4f46e5",
      icon: null,
      description: null,
      createdAt: 1000,
      lastUsedAt: 2000,
      isDefault: true,
    });
    await area.set({
      [PROFILES_KEY]: [valid, { id: "bad" }, null, "nope"],
      [PROFILE_FOLDERS_KEY]: [{ id: "f1", name: "Folder", color: null, createdAt: 1, order: 0 }],
    });
    await mgr.load();

    expect(mgr.list()).toHaveLength(1);
    expect(mgr.list()[0]!.metadata.name).toBe("Persisted");
    expect(mgr.listFolders()).toHaveLength(1);
  });

  it("clears folder references that no longer resolve on load", async () => {
    const { area, mgr } = setup();
    const profile = createProfile(
      {
        name: "A",
        color: "#4f46e5",
        icon: null,
        description: null,
        createdAt: 1,
        lastUsedAt: null,
        isDefault: false,
      },
      { folderId: "gone" },
    );
    await area.set({ [PROFILES_KEY]: [profile] });
    await mgr.load();
    expect(mgr.get(profile.id)?.folderId).toBeNull();
  });
});

describe("normalizeRuleDomain", () => {
  it("normalizes URLs and bare hosts", () => {
    expect(normalizeRuleDomain("https://Example.com/path?q=1")).toBe("example.com");
    expect(normalizeRuleDomain("Example.com")).toBe("example.com");
    expect(normalizeRuleDomain("sub.example.com:8080")).toBe("sub.example.com");
  });

  it("rejects invalid and credential-bearing input", () => {
    expect(normalizeRuleDomain("")).toBeNull();
    expect(normalizeRuleDomain("not a domain")).toBeNull();
    expect(normalizeRuleDomain("https://user:pass@example.com")).toBeNull();
  });
});
