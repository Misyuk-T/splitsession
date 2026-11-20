/**
 * Profile Manager — Website Rules (AEGOX_multisession).
 *
 * Allowed and blocked website lists per profile. These are organizational
 * guardrails, not a security boundary: they are evaluated by the extension's
 * UI/navigation code and never claim isolation beyond the browser APIs.
 *
 * Pure TypeScript: persistence is delegated to a provided `StorageAreaLike`.
 *
 * Derived from SplitSession's domain-rules pattern
 * (https://github.com/Misyuk-T/splitsession, MIT License).
 */

import type { StorageAreaLike } from "../../engine/storage/storage-area";
import { MAX_WEBSITE_RULES } from "../profile-manager/profile";
import type { ProfileId, WebsiteRule } from "../profile-manager/profile";
import { normalizeRuleDomain } from "../profile-manager/profile-manager";

export type { WebsiteRule };

/** Type of website rule. */
export type WebsiteRuleAction = "allow" | "block";

/** How the list is interpreted. Mirrors `ProfileSettings.websiteMode`. */
export type WebsiteMode = "blocklist" | "allowlist";

/** Result of checking a website against a profile's rules. */
export interface WebsiteCheck {
  /** The host that was checked. */
  domain: string;
  /** Whether the website is allowed for this profile. */
  allowed: boolean;
  /** The matching rule, if any. */
  rule?: WebsiteRule;
  /** Warning message to show the user, if restricted. */
  warning?: string;
}

/** `chrome.storage.local` key holding all profiles' rules. */
export const PROFILE_WEBSITE_RULES_KEY = "profileWebsiteRules";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeRule(value: unknown): WebsiteRule | null {
  if (!isRecord(value)) return null;
  if (typeof value.domain !== "string") return null;
  const domain = normalizeRuleDomain(value.domain);
  if (!domain) return null;
  if (value.action !== "allow" && value.action !== "block") return null;
  return {
    domain,
    action: value.action,
    enabled: value.enabled !== false,
    createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
  };
}

/**
 * Manages website restriction rules per profile. Rules are stored in one map
 * so a write is atomic and no partial per-profile state can be left behind.
 */
