/**
 * Unit tests for `src/profiles/profile-manager/profile.ts`.
 * Pure TypeScript: no browser APIs required.
 */

import { describe, expect, it } from "vitest";

import {
  MAX_PROFILE_NAME,
  collapseProfileName,
  createProfile,
  generateProfileId,
  isDuplicateProfile,
  normalizeColor,
  normalizeIcon,
  normalizeSettings,
  normalizeTag,
  sanitizeProfileNameInput,
  validateFolderName,
  validateProfileMetadata,
} from "./profile";

const metadata = (overrides: Record<string, unknown> = {}) =>
  ({
    name: "Work",
    color: "#4f46e5",
    icon: "briefcase",
    description: "Work profile",
    createdAt: 1000,
    lastUsedAt: null,
    isDefault: false,
    ...overrides,
  }) as Parameters<typeof createProfile>[0];

describe("generateProfileId", () => {
  it("generates an RFC 4122 v4 shaped identifier", () => {
    const id = generateProfileId();
    expect(id.length).toBe(36);
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("generates unique IDs on consecutive calls", () => {
    expect(generateProfileId()).not.toBe(generateProfileId());
  });

  it("supports a deterministic random source", () => {
    const id = generateProfileId(() => 0.5);
    expect(id).toBe("80808080-8080-4080-8080-808080808080");
  });
});

describe("createProfile", () => {
  it("creates an active profile with default fields", () => {
    const profile = createProfile(metadata({ isDefault: true }));
    expect(profile.state).toBe("active");
    expect(profile.metadata.name).toBe("Work");
    expect(profile.metadata.isDefault).toBe(true);
    expect(profile.origin).toBe("manual");
    expect(profile.tags).toEqual([]);
    expect(profile.folderId).toBeNull();
    expect(profile.expiresAt).toBeNull();
    expect(profile.hasIndependentPassword).toBe(false);
    expect(profile.websiteRules).toEqual([]);
    expect(profile.settings.collectStatistics).toBe(false);
  });

  it("accepts options and clones their arrays", () => {
    const rules: Array<{ domain: string; action: "allow" | "block"; enabled: boolean; createdAt: number }> = [
      { domain: "example.com", action: "block", enabled: true, createdAt: 1 },
    ];
    const profile = createProfile(metadata(), {
      id: "custom-id",
      origin: "automatic",
      state: "temporary",
      expiresAt: 5000,
      folderId: "folder-1",
      tags: ["work"],
      websiteRules: rules,
      settings: { collectStatistics: true },
    });
    expect(profile.id).toBe("custom-id");
    expect(profile.origin).toBe("automatic");
    expect(profile.state).toBe("temporary");
    expect(profile.expiresAt).toBe(5000);
    expect(profile.folderId).toBe("folder-1");
    expect(profile.tags).toEqual(["work"]);
    expect(profile.settings.collectStatistics).toBe(true);
    expect(profile.settings.restoreSessionsOnStartup).toBe(true);

    rules[0]!.action = "allow";
    expect(profile.websiteRules[0]!.action).toBe("block");
  });
});

describe("isDuplicateProfile", () => {
  it("matches case-insensitively on name", () => {
    expect(
      isDuplicateProfile(createProfile(metadata({ name: "Work" })), createProfile(metadata({ name: "WORK" }))),
    ).toBe(true);
  });

  it("matches identical non-empty descriptions and colors", () => {
    const a = createProfile(metadata({ name: "A", description: "Same", color: "#111111" }));
    const b = createProfile(metadata({ name: "B", description: "Same", color: "#111111" }));
    expect(isDuplicateProfile(a, b)).toBe(true);
  });

  it("does not match when both descriptions are null", () => {
    const a = createProfile(metadata({ name: "A", description: null }));
    const b = createProfile(metadata({ name: "B", description: null }));
    expect(isDuplicateProfile(a, b)).toBe(false);
  });

  it("does not match different names and metadata", () => {
    const a = createProfile(metadata({ name: "Work", color: "#4f46e5", description: "One" }));
    const b = createProfile(metadata({ name: "Personal", color: "#ff0000", description: "Two" }));
    expect(isDuplicateProfile(a, b)).toBe(false);
  });
});

describe("sanitizeProfileNameInput", () => {
  it("collapses whitespace and trims leading spaces", () => {
    expect(sanitizeProfileNameInput("  Work   profile  ")).toBe("Work profile");
  });

  it("drops control and zero-width characters", () => {
    expect(sanitizeProfileNameInput("Wo\u0000rk\u200b")).toBe("Work");
  });

  it("caps at max length by code points", () => {
    expect(Array.from(sanitizeProfileNameInput("a".repeat(100))).length).toBe(
      MAX_PROFILE_NAME,
    );
  });
});

describe("normalizeColor / normalizeIcon / normalizeTag", () => {
  it("accepts only strict hex colors", () => {
    expect(normalizeColor(" #ABC ")).toBe("#abc");
    expect(normalizeColor("#11223344")).toBe("#11223344");
    expect(normalizeColor("red")).toBeNull();
    expect(normalizeColor("url(javascript:alert(1))")).toBeNull();
    expect(normalizeColor(42)).toBeNull();
  });

  it("strips control characters from icons", () => {
    expect(normalizeIcon("  🔒 ")).toBe("🔒");
    expect(normalizeIcon("\u0000")).toBeNull();
    expect(normalizeIcon(123)).toBeNull();
  });

  it("normalizes tags and rejects empty ones", () => {
    expect(normalizeTag("  Work, urgent ")).toBe("Work urgent");
    expect(normalizeTag("   ")).toBeNull();
  });
});

describe("normalizeSettings", () => {
  it("returns defaults for untrusted input", () => {
    const settings = normalizeSettings(null);
    expect(settings.websiteMode).toBe("blocklist");
    expect(settings.collectStatistics).toBe(false);
    expect(settings.temporaryExpiryAction).toBe("notify");
  });

  it("keeps valid values and rejects invalid ones", () => {
    const settings = normalizeSettings({
      websiteMode: "allowlist",
      collectStatistics: true,
      restoreSessionsOnStartup: "yes",
      temporaryExpiryAction: "archive",
    });
    expect(settings.websiteMode).toBe("allowlist");
    expect(settings.collectStatistics).toBe(true);
    expect(settings.restoreSessionsOnStartup).toBe(true);
    expect(settings.temporaryExpiryAction).toBe("archive");
  });
});

describe("validateFolderName", () => {
  it("accepts a new name", () => {
    const result = validateFolderName("  Clients ", ["Work"]);
    expect(result).toEqual({ ok: true, name: "Clients" });
  });

  it("rejects empty and duplicate names", () => {
    expect(validateFolderName("  ", []).ok).toBe(false);
    expect(validateFolderName("work", ["Work"]).ok).toBe(false);
  });

  it("allows keeping the folder's own name", () => {
    expect(validateFolderName("Work", ["Work"], "Work").ok).toBe(true);
  });
});

describe("collapseProfileName", () => {
  it("trims and collapses runs of whitespace", () => {
    expect(collapseProfileName("  a \n b  ")).toBe("a b");
  });
});

describe("validateProfileMetadata", () => {
  const existing = ["Work", "Personal"];

  it("accepts and normalizes valid metadata", () => {
    const result = validateProfileMetadata(
      {
        name: "  New Profile  ",
        color: "#FF0000",
        icon: "star",
        description: " A profile ",
        tags: ["work", "WORK", "urgent"],
      },
      existing,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.metadata.name).toBe("New Profile");
      expect(result.metadata.color).toBe("#ff0000");
      expect(result.metadata.description).toBe("A profile");
      expect(result.metadata.isDefault).toBe(false);
    }
  });

  it("uses defaults for a missing color and icon", () => {
    const result = validateProfileMetadata({ name: "New" }, existing);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.metadata.color).toBe("#4f46e5");
      expect(result.metadata.icon).toBe("folder");
    }
  });

  it("rejects an empty name", () => {
    expect(validateProfileMetadata({ name: "   " }, existing).ok).toBe(false);
  });

  it("rejects duplicate names case-insensitively", () => {
    expect(validateProfileMetadata({ name: "WORK" }, existing).ok).toBe(false);
  });

  it("allows keeping the profile's own name when renaming", () => {
    expect(validateProfileMetadata({ name: "Work" }, existing, "Work").ok).toBe(true);
  });

  it("allows duplicate names only when explicitly requested (import)", () => {
    const result = validateProfileMetadata({ name: "Work" }, existing, undefined, {
      allowDuplicateName: true,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects invalid colors and non-text descriptions", () => {
    expect(validateProfileMetadata({ name: "X", color: "blue" }, existing).ok).toBe(false);
    expect(validateProfileMetadata({ name: "X", description: 5 }, existing).ok).toBe(false);
    expect(validateProfileMetadata({ name: "X", icon: 5 }, existing).ok).toBe(false);
  });

  it("caps the description length", () => {
    const result = validateProfileMetadata(
      { name: "X", description: "a".repeat(1000) },
      existing,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(Array.from(result.metadata.description ?? "").length).toBe(500);
  });
});
