/**
 * Unit tests for `src/profiles/profile-import-export/backup.ts`.
 * Never uses real profile data or secrets.
 */

import { describe, expect, it } from "vitest";

import { MemoryStorageArea } from "../../engine/storage/storage-area";
import { ProfileManager } from "../profile-manager/profile-manager";
import {
  MAX_PROFILE_IMPORT_BYTES,
  PROFILE_EXPORT_FORMAT,
  PROFILE_EXPORT_FORMAT_VERSION,
  ProfileImportError,
  createProfileExportPackage,
  createSingleProfileExportPackage,
  importProfiles,
  parseProfileExportPackage,
  validateProfileExportPackage,
} from "./backup";

const setup = async () => {
  const area = new MemoryStorageArea();
  const pm = new ProfileManager(area, { now: () => 1000 });
  await pm.load();
  return { area, pm };
};

const populated = async () => {
  const { area, pm } = await setup();
  const folder = await pm.createFolder("Clients");
  const work = await pm.create({
    name: "Work",
    color: "#4f46e5",
    description: "Daily work",
    tags: ["work"],
    folderId: folder.id,
    settings: { websiteMode: "allowlist", collectStatistics: true },
  });
  await pm.create({ name: "Personal", color: "#22c55e", tags: ["home"] });
  await pm.setWebsiteRules(work.profile.id, [
    { domain: "example.com", action: "block", enabled: true, createdAt: 1 },
  ]);
  return { area, pm, folder, work };
};

describe("createProfileExportPackage", () => {
  it("exports profiles, folders and tags without session data", async () => {
    const { pm } = await populated();
    const pkg = createProfileExportPackage(pm.list(), pm.listFolders(), {
      now: () => 5000,
    });

    expect(pkg.format).toBe(PROFILE_EXPORT_FORMAT);
    expect(pkg.version).toBe(PROFILE_EXPORT_FORMAT_VERSION);
    expect(pkg.exportedAt).toBe(5000);
    expect(pkg.includesSensitiveData).toBe(false);
    expect(pkg.profiles).toHaveLength(2);
    expect(pkg.organization.folders[0]!.name).toBe("Clients");
    expect(pkg.organization.tags).toEqual(["home", "work"]);

    const work = pkg.profiles.find((profile) => profile.name === "Work")!;
    expect(work.websiteRules).toEqual([
      { domain: "example.com", action: "block", enabled: true },
    ]);
    expect(work.settings.websiteMode).toBe("allowlist");
    expect("hasIndependentPassword" in work).toBe(false);
  });

  it("never serializes cookies, tokens or passwords", async () => {
    const { pm } = await populated();
    const json = JSON.stringify(
      createProfileExportPackage(pm.list(), pm.listFolders()),
    );
    expect(json).not.toMatch(/cookies?|tokens?|passwords?|credentials?|secret/i);
  });

  it("exports a single profile", async () => {
    const { pm } = await populated();
    const profile = pm.findByName("Work")!;
    const pkg = createSingleProfileExportPackage(profile);
    expect(pkg.profiles).toHaveLength(1);
    expect(pkg.profiles[0]!.name).toBe("Work");
  });
});

describe("validateProfileExportPackage", () => {
  it("accepts a package produced by the exporter", async () => {
    const { pm } = await populated();
    const pkg = createProfileExportPackage(pm.list(), pm.listFolders());
    const validation = validateProfileExportPackage(pkg);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
    expect(validation.preview?.profilesToCreate).toBe(2);
    expect(validation.preview?.folders).toBe(1);
  });

  it("rejects a different format", () => {
    const validation = validateProfileExportPackage({
      format: "something-else",
      version: 1,
      exportedAt: 1,
      profiles: [],
    });
    expect(validation.valid).toBe(false);
    expect(validation.errors.join(" ")).toContain("not an AEGOX");
  });

  it("rejects newer, older and missing versions", () => {
    const base = { format: PROFILE_EXPORT_FORMAT, exportedAt: 1, profiles: [] };
    expect(validateProfileExportPackage({ ...base, version: 2 }).errors.join(" ")).toContain(
      "newer version",
    );
    expect(validateProfileExportPackage({ ...base, version: 0 }).errors.join(" ")).toContain(
      "Unsupported export version",
    );
    expect(
      validateProfileExportPackage({ ...base } as unknown as Record<string, unknown>).errors.join(" "),
    ).toContain("no format version");
  });

  it("rejects files that admit sensitive data", async () => {
    const { pm } = await populated();
    const pkg = createProfileExportPackage(pm.list(), pm.listFolders());
    const validation = validateProfileExportPackage({
      ...pkg,
      includesSensitiveData: true,
    });
    expect(validation.valid).toBe(false);
    expect(validation.errors.join(" ")).toContain("sensitive data");
  });

  it("rejects files containing forbidden secret fields", async () => {
    const { pm } = await populated();
    const pkg = createProfileExportPackage(pm.list(), pm.listFolders());
    const tampered = structuredClone(pkg) as unknown as {
      profiles: Array<Record<string, unknown>>;
    };
    tampered.profiles[0]!.cookies = [{ name: "session" }];

    const validation = validateProfileExportPackage(tampered);
    expect(validation.valid).toBe(false);
    expect(validation.errors.join(" ")).toContain("forbidden secret field");
  });

  it("rejects duplicate profile and folder IDs", async () => {
    const { pm } = await populated();
    const pkg = createProfileExportPackage(pm.list(), pm.listFolders());
    const duplicated = structuredClone(pkg);
    duplicated.profiles.push(structuredClone(duplicated.profiles[0]!));

    expect(validateProfileExportPackage(duplicated).errors.join(" ")).toContain(
      "appears twice",
    );
    expect(validateProfileExportPackage(pkg).valid).toBe(true);
  });

  it("rejects malformed profiles and rules", async () => {
    const base = {
      format: PROFILE_EXPORT_FORMAT,
      version: 1,
      exportedAt: 1,
      profiles: [
        {
          id: "bad id!",
          name: "",
          state: "weird",
          color: "blue",
          tags: [5],
          websiteRules: [{ domain: "", action: "nope" }],
          settings: { websiteMode: "mixed" },
        },
      ],
    };
    const validation = validateProfileExportPackage(base);
    expect(validation.valid).toBe(false);
    expect(validation.errors.length).toBeGreaterThan(3);
  });

  it("warns when a profile references a folder that is not in the file", async () => {
    const { pm } = await populated();
    const pkg = createProfileExportPackage(pm.list(), []);
    const validation = validateProfileExportPackage(pkg);
    expect(validation.valid).toBe(true);
    expect(validation.warnings.join(" ")).toContain("not in the file");
  });
});

