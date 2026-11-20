import { describe, expect, it } from "vitest";

import type { Profile } from "../profiles/profile-manager/profile";
import type { Session } from "../core/session-manager/session";
import { clampIndex, flattenResults, moveIndex, searchAll } from "./search";

const profile = (overrides: Partial<Profile> & { name?: string } = {}): Profile => ({
  id: overrides.id ?? "profile-a",
  state: "active",
  origin: "manual",
  expiresAt: null,
  folderId: null,
  tags: [],
  order: 0,
  hasIndependentPassword: false,
  websiteRules: [],
  settings: {
    restoreSessionsOnStartup: false,
    persistSessionData: true,
    websiteMode: "blocklist",
    collectStatistics: false,
    temporaryExpiryAction: "notify",
  },
  ...overrides,
  metadata: {
    name: overrides.name ?? "Work",
    color: null,
    icon: null,
    description: null,
    createdAt: 1,
    lastUsedAt: null,
    isDefault: false,
    ...overrides.metadata,
  },
});

const session = (overrides: Partial<Session> & { name?: string; domain?: string | null } = {}): Session => ({
  id: overrides.id ?? "session-a",
  state: "active",
  ...overrides,
  metadata: {
    name: overrides.name ?? "GitHub work",
    domain: overrides.domain === undefined ? "github.com" : overrides.domain,
    profileId: "profile-a",
    createdAt: 10,
    lastUsedAt: 20,
    persistent: true,
    restorable: true,
    ...overrides.metadata,
  },
});

describe("global search", () => {
  it("finds profiles by name, description and tag", () => {
    const profiles = [
      profile({ id: "p1", name: "Client work", tags: ["client", "billing"], metadata: {
        name: "Client work", color: null, icon: null, description: "Invoices and support",
        createdAt: 1, lastUsedAt: null, isDefault: false,
      } }),
      profile({ id: "p2", name: "Personal" }),
    ];
    const sessions = [session()];

    expect(searchAll("client", profiles, sessions).profiles.map((r) => r.id)).toEqual(["p1"]);
    expect(searchAll("invoice", profiles, sessions).profiles.map((r) => r.id)).toEqual(["p1"]);
    expect(searchAll("billing", profiles, sessions).profiles.map((r) => r.id)).toEqual(["p1"]);
  });

  it("finds sessions by name, domain and state", () => {
    const profiles = [profile({ id: "profile-a", name: "Work" })];
    const sessions = [session(), session({ id: "s2", name: "Mail", domain: "mail.example.com", state: "paused" })];

    expect(searchAll("github", profiles, sessions).sessions.map((r) => r.id)).toEqual(["session-a"]);
    expect(searchAll("mail.example", profiles, sessions).sessions.map((r) => r.id)).toEqual(["s2"]);
    expect(searchAll("paused", profiles, sessions).sessions.map((r) => r.id)).toEqual(["s2"]);
  });

  it("returns grouped results with totals and honest subtitles", () => {
    const results = searchAll("work", [profile({ name: "Work" })], [session({ name: "Work GitHub" })]);
    expect(results.total).toBe(2);
    expect(results.profiles[0]?.kind).toBe("profile");
    expect(results.sessions[0]?.kind).toBe("session");
    expect(results.sessions[0]?.subtitle).toContain("github.com");
  });

  it("handles empty, whitespace and no-result queries", () => {
    expect(searchAll("", [profile()], [session()])).toMatchObject({ total: 0, profiles: [], sessions: [] });
    expect(searchAll("   ", [profile()], [session()]).total).toBe(0);
    expect(searchAll("zzzz", [profile()], [session()]).total).toBe(0);
  });

  it("requires every token to match", () => {
    const profiles = [profile({ name: "Client work" })];
    expect(searchAll("client work", profiles, []).profiles).toHaveLength(1);
    expect(searchAll("client billing", profiles, []).profiles).toHaveLength(0);
  });

  it("ranks exact titles before partial matches", () => {
    const profiles = [profile({ id: "one", name: "Work" }), profile({ id: "two", name: "Work archive" })];
    const results = searchAll("work", profiles, []);
    expect(results.profiles.map((r) => r.id)).toEqual(["one", "two"]);
  });

  it("respects the per-category limit", () => {
    const profiles = Array.from({ length: 20 }, (_, index) => profile({ id: `p${index}`, name: `Profile ${index}` }));
    const results = searchAll("profile", profiles, [], 5);
    expect(results.profiles).toHaveLength(5);
  });

  it("flattens results and wraps keyboard navigation", () => {
    const results = searchAll("work", [profile({ name: "Work" })], [session({ name: "Work" })]);
    const flat = flattenResults(results);
    expect(flat).toHaveLength(2);
    expect(moveIndex(-1, 1, 2)).toBe(0);
    expect(moveIndex(0, 1, 2)).toBe(1);
    expect(moveIndex(1, 1, 2)).toBe(0);
    expect(moveIndex(0, -1, 2)).toBe(1);
    expect(moveIndex(0, 1, 0)).toBe(-1);
    expect(clampIndex(5, 2)).toBe(1);
    expect(clampIndex(-2, 2)).toBe(0);
    expect(clampIndex(0, 0)).toBe(-1);
  });

  it("never searches fields that could contain secrets", () => {
    const suspicious = profile({ name: "Work" }) as Profile & { password?: string; token?: string };
    suspicious.password = "hunter2-secret";
    suspicious.token = "tok_abcdef";
    const results = searchAll("hunter2", [suspicious], []);
    expect(results.total).toBe(0);
    expect(searchAll("tok_abcdef", [suspicious], []).total).toBe(0);
  });
});
