/**
 * Unit tests for `src/profiles/profile-lifecycle/deletion.ts`.
 * Verifies that sessions are never deleted without explicit confirmation.
 */

import { describe, expect, it } from "vitest";

import { MemoryStorageArea } from "../../engine/storage/storage-area";
import { SessionManager } from "../../core/session-manager/session-manager";
import { DEFAULT_PROFILE_ID } from "../../core/session-manager/session";
import { ProfileManager } from "../profile-manager/profile-manager";
import { ProfileAssociationManager } from "../profile-association/association";
import { WebsiteRulesManager } from "../profile-rules/website-rules";
import { ProfileStatsManager } from "../profile-stats/stats";
import { deleteProfileWithSessions, describeDeletionImpact } from "./deletion";

const make = async () => {
  const area = new MemoryStorageArea();
  const sm = new SessionManager(area);
  await sm.load();
  const pm = new ProfileManager(area, { now: () => 1000 });
  await pm.load();
  const pam = new ProfileAssociationManager(sm, pm, area);
  await pam.load();
  const rules = new WebsiteRulesManager(area);
  await rules.load();
  const stats = new ProfileStatsManager({ enabled: true, now: () => 1000 });

  const source = await pm.create({ name: "Source" });
  const target = await pm.create({ name: "Target" });
  const s1 = (await sm.create({ name: "Session 1", domain: "example.com" })).session;
  const s2 = (await sm.create({ name: "Session 2", domain: "example.com" })).session;
  await pam.associate(s1.id, source.profile.id);
  await pam.associate(s2.id, source.profile.id);
  await rules.addRule(source.profile.id, { domain: "example.com", action: "block" });
  stats.recordSwitch(source.profile.id);

  const dependencies = {
    profileManager: pm,
    associationManager: pam,
    sessionManager: sm,
    websiteRules: rules,
    stats,
  };
  return { area, sm, pm, pam, rules, stats, source, target, s1, s2, dependencies };
};

describe("describeDeletionImpact", () => {
  it("lists the sessions that would be affected", async () => {
    const { pm, pam, sm, source, s1, s2 } = await make();
    const impact = describeDeletionImpact(source.profile.id, pm, pam, sm);

    expect(impact.profileName).toBe("Source");
    expect(impact.sessionCount).toBe(2);
    expect(impact.sessions.map((session) => session.id).sort()).toEqual(
      [s1.id, s2.id].sort(),
    );
    expect(impact.sessions[0]!.domain).toBe("example.com");
    expect(impact.hasIndependentPassword).toBe(false);
  });

  it("throws for an unknown profile", async () => {
    const { pm, pam, sm } = await make();
    expect(() => describeDeletionImpact("missing", pm, pam, sm)).toThrow(/not found/);
  });
});

describe("deleteProfileWithSessions — keep", () => {
  it("keeps the sessions and moves them to the default profile", async () => {
    const { pm, pam, sm, source, s1, s2, dependencies } = await make();
    const result = await deleteProfileWithSessions(dependencies, {
      profileId: source.profile.id,
      sessions: { action: "keep" },
    });

    expect(result.ok).toBe(true);
    expect(result.keptSessions.sort()).toEqual([s1.id, s2.id].sort());
    expect(pm.get(source.profile.id)).toBeUndefined();
    expect(sm.get(s1.id)?.metadata.profileId).toBe(DEFAULT_PROFILE_ID);
    expect(sm.get(s2.id)?.metadata.profileId).toBe(DEFAULT_PROFILE_ID);
    expect(pam.getSessionsForProfile(source.profile.id)).toEqual([]);
  });

  it("clears the profile's rules and statistics", async () => {
    const { pm, rules, stats, source, dependencies } = await make();
    expect(rules.getRules(source.profile.id)).toHaveLength(1);

    await deleteProfileWithSessions(dependencies, {
      profileId: source.profile.id,
      sessions: { action: "keep" },
    });

    expect(rules.getRules(source.profile.id)).toEqual([]);
    expect(stats.getStats(source.profile.id).switchCount).toBe(0);
    expect(pm.listFolders()).toEqual([]);
  });
});

describe("deleteProfileWithSessions — reassign", () => {
  it("moves the sessions to the chosen profile", async () => {
    const { pm, pam, sm, source, target, s1, s2, dependencies } = await make();
    const result = await deleteProfileWithSessions(dependencies, {
      profileId: source.profile.id,
      sessions: { action: "reassign", toProfileId: target.profile.id },
    });

    expect(result.ok).toBe(true);
    expect(result.reassignedSessions.sort()).toEqual([s1.id, s2.id].sort());
    expect(sm.get(s1.id)?.metadata.profileId).toBe(target.profile.id);
    expect(pam.getSessionsForProfile(target.profile.id).sort()).toEqual(
      [s1.id, s2.id].sort(),
    );
    expect(pm.get(source.profile.id)).toBeUndefined();
  });

  it("refuses to reassign to the same or a missing profile", async () => {
    const { pm, source, target, dependencies } = await make();

    const same = await deleteProfileWithSessions(dependencies, {
      profileId: source.profile.id,
      sessions: { action: "reassign", toProfileId: source.profile.id },
    });
    expect(same.ok).toBe(false);
    expect(same.reason).toContain("different profile");
    expect(pm.get(source.profile.id)).toBeDefined();

    const missing = await deleteProfileWithSessions(dependencies, {
      profileId: source.profile.id,
      sessions: { action: "reassign", toProfileId: "missing" },
    });
    expect(missing.ok).toBe(false);
    expect(missing.reason).toContain("not found");

    await pm.archive(target.profile.id);
    const archived = await deleteProfileWithSessions(dependencies, {
      profileId: source.profile.id,
      sessions: { action: "reassign", toProfileId: target.profile.id },
    });
    expect(archived.ok).toBe(false);
    expect(archived.reason).toContain("archived");
  });
});

describe("deleteProfileWithSessions — delete sessions", () => {
  it("refuses to delete sessions without explicit confirmation", async () => {
    const { pm, sm, source, s1, s2, dependencies } = await make();
    const result = await deleteProfileWithSessions(dependencies, {
      profileId: source.profile.id,
      sessions: { action: "delete", confirmed: false },
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("explicit confirmation");
    expect(pm.get(source.profile.id)).toBeDefined();
    expect(sm.get(s1.id)).toBeDefined();
    expect(sm.get(s2.id)).toBeDefined();
  });

  it("deletes the sessions only after confirmation", async () => {
    const { pm, sm, source, s1, s2, dependencies } = await make();
    const result = await deleteProfileWithSessions(dependencies, {
      profileId: source.profile.id,
      sessions: { action: "delete", confirmed: true },
    });

    expect(result.ok).toBe(true);
    expect(result.deletedSessions.sort()).toEqual([s1.id, s2.id].sort());
    expect(sm.get(s1.id)).toBeUndefined();
    expect(sm.get(s2.id)).toBeUndefined();
    expect(pm.get(source.profile.id)).toBeUndefined();
  });
});

describe("deleteProfileWithSessions — failures", () => {
  it("reports an unknown profile without touching anything", async () => {
    const { sm, dependencies } = await make();
    const before = sm.list().length;

    const result = await deleteProfileWithSessions(dependencies, {
      profileId: "missing",
      sessions: { action: "keep" },
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("not found");
    expect(sm.list()).toHaveLength(before);
  });
});