describe("parseProfileExportPackage", () => {
  it("parses valid JSON", () => {
    expect(parseProfileExportPackage('{"a":1}')).toEqual({ a: 1 });
  });

  it("rejects invalid JSON", () => {
    expect(() => parseProfileExportPackage("{")).toThrow(ProfileImportError);
  });

  it("enforces the size limit", () => {
    expect(() =>
      parseProfileExportPackage('{"a":1}', { maxBytes: 2 }),
    ).toThrow(/too large/);
    expect(MAX_PROFILE_IMPORT_BYTES).toBeGreaterThan(1000);
  });
});

describe("importProfiles", () => {
  it("imports profiles, folders, rules and settings", async () => {
    const source = await populated();
    const pkg = createProfileExportPackage(
      source.pm.list(),
      source.pm.listFolders(),
      { now: () => 5000 },
    );

    const { pm } = await setup();
    const result = await importProfiles(pkg, pm);

    expect(result.imported).toBe(2);
    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toEqual([]);
    expect(pm.listFolders()).toHaveLength(1);

    const work = pm.findByName("Work")!;
    expect(work.tags).toEqual(["work"]);
    expect(work.settings.websiteMode).toBe("allowlist");
    expect(work.settings.collectStatistics).toBe(true);
    expect(work.folderId).toBe(source.folder.id);
    expect(work.websiteRules).toHaveLength(1);
    expect(work.hasIndependentPassword).toBe(false);
  });

  it("skips existing IDs unless overwrite is requested", async () => {
    const source = await populated();
    const pkg = createProfileExportPackage(source.pm.list(), source.pm.listFolders());

    const { pm } = await setup();
    await importProfiles(pkg, pm);

    const again = await importProfiles(pkg, pm);
    expect(again.imported).toBe(0);
    expect(again.skipped).toBe(2);

    const changed = structuredClone(pkg);
    changed.profiles[0]!.name = "Work renamed";
    const overwritten = await importProfiles(changed, pm, { overwrite: true });
    expect(overwritten.updated).toBe(2);
    expect(pm.get(changed.profiles[0]!.id)?.metadata.name).toBe("Work renamed");
  });

  it("does not restore independent-password protection", async () => {
    const source = await populated();
    const pkg = createProfileExportPackage(source.pm.list(), []);
    const tampered = structuredClone(pkg) as unknown as {
      profiles: Array<Record<string, unknown>>;
    };
    tampered.profiles[0]!.hasIndependentPassword = true;

    const { pm } = await setup();
    await importProfiles(tampered, pm);
    expect(pm.get(tampered.profiles[0]!.id as string)?.hasIndependentPassword).toBe(
      false,
    );
  });

  it("rejects an invalid package without touching the store", async () => {
    const { pm } = await setup();
    await expect(
      importProfiles({ format: "other" }, pm),
    ).rejects.toThrow(ProfileImportError);
    expect(pm.list()).toHaveLength(0);
  });

  it("warns about temporary profiles instead of deleting them", async () => {
    const source = await setup();
    const { profile } = await source.pm.create({ name: "Temp", state: "temporary" });
    await source.pm.update(profile.id, { expiresAt: 5000 });
    const pkg = createProfileExportPackage(source.pm.list(), []);

    const { pm } = await setup();
    const result = await importProfiles(pkg, pm);
    expect(result.warnings.join(" ")).toContain("never deleted automatically");
    expect(pm.get(profile.id)?.state).toBe("temporary");
  });
});
