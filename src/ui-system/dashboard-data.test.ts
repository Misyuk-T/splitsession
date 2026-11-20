import { describe, expect, it } from "vitest";

import type { Profile } from "../profiles/profile-manager/profile";
import type { Session, SessionState } from "../core/session-manager/session";
import {
  buildDashboard,
  profileSummaries,
  profileTotals,
  recentActivity,
  securityWarnings,
  sessionTotals,
} from "./dashboard-data";

const profile = (
  id: string,
  state: Profile["state"] = "active",
  overrides: Partial<Profile> = {},
): Profile => ({
  id,
  state,
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
    name: id,
    color: null,
    icon: null,
    description: null,
    createdAt: 100,
    lastUsedAt: null,
    isDefault: false,
    ...overrides.metadata,
  },
});

const session = (
  id: string,
  state: SessionState = "active",
  profileId: string | null = "p1",
  at = 100,
): Session => ({
  id,
  state,
  metadata: {
    name: id,
    domain: "example.com",
    profileId,
    createdAt: at,
    lastUsedAt: null,
    persistent: true,
    restorable: true,
  },
});

describe("dashboard aggregation", () => {
  it("counts sessions by real state", () => {
    const totals = sessionTotals([
      session("a", "active"),
      session("b", "active"),
      session("c", "paused"),
      session("d", "expired"),
      session("e", "archived"),
      session("f", "closed"),
    ]);
    expect(totals).toEqual({
      total: 6,
      active: 2,
      paused: 1,
      expired: 1,
      archived: 1,
      closed: 1,
    });
  });

  it("counts profiles and favorites", () => {
    const totals = profileTotals(
      [profile("p1"), profile("p2", "archived"), profile("p3", "temporary"), profile("p4", "deleted")],
      ["p1", "missing", "p2", "p1"],
    );
    expect(totals).toMatchObject({
      total: 4,
      active: 1,
      archived: 1,
      temporary: 1,
      deleted: 1,
      favorites: 2,
    });
  });

  it("groups session counts under each profile, including zeroes", () => {
    const summaries = profileSummaries(
      [profile("p1"), profile("p2")],
      [session("a", "active", "p1"), session("b", "paused", "p1"), session("c", "active", "p2"), session("d", "active", null)],
      ["p2"],
    );
    expect(summaries.map((summary) => [summary.profile.id, summary.sessionCount, summary.activeSessionCount])).toEqual([
      ["p1", 2, 1],
      ["p2", 1, 1],
    ]);
    expect(summaries[1]?.favorite).toBe(true);
  });

  it("builds recent activity only from real timestamps, newest first", () => {
    const sessionB = session("b", "paused", "p1", 200);
    const activity = recentActivity(
      [profile("p1", "active", { metadata: { name: "p1", color: null, icon: null, description: null, createdAt: 50, lastUsedAt: 500, isDefault: false } })],
      [
        session("a", "active", "p1", 100),
        { ...sessionB, metadata: { ...sessionB.metadata, lastUsedAt: 900 } },
      ],
      3,
    );
    expect(activity.map((item) => item.id)).toEqual([
      "session-used:b",
      "profile-used:p1",
      "session-created:b",
    ]);
    expect(activity.flatMap((item) => Object.values(item))).not.toContain("example.com");
    expect(activity[0]?.at).toBe(900);
  });

  it("reports expired sessions and temporary profiles as warnings", () => {
    const warnings = securityWarnings(
      [
        profile("p1"),
        profile("p2", "temporary", { expiresAt: 500 }),
        profile("p3", "temporary", { expiresAt: 50_000 }),
      ],
      [session("a", "expired"), session("b", "active")],
      1000,
    );
    expect(warnings.map((warning) => warning.id)).toEqual([
      "expired-sessions",
      "expired-temporary-profiles",
    ]);
    expect(warnings[0]?.detail).toContain("Restore or archive");
  });

  it("does not warn about independent passwords when at least one profile has one", () => {
    const warnings = securityWarnings(
      [profile("p1", "active", { hasIndependentPassword: true }), profile("p2")],
      [],
      1000,
    );
    expect(warnings).toHaveLength(0);
  });

  it("builds the complete overview with favorites and statistics", () => {
    const overview = buildDashboard({
      profiles: [profile("p1", "active", { metadata: { name: "Work", color: null, icon: null, description: null, createdAt: 10, lastUsedAt: 20, isDefault: true } }), profile("p2")],
      sessions: [session("s1", "active", "p1", 30), session("s2", "paused", "p2", 40)],
      favoriteProfileIds: ["p1", "missing"],
      favoriteSessionIds: ["s2", "missing"],
      statistics: {
        totalProfiles: 2,
        activeProfiles: 1,
        totalSessions: 2,
        totalActiveSessions: 1,
        totalSwitches: 7,
      },
      now: 1000,
    });
    expect(overview.sessions.active).toBe(1);
    expect(overview.sessions.paused).toBe(1);
    expect(overview.profiles.favorites).toBe(1);
    expect(overview.favorites.profiles.map((p) => p.id)).toEqual(["p1"]);
    expect(overview.favorites.sessions.map((s) => s.id)).toEqual(["s2"]);
    expect(overview.statistics?.totalSwitches).toBe(7);
    expect(overview.isEmpty).toBe(false);
    expect(overview.warnings.map((warning) => warning.id)).toContain("no-profile-password");
  });

  it("reports an empty store honestly", () => {
    const overview = buildDashboard({ profiles: [], sessions: [], now: 1000 });
    expect(overview.isEmpty).toBe(true);
    expect(overview.statistics).toBeNull();
    expect(overview.recentActivity).toEqual([]);
    expect(overview.warnings).toEqual([]);
    expect(overview.favorites).toEqual({ profiles: [], sessions: [] });
  });

  it("limits recent activity", () => {
    const sessions = Array.from({ length: 20 }, (_, index) => session(`s${index}`, "active", "p1", index + 1));
    expect(recentActivity([profile("p1")], sessions, 5)).toHaveLength(5);
  });
});
