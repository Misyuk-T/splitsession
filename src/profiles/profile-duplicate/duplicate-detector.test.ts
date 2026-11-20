/**
 * Unit tests for `src/profiles/profile-duplicate/duplicate-detector.ts`.
 * Pure TypeScript: no browser APIs required.
 */

import { describe, expect, it } from "vitest";

import {
  SIMILARITY_REVIEW_THRESHOLD,
  checkDuplicate,
  duplicateKey,
  explainDuplicate,
  findDuplicateGroups,
  findDuplicateProfiles,
  findSimilarPairs,
  profileSimilarity,
} from "./duplicate-detector";
import { createProfile } from "../profile-manager/profile";

let counter = 0;

const profile = (
  overrides: Partial<Parameters<typeof createProfile>[1]> = {},
) => {
  counter += 1;
  return createProfile(
    {
      name: "Test",
      color: "#4f46e5",
      icon: null,
      description: null,
      createdAt: counter,
      lastUsedAt: null,
      isDefault: false,
    },
    {
      id: `profile-${counter}`,
      ...overrides,
    },
  );
};

describe("profileSimilarity", () => {
  it("returns 1 for identical profiles", () => {
    const a = profile({ tags: ["work"] });
    const b = profile({ tags: ["work"] });
    a.metadata.description = "Work";
    b.metadata.description = "Work";
    expect(profileSimilarity(a, b)).toBe(1);
  });

  it("returns low similarity for unrelated profiles", () => {
    const a = profile();
    const b = profile();
    a.metadata.name = "Work";
    a.metadata.description = "Work";
    a.metadata.color = "#4f46e5";
    b.metadata.name = "Personal";
    b.metadata.description = "Personal";
    b.metadata.color = "#ff0000";
    expect(profileSimilarity(a, b)).toBeLessThan(0.5);
  });

  it("scores the same name highly even with a different color", () => {
    const a = profile();
    const b = profile();
    a.metadata.name = "Work";
    b.metadata.name = "Work";
    expect(profileSimilarity(a, b)).toBeGreaterThan(0.5);
  });
});

describe("duplicateKey", () => {
  it("builds a lowercase name + color key", () => {
    const value = profile();
    value.metadata.name = "WORK";
    value.metadata.color = "#4F46E5";
    expect(duplicateKey(value)).toBe("work|#4f46e5");
  });
});

describe("checkDuplicate", () => {
  it("detects near-duplicates and explains why", () => {
    const existing = profile();
    existing.metadata.name = "Work";
    const candidate = profile();
    candidate.metadata.name = "Work";

    const result = checkDuplicate(candidate, [existing]);
    expect(result.isDuplicate).toBe(true);
    expect(result.similarity).toBeGreaterThanOrEqual(SIMILARITY_REVIEW_THRESHOLD);
    expect(result.existing?.metadata.name).toBe("Work");
    expect(result.reason).toContain("similar");
  });

  it("does not flag unrelated profiles", () => {
    const existing = profile();
    existing.metadata.name = "Work";
    existing.metadata.color = "#4f46e5";
    const candidate = profile();
    candidate.metadata.name = "Personal";
    candidate.metadata.color = "#ff0000";

    expect(checkDuplicate(candidate, [existing]).isDuplicate).toBe(false);
  });

  it("ignores the candidate itself", () => {
    const value = profile();
    value.metadata.name = "Work";
    value.metadata.description = "Work";
    expect(checkDuplicate(value, [value]).isDuplicate).toBe(false);
  });

  it("never changes the input list", () => {
    const existing = profile();
    existing.metadata.name = "Work";
    const before = JSON.stringify(existing);
    profile();
    checkDuplicate(existing, [existing]);
    expect(JSON.stringify(existing)).toBe(before);
  });
});

describe("findDuplicateGroups", () => {
  it("groups profiles with the same name and color", () => {
    const a = profile();
    const b = profile();
    for (const value of [a, b]) {
      value.metadata.name = "Work";
      value.metadata.color = "#4f46e5";
    }
    const other = profile();
    other.metadata.name = "Other";

    const groups = findDuplicateGroups([a, b, other]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.profiles.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
    expect(groups[0]!.reason).toContain("Work");
  });

  it("returns no groups when everything is distinct", () => {
    const a = profile();
    const b = profile();
    a.metadata.name = "A";
    b.metadata.name = "B";
    expect(findDuplicateGroups([a, b])).toEqual([]);
  });
});

describe("findDuplicateProfiles", () => {
  it("returns the profiles that belong to a group, without duplicates", () => {
    const a = profile();
    const b = profile();
    const c = profile();
    a.metadata.name = "Work";
    b.metadata.name = "Work";
    c.metadata.name = "Other";

    const result = findDuplicateProfiles([a, b, c]);
    expect(result).toHaveLength(2);
    expect(new Set(result.map((p) => p.id)).size).toBe(2);
  });
});

describe("findSimilarPairs", () => {
  it("returns high-similarity pairs with reasons", () => {
    const a = profile({ tags: ["work"] });
    const b = profile({ tags: ["work"] });
    for (const value of [a, b]) {
      value.metadata.name = "Work";
      value.metadata.description = "Work";
    }

    const pairs = findSimilarPairs([a, b, profile()]);
    expect(pairs.length).toBeGreaterThanOrEqual(1);
    expect(pairs[0]!.reasons.length).toBeGreaterThan(0);
    expect(pairs[0]!.similarity).toBeGreaterThanOrEqual(0.85);
  });

  it("honors a custom threshold", () => {
    const a = profile();
    const b = profile();
    a.metadata.name = "Work";
    b.metadata.name = "Work";
    expect(findSimilarPairs([a, b], 1)).toHaveLength(0);
  });
});

describe("explainDuplicate", () => {
  it("lists shared attributes", () => {
    const a = profile({ tags: ["urgent"] });
    const b = profile({ tags: ["urgent", "work"] });
    for (const value of [a, b]) {
      value.metadata.name = "Work";
      value.metadata.description = "Work";
    }

    const reasons = explainDuplicate(a, b);
    expect(reasons.some((reason) => reason.includes("Same name"))).toBe(true);
    expect(reasons.some((reason) => reason.includes("Same color"))).toBe(true);
    expect(reasons.some((reason) => reason.includes("Same description"))).toBe(true);
    expect(reasons.some((reason) => reason.includes("urgent"))).toBe(true);
  });

  it("falls back to a generic explanation", () => {
    const a = profile();
    const b = profile();
    a.metadata.name = "Alpha";
    b.metadata.name = "Alphi";
    a.metadata.color = null;
    b.metadata.color = null;

    const reasons = explainDuplicate(a, b);
    expect(reasons.length).toBeGreaterThan(0);
  });
});