export class WebsiteRulesManager {
  private rules = new Map<ProfileId, WebsiteRule[]>();
  private writing: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  constructor(
    private readonly area: StorageAreaLike,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  /** Loads every profile's rules from storage. Invalid entries are dropped. */
  async load(): Promise<void> {
    const stored = (await this.area.get(PROFILE_WEBSITE_RULES_KEY))[
      PROFILE_WEBSITE_RULES_KEY
    ];
    this.rules = new Map();
    if (!isRecord(stored)) return;
    for (const [profileId, value] of Object.entries(stored)) {
      if (!Array.isArray(value)) continue;
      const rules: WebsiteRule[] = [];
      for (const item of value.slice(0, MAX_WEBSITE_RULES)) {
        const rule = normalizeRule(item);
        if (rule) rules.push(rule);
      }
      this.rules.set(profileId, rules);
    }
  }

  /** Returns all rules for a profile (copies). */
  getRules(profileId: ProfileId): WebsiteRule[] {
    return (this.rules.get(profileId) ?? []).map((rule) => ({ ...rule }));
  }

  /** Returns enabled rules for a profile. */
  getEnabledRules(profileId: ProfileId): WebsiteRule[] {
    return this.getRules(profileId).filter((rule) => rule.enabled);
  }

  /** Replaces all rules for a profile. */
  async setRules(profileId: ProfileId, rules: WebsiteRule[]): Promise<void> {
    this.rules.set(
      profileId,
      rules.slice(0, MAX_WEBSITE_RULES).map((rule) => ({ ...rule })),
    );
    await this.persist();
  }

  /** Adds or updates one rule (same domain replaces the previous rule). */
  async addRule(
    profileId: ProfileId,
    rule: { domain: string; action: WebsiteRuleAction; enabled?: boolean },
  ): Promise<WebsiteRule> {
    const domain = normalizeRuleDomain(rule.domain);
    if (!domain) {
      throw new Error("Enter a valid domain, for example example.com.");
    }
    const existing = this.rules.get(profileId) ?? [];
    if (
      existing.length >= MAX_WEBSITE_RULES &&
      !existing.some((item) => item.domain === domain)
    ) {
      throw new Error(`At most ${MAX_WEBSITE_RULES} rules per profile.`);
    }
    const record: WebsiteRule = {
      domain,
      action: rule.action,
      enabled: rule.enabled !== false,
      createdAt: this.now(),
    };
    this.rules.set(profileId, [
      ...existing.filter((item) => item.domain !== domain),
      record,
    ]);
    await this.persist();
    return { ...record };
  }

  /** Removes a rule by domain. */
  async removeRule(profileId: ProfileId, domain: string): Promise<boolean> {
    const normalized = normalizeRuleDomain(domain);
    if (!normalized) return false;
    const existing = this.rules.get(profileId) ?? [];
    const filtered = existing.filter((rule) => rule.domain !== normalized);
    if (filtered.length === existing.length) return false;
    this.rules.set(profileId, filtered);
    await this.persist();
    return true;
  }

  /** Enables or disables a rule. */
  async setRuleEnabled(
    profileId: ProfileId,
    domain: string,
    enabled: boolean,
  ): Promise<boolean> {
    const normalized = normalizeRuleDomain(domain);
    if (!normalized) return false;
    const existing = this.rules.get(profileId) ?? [];
    const rule = existing.find((item) => item.domain === normalized);
    if (!rule) return false;
    rule.enabled = enabled;
    this.rules.set(profileId, existing);
    await this.persist();
    return true;
  }

  /**
   * Checks whether a website is allowed for a profile.
   *
   * - The most specific (longest) matching domain wins.
   * - On a tie, `block` wins.
   * - In `allowlist` mode a site with no matching `allow` rule is blocked.
   * - In `blocklist` mode a site with no matching rule is allowed.
   */
  checkWebsite(
    profileId: ProfileId,
    urlOrDomain: string,
    mode: WebsiteMode = "blocklist",
  ): WebsiteCheck {
    const domain = extractDomain(urlOrDomain);
    if (!domain) {
      return {
        domain: urlOrDomain,
        allowed: false,
        warning: `“${urlOrDomain}” is not a valid website address.`,
      };
    }

    const matching = this.getEnabledRules(profileId)
      .filter((rule) => domainMatches(domain, rule.domain))
      .sort((a, b) => {
        if (b.domain.length !== a.domain.length) {
          return b.domain.length - a.domain.length;
        }
        return a.action === "block" ? -1 : b.action === "block" ? 1 : 0;
      });

    const best = matching[0];
    if (best?.action === "block") {
      return {
        domain,
        allowed: false,
        rule: best,
        warning: `“${domain}” is blocked for this profile.`,
      };
    }

    if (mode === "allowlist") {
      if (best?.action === "allow") {
        return { domain, allowed: true, rule: best };
      }
      return {
        domain,
        allowed: false,
        warning: `“${domain}” is not in this profile's allowed websites.`,
      };
    }

    return { domain, allowed: true, ...(best ? { rule: best } : {}) };
  }

  /** Returns all profiles that have an exact rule for a domain. */
  getProfilesWithRule(domain: string): ProfileId[] {
    const normalized = normalizeRuleDomain(domain);
    if (!normalized) return [];
    const result: ProfileId[] = [];
    for (const [profileId, rules] of this.rules) {
      if (rules.some((rule) => rule.domain === normalized)) result.push(profileId);
    }
    return result;
  }

  /** Removes every rule for a profile (used when the profile is deleted). */
  async clearForProfile(profileId: ProfileId): Promise<void> {
    if (!this.rules.delete(profileId)) return;
    await this.persist();
  }

  private persist(): Promise<void> {
    const data: Record<string, WebsiteRule[]> = {};
    for (const [profileId, rules] of this.rules) {
      data[profileId] = rules.map((rule) => ({ ...rule }));
    }
    this.writing = this.writing
      .then(() => this.area.set({ [PROFILE_WEBSITE_RULES_KEY]: data }))
      .catch(() => {});
    return this.writing;
  }
}

/** Extracts the host from a URL or accepts a bare host. Returns null if invalid. */
export function extractDomain(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === "") return null;
  try {
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
      ? new URL(trimmed)
      : new URL(`http://${trimmed}`);
    if (url.username !== "" || url.password !== "") return null;
    const host = url.hostname.toLowerCase();
    return host === "" ? null : host;
  } catch {
    return null;
  }
}

/** True when `domain` equals `ruleDomain` or is a subdomain of it. */
export function domainMatches(domain: string, ruleDomain: string): boolean {
  const d = domain.toLowerCase();
  const r = ruleDomain.toLowerCase();
  return d === r || d.endsWith(`.${r}`);
}
