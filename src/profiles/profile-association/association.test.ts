/**
 * Unit tests for `src/profiles/profile-association/association.ts`.
 * Uses in-memory fakes (no real browser APIs required).
 */

import { describe, expect, it } from "vitest";

import {
  PROFILE_ASSOCIATIONS_KEY,
  ProfileAssociationManager,
  domainMatches,
} from "./association";
import { SessionManager } from "../../core/session-manager/session-manager";
import { DEFAULT_PROFILE_ID } from "../../core/session-manager/session";
import { MemoryStorageArea } from "../../engine/storage/storage-area";
import { ProfileManager } from "../profile-manager/profile-manager";

const setup = () => {
  const area = new MemoryStorageArea();
  const sm = new SessionManager(area);
  const pm = new ProfileManager(area);
  const pam = new ProfileAssociationManager(sm, pm, area, { now: () => 1000 });
  return { area, sm, pm, pam };
};

const createSession = async (sm: SessionManager, name: string, domain = "example.com") => {
  const created = await sm.create({ name, domain });
  return created.session;
};

describe("ProfileAssociationManager — manual association", () => {
  it("associates a session with a profile and mirrors it into Session Core", async () => {
    const { sm, pm, pam } = setup();
    const session = await createSession(sm, "Session 1");
    const { profile } = await pm.create({ name: "Profile 1" });

    const result = await pam.associate(session.id, profile.id, "manual");
    expect(result.ok).toBe(true);
    expect(result.session?.metadata.profileId).toBe(profile.id);
    expect(pam.getAssociation(session.id)).toBe(profile.id);
    expect(pam.getAssociationRecord(session.id)?.mode).toBe("manual");
    expect(sm.get(session.id)?.metadata.profileId).toBe(profile.id);
  });

  it("does not change anything when the session is missing", async () => {
    const { pm, pam } = setup();
    const { profile } = await pm.create({ name: "Profile 1" });
    const result = await pam.associate("missing", profile.id);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("not found");
  });

  it("refuses archived and deleted profiles", async () => {
    const { sm, pm, pam } = setup();
    const session = await createSession(sm, "Session 1");
    const { profile } = await pm.create({ name: "Profile 1" });
    await pm.archive(profile.id);

    const archived = await pam.associate(session.id, profile.id);
    expect(archived.ok).toBe(false);
    expect(archived.reason).toContain("archived");

    await pm.markDeleted(profile.id);
    const deleted = await pam.associate(session.id, profile.id);
    expect(deleted.ok).toBe(false);
    expect(deleted.reason).toContain("deleted");
  });

  it("reassigns a session to another profile", async () => {
    const { sm, pm, pam } = setup();
    const session = await createSession(sm, "Session 1");
    const a = await pm.create({ name: "Profile A" });
    const b = await pm.create({ name: "Profile B" });

    await pam.associate(session.id, a.profile.id);
    const result = await pam.reassign(session.id, b.profile.id);
    expect(result.ok).toBe(true);
    expect(pam.getAssociation(session.id)).toBe(b.profile.id);
    expect(sm.get(session.id)?.metadata.profileId).toBe(b.profile.id);
  });

  it("refuses to reassign a session that has no association", async () => {
    const { sm, pm, pam } = setup();
    const session = await createSession(sm, "Session 1");
    const { profile } = await pm.create({ name: "Profile 1" });
    const result = await pam.reassign(session.id, profile.id);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("no association");
  });

  it("dissociates without deleting the session", async () => {
    const { sm, pm, pam } = setup();
    const session = await createSession(sm, "Session 1");
    const { profile } = await pm.create({ name: "Profile 1" });
    await pam.associate(session.id, profile.id);

    expect(await pam.dissociate(session.id)).toBe(true);
    expect(pam.getAssociation(session.id)).toBeUndefined();
    expect(sm.get(session.id)).toBeDefined();
    expect(await pam.dissociate(session.id)).toBe(false);
  });

  it("detaches a session back to the default profile on request", async () => {
    const { sm, pm, pam } = setup();
    const session = await createSession(sm, "Session 1");
    const { profile } = await pm.create({ name: "Profile 1" });
    await pam.associate(session.id, profile.id);

    await pam.dissociate(session.id, { detachSession: true });
    expect(sm.get(session.id)?.metadata.profileId).toBe(DEFAULT_PROFILE_ID);
  });

  it("returns and clears the sessions of a profile", async () => {
    const { sm, pm, pam } = setup();
    const s1 = await createSession(sm, "Session 1");
    const s2 = await createSession(sm, "Session 2");
    const { profile } = await pm.create({ name: "Profile 1" });
    await pam.associate(s1.id, profile.id);
    await pam.associate(s2.id, profile.id);

    expect(pam.getSessionsForProfile(profile.id)).toEqual([s1.id, s2.id]);

    const cleared = await pam.clearAssociationsForProfile(profile.id);
    expect(cleared).toEqual([s1.id, s2.id]);
    expect(pam.getAssociation(s1.id)).toBeUndefined();
    expect(sm.get(s1.id)).toBeDefined();
  });

  it("persists associations and rules across reloads", async () => {
    const { area, sm, pm, pam } = setup();
    const session = await createSession(sm, "Session 1");
    const { profile } = await pm.create({ name: "Profile 1" });
    await pam.associate(session.id, profile.id);
    await pam.addRule({ domain: "example.com", profileId: profile.id, enabled: true });

    expect(area.data.get(PROFILE_ASSOCIATIONS_KEY)).toBeDefined();

    const reloaded = new ProfileAssociationManager(sm, pm, area);
    await reloaded.load();
    expect(reloaded.getAssociation(session.id)).toBe(profile.id);
    expect(reloaded.listRules()).toHaveLength(1);
  });

  it("ignores invalid stored records", async () => {
    const { area, sm, pm } = setup();
    await area.set({
      [PROFILE_ASSOCIATIONS_KEY]: {
        associations: [{ sessionId: 5 }, { sessionId: "s1", profileId: "p1" }],
        rules: [{ domain: "", profileId: "p1" }],
      },
    });
    const pam = new ProfileAssociationManager(sm, pm, area);
    await pam.load();
    expect(pam.listAssociations()).toHaveLength(1);
    expect(pam.listRules()).toHaveLength(0);
  });
});

