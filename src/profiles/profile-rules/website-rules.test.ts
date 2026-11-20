/**
 * Unit tests for `src/profiles/profile-rules/website-rules.ts`.
 * Uses MemoryStorageArea (no real browser APIs required).
 */

import { describe, expect, it } from "vitest";

import { MemoryStorageArea } from "../../engine/storage/storage-area";
import {
  PROFILE_WEBSITE_RULES_KEY,
  WebsiteRulesManager,
  extractDomain,
} from "./website-rules";

const setup = async () => {
  const area = new MemoryStorageArea();
  const mgr = new WebsiteRulesManager(area, { now: () => 1000 });
  await mgr.load();
  return { area, mgr };
};

describe("WebsiteRulesManager — CRUD", () => {
  it("adds and retrieves rules per profile", async () => {
    const { mgr } = await setup();
    const rule = await mgr.addRule("profile-1", {
      domain: "https://Example.com/path",
      action: "block",
    });
    expect(rule.domain).toBe("example.com");
    expect(rule.enabled).toBe(true);
    expect(rule.createdAt).toBe(1000);

    expect(mgr.getRules("profile-1")).toHaveLength(1);
    expect(mgr.getRules("profile-2")).toHaveLength(0);
  });

  it("replaces a rule for the same domain", async () => {
    const { mgr } = await setup();
    await mgr.addRule("profile-1", { domain: "example.com", action: "block" });
    await mgr.addRule("profile-1", { domain: "example.com", action: "allow" });

    const rules = mgr.getRules("profile-1");
    expect(rules).toHaveLength(1);
    expect(rules[0]!.action).toBe("allow");
  });

  it("rejects invalid domains and enforces the cap", async () => {
    const { mgr } = await setup();
    await expect(
      mgr.addRule("profile-1", { domain: "not a domain", action: "block" }),
    ).rejects.toThrow(/valid domain/);
  });

  it("enables, disables and removes rules", async () => {
    const { mgr } = await setup();
    await mgr.addRule("profile-1", { domain: "example.com", action: "block" });

    expect(await mgr.setRuleEnabled("profile-1", "example.com", false)).toBe(true);
    expect(mgr.getEnabledRules("profile-1")).toHaveLength(0);
    expect(await mgr.setRuleEnabled("profile-1", "missing.com", false)).toBe(false);

    expect(await mgr.removeRule("profile-1", "example.com")).toBe(true);
    expect(await mgr.removeRule("profile-1", "example.com")).toBe(false);
  });

  it("clears every rule for a profile", async () => {
    const { mgr } = await setup();
    await mgr.addRule("profile-1", { domain: "a.com", action: "block" });
    await mgr.addRule("profile-2", { domain: "b.com", action: "block" });

    await mgr.clearForProfile("profile-1");
    expect(mgr.getRules("profile-1")).toHaveLength(0);
    expect(mgr.getRules("profile-2")).toHaveLength(1);
  });

  it("persists and reloads rules", async () => {
    const { area, mgr } = await setup();
    await mgr.addRule("profile-1", { domain: "example.com", action: "block" });
    expect(area.data.get(PROFILE_WEBSITE_RULES_KEY)).toBeDefined();

    const reloaded = new WebsiteRulesManager(area);
    await reloaded.load();
    expect(reloaded.getRules("profile-1")).toHaveLength(1);
  });

  it("drops invalid stored rules", async () => {
    const { area } = await setup();
    await area.set({
      [PROFILE_WEBSITE_RULES_KEY]: {
        "profile-1": [
          { domain: "example.com", action: "block" },
          { domain: "", action: "block" },
          { domain: "ok.com", action: "explode" },
        ],
      },
    });
    const mgr = new WebsiteRulesManager(area);
    await mgr.load();
    expect(mgr.getRules("profile-1")).toHaveLength(1);
  });

  it("reports which profiles have a rule for a domain", async () => {
    const { mgr } = await setup();
    await mgr.addRule("profile-1", { domain: "example.com", action: "block" });
    await mgr.addRule("profile-2", { domain: "other.com", action: "block" });
    expect(mgr.getProfilesWithRule("https://example.com")).toEqual(["profile-1"]);
  });
});

describe("WebsiteRulesManager — evaluation", () => {
  it("blocks a matching website and its subdomains", async () => {
    const { mgr } = await setup();
    await mgr.addRule("profile-1", { domain: "example.com", action: "block" });

    expect(mgr.checkWebsite("profile-1", "https://example.com/page").allowed).toBe(false);
    expect(mgr.checkWebsite("profile-1", "https://sub.example.com").allowed).toBe(false);
    expect(mgr.checkWebsite("profile-1", "https://notexample.com").allowed).toBe(true);
  });

  it("allows everything in blocklist mode when no rule matches", async () => {
    const { mgr } = await setup();
    const check = mgr.checkWebsite("profile-1", "https://other.com");
    expect(check.allowed).toBe(true);
    expect(check.rule).toBeUndefined();
  });

  it("blocks everything in allowlist mode without a matching allow rule", async () => {
    const { mgr } = await setup();
    await mgr.addRule("profile-1", { domain: "example.com", action: "allow" });

    expect(mgr.checkWebsite("profile-1", "https://example.com", "allowlist").allowed).toBe(true);
    const blocked = mgr.checkWebsite("profile-1", "https://other.com", "allowlist");
    expect(blocked.allowed).toBe(false);
    expect(blocked.warning).toContain("not in this profile's allowed websites");
  });

  it("lets the most specific rule win", async () => {
    const { mgr } = await setup();
    await mgr.addRule("profile-1", { domain: "example.com", action: "allow" });
    await mgr.addRule("profile-1", { domain: "mail.example.com", action: "block" });

    expect(mgr.checkWebsite("profile-1", "https://www.example.com").allowed).toBe(true);
    expect(mgr.checkWebsite("profile-1", "https://mail.example.com").allowed).toBe(false);
  });

  it("lets block win a tie on the same domain", async () => {
    const { mgr } = await setup();
    await mgr.setRules("profile-1", [
      { domain: "example.com", action: "allow", enabled: true, createdAt: 1 },
      { domain: "example.com", action: "block", enabled: true, createdAt: 2 },
    ]);
    expect(mgr.checkWebsite("profile-1", "https://example.com").allowed).toBe(false);
  });

  it("ignores disabled rules", async () => {
    const { mgr } = await setup();
    await mgr.addRule("profile-1", {
      domain: "example.com",
      action: "block",
      enabled: false,
    });
    expect(mgr.checkWebsite("profile-1", "https://example.com").allowed).toBe(true);
  });

  it("rejects invalid website addresses with a warning", async () => {
    const { mgr } = await setup();
    const check = mgr.checkWebsite("profile-1", "not a url");
    expect(check.allowed).toBe(false);
    expect(check.warning).toContain("not a valid website address");
  });
});

describe("extractDomain", () => {
  it("extracts hosts from URLs and bare hosts", () => {
    expect(extractDomain("https://Sub.Example.com:8080/path")).toBe("sub.example.com");
    expect(extractDomain("Example.com")).toBe("example.com");
  });

  it("rejects empty, invalid and credential-bearing input", () => {
    expect(extractDomain("")).toBeNull();
    expect(extractDomain("not a url")).toBeNull();
    expect(extractDomain("https://user:pass@example.com")).toBeNull();
  });
});
