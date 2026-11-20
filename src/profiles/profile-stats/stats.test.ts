/**
 * Unit tests for `src/profiles/profile-stats/stats.ts`.
 * Statistics are local and aggregate; no website or page identifiers.
 */

import { describe, expect, it } from "vitest";

import {
  MemoryProfileStatsStore,
  ProfileStatsManager,
  computeAggregate,
  emptyStats,
} from "./stats";

describe("emptyStats / computeAggregate", () => {
  it("returns zeroed statistics", () => {
    expect(emptyStats("p1")).toEqual({
      profileId: "p1",
      sessionCount: 0,
      activeSessionCount: 0,
      lastAccessedAt: null,
      switchCount: 0,
      firstUsedAt: null,
    });
  });

  it("aggregates per-profile counters", () => {
    const aggregate = computeAggregate([
      {
        profileId: "p1",
        sessionCount: 3,
        activeSessionCount: 2,
        lastAccessedAt: 10,
        switchCount: 4,
        firstUsedAt: 1,
      },
      {
        profileId: "p2",
        sessionCount: 1,
        activeSessionCount: 0,
        lastAccessedAt: null,
        switchCount: 1,
        firstUsedAt: null,
      },
    ]);

    expect(aggregate).toEqual({
      totalProfiles: 2,
      activeProfiles: 1,
      totalSessions: 4,
      totalActiveSessions: 2,
      totalSwitches: 5,
    });
  });
});

describe("ProfileStatsManager — disabled by default", () => {
  it("records nothing while disabled", () => {
    const stats = new ProfileStatsManager({ now: () => 1000 });
    stats.setSessionCounts("p1", 5, 3);
    stats.recordSwitch("p1");

    expect(stats.isEnabled()).toBe(false);
    expect(stats.listStats()).toEqual([]);
    expect(stats.getStats("p1")).toEqual(emptyStats("p1"));
  });
});

describe("ProfileStatsManager — enabled", () => {
  it("records session counts and switches", () => {
    const stats = new ProfileStatsManager({ enabled: true, now: () => 1000 });

    stats.setSessionCounts("p1", 4, 2);
    stats.recordSwitch("p1");

    const entry = stats.getStats("p1");
    expect(entry.sessionCount).toBe(4);
    expect(entry.activeSessionCount).toBe(2);
    expect(entry.switchCount).toBe(1);
    expect(entry.lastAccessedAt).toBe(1000);
    expect(entry.firstUsedAt).toBe(1000);
  });

  it("clamps negative and inconsistent counts", () => {
    const stats = new ProfileStatsManager({ enabled: true });
    stats.setSessionCounts("p1", -3, 99);
    const entry = stats.getStats("p1");
    expect(entry.sessionCount).toBe(0);
    expect(entry.activeSessionCount).toBe(0);
  });

  it("does not move firstUsedAt on later activity", () => {
    let now = 1000;
    const stats = new ProfileStatsManager({ enabled: true, now: () => now });
    stats.recordSwitch("p1");
    now = 5000;
    stats.recordSwitch("p1");

    expect(stats.getStats("p1").firstUsedAt).toBe(1000);
    expect(stats.getStats("p1").lastAccessedAt).toBe(5000);
  });

  it("keeps records when collection is disabled again", () => {
    const stats = new ProfileStatsManager({ enabled: true });
    stats.recordSwitch("p1");
    stats.setEnabled(false);
    stats.recordSwitch("p1");

    expect(stats.getStats("p1").switchCount).toBe(1);
  });

  it("forgets one profile and clears everything", () => {
    const stats = new ProfileStatsManager({ enabled: true });
    stats.recordSwitch("p1");
    stats.recordSwitch("p2");

    stats.forget("p1");
    expect(stats.getStats("p1").switchCount).toBe(0);
    expect(stats.getStats("p2").switchCount).toBe(1);

    stats.clear();
    expect(stats.listStats()).toEqual([]);
  });

  it("persists through a store when one is configured", async () => {
    const store = new MemoryProfileStatsStore();
    const stats = new ProfileStatsManager({ enabled: true, store });
    stats.recordSwitch("p1");
    await stats.save();

    const reloaded = new ProfileStatsManager({ enabled: true, store });
    await reloaded.load();
    expect(reloaded.getStats("p1").switchCount).toBe(1);
  });

  it("aggregates its own records", () => {
    const stats = new ProfileStatsManager({ enabled: true, now: () => 1000 });
    stats.setSessionCounts("p1", 2, 1);
    stats.recordSwitch("p1");
    expect(stats.aggregate().totalSessions).toBe(2);
    expect(stats.aggregate().totalSwitches).toBe(1);
  });
});