describe("ProfileAssociationManager — automatic rules", () => {
  it("associates by the most specific matching domain rule", async () => {
    const { sm, pm, pam } = setup();
    const generic = await pm.create({ name: "Generic" });
    const specific = await pm.create({ name: "Specific" });
    await pam.addRule({ domain: "example.com", profileId: generic.profile.id, enabled: true });
    await pam.addRule({ domain: "mail.example.com", profileId: specific.profile.id, enabled: true });

    const session = await createSession(sm, "Mail", "mail.example.com");
    const result = await pam.autoAssociateByDomain(session);
    expect(result?.ok).toBe(true);
    expect(pam.getAssociation(session.id)).toBe(specific.profile.id);
  });

  it("never overrides a manual association", async () => {
    const { sm, pm, pam } = setup();
    const manual = await pm.create({ name: "Manual" });
    const ruleTarget = await pm.create({ name: "Rule" });
    await pam.addRule({ domain: "example.com", profileId: ruleTarget.profile.id, enabled: true });

    const session = await createSession(sm, "Session", "example.com");
    await pam.associate(session.id, manual.profile.id, "manual");

    const result = await pam.autoAssociateByDomain(session);
    expect(result).toBeNull();
    expect(pam.getAssociation(session.id)).toBe(manual.profile.id);
  });

  it("falls back to the default profile when no rule matches", async () => {
    const { sm, pm, pam } = setup();
    const fallback = await pm.create({ name: "Fallback" });
    const session = await createSession(sm, "Session", "unknown.test");

    const result = await pam.autoAssociateByDomain(session, {
      defaultProfileId: fallback.profile.id,
    });
    expect(result?.ok).toBe(true);
    expect(pam.getAssociation(session.id)).toBe(fallback.profile.id);
  });

  it("ignores disabled rules and unavailable profiles", async () => {
    const { sm, pm, pam } = setup();
    const { profile } = await pm.create({ name: "Rule" });
    await pam.addRule({ domain: "example.com", profileId: profile.id, enabled: false });
    await pm.archive(profile.id);

    const session = await createSession(sm, "Session", "example.com");
    expect(await pam.autoAssociateByDomain(session)).toBeNull();
  });

  it("adds, toggles and removes rules", async () => {
    const { pm, pam } = setup();
    const { profile } = await pm.create({ name: "Profile" });

    await pam.addRule({ domain: "https://Example.com/path", profileId: profile.id, enabled: true });
    expect(pam.getRule("example.com")?.profileId).toBe(profile.id);

    expect(await pam.setRuleEnabled("example.com", false)).toBe(true);
    expect(pam.getRule("example.com")?.enabled).toBe(false);

    expect(await pam.removeRule("example.com")).toBe(true);
    expect(await pam.removeRule("example.com")).toBe(false);
    expect(pam.getRule("example.com")).toBeUndefined();
  });

  it("rejects rules with an invalid domain or unknown profile", async () => {
    const { pm, pam } = setup();
    await expect(
      pam.addRule({ domain: "not a domain", profileId: "missing", enabled: true }),
    ).rejects.toThrow(/not found/);

    const { profile } = await pm.create({ name: "Profile" });
    await expect(
      pam.addRule({ domain: "not a domain", profileId: profile.id, enabled: true }),
    ).rejects.toThrow(/valid domain/);
  });

  it("moves every association to another profile", async () => {
    const { sm, pm, pam } = setup();
    const from = await pm.create({ name: "From" });
    const to = await pm.create({ name: "To" });
    const s1 = await createSession(sm, "S1");
    const s2 = await createSession(sm, "S2");
    await pam.associate(s1.id, from.profile.id);
    await pam.associate(s2.id, from.profile.id);

    const results = await pam.reassignAll(from.profile.id, to.profile.id);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(pam.getSessionsForProfile(from.profile.id)).toHaveLength(0);
    expect(pam.getSessionsForProfile(to.profile.id)).toEqual([s1.id, s2.id]);
  });

  it("refuses to move associations into an archived profile", async () => {
    const { pm, pam } = setup();
    const from = await pm.create({ name: "From" });
    const to = await pm.create({ name: "To" });
    await pm.archive(to.profile.id);

    const results = await pam.reassignAll(from.profile.id, to.profile.id);
    expect(results[0]!.ok).toBe(false);
  });
});

describe("domainMatches", () => {
  it("matches exact domains and subdomains only", () => {
    expect(domainMatches("example.com", "example.com")).toBe(true);
    expect(domainMatches("mail.example.com", "example.com")).toBe(true);
    expect(domainMatches("notexample.com", "example.com")).toBe(false);
    expect(domainMatches("example.com", "mail.example.com")).toBe(false);
  });
});
