/**
 * Unit tests for `src/storage/backup/backup-manager.ts`.
 * Pure TypeScript: no browser APIs required.
 */

import { describe, expect, it } from "vitest";

import {
  validateExportPackage,
  createExportPackage,
  parseExportPackage,
  EXPORT_FORMAT_VERSION,
} from "./backup-manager";

describe("createExportPackage", () => {
  it("creates a valid export package", () => {
    const sessions = [
      {
        id: "s1",
        name: "Work",
        domain: "example.com",
        profileId: "p1",
        state: "active" as const,
        persistent: true,
        restorable: true,
      },
    ];
    const pkg = createExportPackage(sessions, {
      restorationPolicy: "all",
      selectedSessionIds: [],
      autoRestore: true,
    });

    expect(pkg.format).toBe("aegox-multisession-export");
    expect(pkg.version).toBe(EXPORT_FORMAT_VERSION);
    expect(typeof pkg.exportedAt).toBe("number");
    expect(pkg.sessions.length).toBe(1);
    expect(pkg.includesSensitiveData).toBe(false);
    expect(pkg.vaultEntries).toBeUndefined();
  });

  it("includes vault entries when requested", () => {
    const pkg = createExportPackage(
      [],
      { restorationPolicy: "none", selectedSessionIds: [], autoRestore: false },
      { includeVault: true },
    );
    expect(pkg.includesSensitiveData).toBe(true);
    expect(Array.isArray(pkg.vaultEntries)).toBe(true);
  });
});

describe("validateExportPackage", () => {
  const validPkg = {
    format: "aegox-multisession-export",
    version: 1,
    exportedAt: Date.now(),
    sessions: [
      {
        id: "s1",
        name: "Work",
        domain: "example.com",
        profileId: "p1",
        state: "active",
        persistent: true,
        restorable: true,
      },
    ],
    persistence: {
      restorationPolicy: "all",
      selectedSessionIds: [],
      autoRestore: true,
    },
    includesSensitiveData: false,
  };

  it("accepts a valid package", () => {
    const result = validateExportPackage(validPkg);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.preview?.sessionsToCreate).toBe(1);
  });

  it("rejects non-object input", () => {
    expect(validateExportPackage(null).valid).toBe(false);
    expect(validateExportPackage("string").valid).toBe(false);
    expect(validateExportPackage([1, 2]).valid).toBe(false);
  });

  it("rejects unknown format", () => {
    const result = validateExportPackage({ ...validPkg, format: "unknown" });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("format"))).toBe(true);
  });

  it("rejects wrong version", () => {
    const result = validateExportPackage({ ...validPkg, version: 999 });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("version"))).toBe(true);
  });

  it("rejects missing sessions array", () => {
    const { sessions, ...rest } = validPkg;
    const result = validateExportPackage(rest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("sessions"))).toBe(true);
  });

  it("rejects invalid session state", () => {
    const result = validateExportPackage({
      ...validPkg,
      sessions: [{ ...validPkg.sessions[0], state: "invalid" as any }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("state"))).toBe(true);
  });

  it("warns but accepts vault entries", () => {
    const result = validateExportPackage({
      ...validPkg,
      includesSensitiveData: true,
      vaultEntries: [{ createdAt: 1000, ciphertext: "abc", iv: "def", version: 1 }],
    });
    expect(result.valid).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.preview?.hasVaultData).toBe(true);
  });
});

describe("parseExportPackage", () => {
  it("parses valid JSON", () => {
    const parsed = parseExportPackage('{"key":"value"}');
    expect(parsed).toEqual({ key: "value" });
  });

  it("throws on invalid JSON", () => {
    expect(() => parseExportPackage("not json")).toThrow();
  });
});
