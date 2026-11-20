/**
 * Unit tests for `src/core/session-manager/session.ts`.
 * Pure TypeScript: no browser APIs required.
 */

import { describe, expect, it } from "vitest";

import {
  createSession,
  generateSessionId,
  isDuplicateSession,
  sanitizeSessionNameInput,
  validateSessionMetadata,
  MAX_SESSION_NAME,
  DEFAULT_PROFILE_ID,
} from "./session";

describe("generateSessionId", () => {
  it("generates a 36-character UUID-style string", () => {
    const id = generateSessionId();
    expect(typeof id).toBe("string");
    expect(id.length).toBe(36);
    expect(id).toMatch(/^[0-9a-f]{8}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("generates unique IDs on consecutive calls", () => {
    const a = generateSessionId();
    const b = generateSessionId();
    expect(a).not.toBe(b);
  });
});

describe("createSession", () => {
  it("creates an active session with provided metadata", () => {
    const session = createSession({
      name: "Work",
      domain: "example.com",
      profileId: "profile-1",
      createdAt: 1000,
      lastUsedAt: null,
      persistent: true,
      restorable: true,
    });
    expect(session.state).toBe("active");
    expect(session.metadata.name).toBe("Work");
    expect(session.metadata.domain).toBe("example.com");
    expect(session.metadata.profileId).toBe("profile-1");
    expect(session.metadata.persistent).toBe(true);
    expect(session.metadata.restorable).toBe(true);
    expect(session.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("accepts a custom ID", () => {
    const session = createSession(
      {
        name: "Custom",
        domain: null,
        profileId: DEFAULT_PROFILE_ID,
        createdAt: 1000,
        lastUsedAt: null,
        persistent: true,
        restorable: true,
      },
      "custom-id-123",
    );
    expect(session.id).toBe("custom-id-123");
  });
});

describe("isDuplicateSession", () => {
  const base = {
    createdAt: 1000,
    lastUsedAt: null,
    persistent: true,
    restorable: true,
  };

  it("detects duplicates by domain + profile", () => {
    const a = createSession({ ...base, name: "A", domain: "example.com", profileId: "p1" });
    const b = createSession({ ...base, name: "B", domain: "example.com", profileId: "p1" });
    expect(isDuplicateSession(a, b)).toBe(true);
  });

  it("does not detect duplicates when domain differs", () => {
    const a = createSession({ ...base, name: "A", domain: "example.com", profileId: "p1" });
    const b = createSession({ ...base, name: "B", domain: "other.com", profileId: "p1" });
    expect(isDuplicateSession(a, b)).toBe(false);
  });

  it("does not detect duplicates when profile differs", () => {
    const a = createSession({ ...base, name: "A", domain: "example.com", profileId: "p1" });
    const b = createSession({ ...base, name: "B", domain: "example.com", profileId: "p2" });
    expect(isDuplicateSession(a, b)).toBe(false);
  });

  it("does not detect duplicates when domain is null", () => {
    const a = createSession({ ...base, name: "A", domain: null, profileId: "p1" });
    const b = createSession({ ...base, name: "B", domain: null, profileId: "p1" });
    expect(isDuplicateSession(a, b)).toBe(false);
  });
});

describe("sanitizeSessionNameInput", () => {
  it("collapses whitespace and trims leading spaces", () => {
    expect(sanitizeSessionNameInput("  Work   account  ")).toBe("Work account");
  });

  it("drops control characters", () => {
    expect(sanitizeSessionNameInput("Wo\u0000rk")).toBe("Work");
  });

  it("caps at max length", () => {
    const long = "a".repeat(100);
    expect(sanitizeSessionNameInput(long).length).toBe(MAX_SESSION_NAME);
  });
});

describe("validateSessionMetadata", () => {
  const existing = ["Work", "Personal"];

  it("accepts valid metadata", () => {
    const result = validateSessionMetadata(
      { name: "  New Session  ", domain: "example.com", profileId: "p1" },
      existing,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.metadata.name).toBe("New Session");
      expect(result.metadata.domain).toBe("example.com");
      expect(result.metadata.profileId).toBe("p1");
    }
  });

  it("rejects empty name", () => {
    const result = validateSessionMetadata({ name: "   " }, existing);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("name");
  });

  it("rejects duplicate name", () => {
    const result = validateSessionMetadata({ name: "WORK" }, existing);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("already exists");
  });

  it("allows keeping own name when renaming", () => {
    const result = validateSessionMetadata({ name: "Work" }, existing, "Work");
    expect(result.ok).toBe(true);
  });

  it("accepts URL as domain and reduces to host", () => {
    const result = validateSessionMetadata(
      { name: "Test", domain: "https://www.Example.com/path" },
      existing,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.metadata.domain).toBe("www.example.com");
  });

  it("rejects invalid domain", () => {
    const result = validateSessionMetadata(
      { name: "Test", domain: "not a valid site" },
      existing,
    );
    expect(result.ok).toBe(false);
  });

  it("defaults persistent and restorable to true", () => {
    const result = validateSessionMetadata({ name: "Test" }, existing);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.metadata.persistent).toBe(true);
      expect(result.metadata.restorable).toBe(true);
    }
  });
});
