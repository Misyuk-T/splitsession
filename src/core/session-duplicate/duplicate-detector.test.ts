/**
 * Unit tests for `src/core/session-duplicate/duplicate-detector.ts`.
 * Pure TypeScript: no browser APIs required.
 */

import { describe, expect, it } from "vitest";

import {
  checkDuplicate,
  duplicateKey,
  findDuplicateGroups,
  findDuplicateSessions,
  validateNoUnwantedDuplicate,
} from "./duplicate-detector";
import { createSession } from "../session-manager/session";

const baseSession = (overrides: Partial<Parameters<typeof createSession>[0]> = {}) =>
  createSession({
    name: "Test",
    domain: null,
    profileId: "default",
    createdAt: 1000,
    lastUsedAt: null,
    persistent: true,
    restorable: true,
    ...overrides,
  });

describe("duplicateKey", () => {
  it("builds key from domain + profile", () => {
    const s = baseSession({ domain: "example.com", profileId: "p1" });
    expect(duplicateKey(s)).toBe("example.com|p1");
  });

  it("uses placeholders for missing domain/profile", () => {
    const s = baseSession({ domain: null, profileId: null });
    expect(duplicateKey(s)).toBe("<no-domain>|<no-profile>");
  });

  it("lowercases domain", () => {
    const s = baseSession({ domain: "Example.COM", profileId: "p1" });
    expect(duplicateKey(s)).toBe("example.com|p1");
  });
});

describe("checkDuplicate", () => {
  it("detects duplicate by domain + profile", () => {
    const existing = [baseSession({ name: "A", domain: "example.com", profileId: "p1" })];
    const candidate = baseSession({ name: "B", domain: "example.com", profileId: "p1" });
    const result = checkDuplicate(candidate, existing);
    expect(result.isDuplicate).toBe(true);
    expect(result.existing?.id).toBe(existing[0]!.id);
  });

  it("does not flag different domain as duplicate", () => {
    const existing = [baseSession({ domain: "example.com", profileId: "p1" })];
    const candidate = baseSession({ domain: "other.com", profileId: "p1" });
    expect(checkDuplicate(candidate, existing).isDuplicate).toBe(false);
  });

  it("does not flag different profile as duplicate", () => {
    const existing = [baseSession({ domain: "example.com", profileId: "p1" })];
    const candidate = baseSession({ domain: "example.com", profileId: "p2" });
    expect(checkDuplicate(candidate, existing).isDuplicate).toBe(false);
  });

  it("ignores the candidate itself", () => {
    const s = baseSession({ domain: "example.com", profileId: "p1" });
    expect(checkDuplicate(s, [s]).isDuplicate).toBe(false);
  });
});

describe("findDuplicateGroups", () => {
  it("groups sessions with same domain + profile", () => {
    const sessions = [
      baseSession({ name: "A", domain: "example.com", profileId: "p1" }),
      baseSession({ name: "B", domain: "example.com", profileId: "p1" }),
      baseSession({ name: "C", domain: "other.com", profileId: "p1" }),
    ];
    const groups = findDuplicateGroups(sessions);
    expect(groups.length).toBe(1);
    expect(groups[0]!.sessions.length).toBe(2);
  });

  it("returns empty when no duplicates", () => {
    const sessions = [
      baseSession({ domain: "a.com", profileId: "p1" }),
      baseSession({ domain: "b.com", profileId: "p1" }),
    ];
    expect(findDuplicateGroups(sessions)).toEqual([]);
  });
});

describe("findDuplicateSessions", () => {
  it("returns sessions that are part of duplicate groups", () => {
    const sessions = [
      baseSession({ name: "A", domain: "example.com", profileId: "p1" }),
      baseSession({ name: "B", domain: "example.com", profileId: "p1" }),
      baseSession({ name: "C", domain: "other.com", profileId: "p1" }),
    ];
    const dups = findDuplicateSessions(sessions);
    expect(dups.length).toBe(2);
    expect(dups.map((s) => s.metadata.name)).toContain("A");
    expect(dups.map((s) => s.metadata.name)).toContain("B");
  });
});

describe("validateNoUnwantedDuplicate", () => {
  it("allows when duplicates are allowed", () => {
    const existing = [baseSession({ domain: "example.com", profileId: "p1" })];
    const candidate = baseSession({ domain: "example.com", profileId: "p1" });
    const result = validateNoUnwantedDuplicate(candidate, existing, true);
    expect(result.isDuplicate).toBe(true);
    // Should not add extra restriction when allowDuplicates is true
  });

  it("rejects when duplicates are not allowed", () => {
    const existing = [baseSession({ domain: "example.com", profileId: "p1" })];
    const candidate = baseSession({ domain: "example.com", profileId: "p1" });
    const result = validateNoUnwantedDuplicate(candidate, existing, false);
    expect(result.isDuplicate).toBe(true);
    expect(result.reason).toContain("Duplicate");
  });
});
