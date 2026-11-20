/**
 * Profile Manager — Profile-Session Association (AEGOX_multisession).
 *
 * Associates sessions with profiles through Session Core (Module 02).
 * Several sessions of the same website can live in different profiles; the
 * profile only records the association. Whether those sessions are actually
 * isolated is decided by the browser adapter (Module 02), never simulated here.
 *
 * Pure TypeScript: delegates session operations to `SessionManager` and profile
 * lookups to `ProfileManager`.
 *
 * Derived from SplitSession's domain-rule and assignment patterns
 * (https://github.com/Misyuk-T/splitsession, MIT License).
 */

import type { StorageAreaLike } from "../../engine/storage/storage-area";
import { DEFAULT_PROFILE_ID } from "../../core/session-manager/session";
import type { Session, SessionId } from "../../core/session-manager/session";
import type { SessionManager } from "../../core/session-manager/session-manager";
import type { Profile, ProfileId } from "../profile-manager/profile";
import type { ProfileManager } from "../profile-manager/profile-manager";
import { normalizeRuleDomain } from "../profile-manager/profile-manager";

/** Storage key for associations and domain rules. */
export const PROFILE_ASSOCIATIONS_KEY = "profileAssociations";

/** How a session is associated with a profile. */
export type AssociationMode = "automatic" | "manual";

/** A rule that associates sessions with a profile based on domain. */
export interface ProfileAssociationRule {
  /** Registrable domain or exact host, lowercase. */
  domain: string;
  /** Profile that sessions on this domain should associate with. */
  profileId: ProfileId;
  /** Whether the rule is active. */
  enabled: boolean;
  /** When the rule was created (epoch ms). */
  createdAt: number;
}

/** Persisted association record. */
export interface SessionAssociation {
  sessionId: SessionId;
  profileId: ProfileId;
  mode: AssociationMode;
  associatedAt: number;
}

/** Result of associating a session with a profile. */
export interface AssociationResult {
  ok: boolean;
  /** The session after the change (copy), or undefined if not applied. */
  session?: Session;
  /** Reason if the association could not be applied. */
  reason?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Manages associations between sessions and profiles.
 * Manual associations take precedence over automatic domain rules.
 */
export class ProfileAssociationManager {
  private associations = new Map<SessionId, SessionAssociation>();
  private rules = new Map<string, ProfileAssociationRule>();
  private writing: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly profileManager: ProfileManager,
    private readonly area: StorageAreaLike,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  /** Loads associations and rules from storage. Invalid entries are dropped. */
  async load(): Promise<void> {
    const stored = (await this.area.get(PROFILE_ASSOCIATIONS_KEY))[
      PROFILE_ASSOCIATIONS_KEY
    ];
    this.associations = new Map();
    this.rules = new Map();
    if (!isRecord(stored)) return;

    if (Array.isArray(stored.associations)) {
      for (const item of stored.associations) {
        if (!isRecord(item)) continue;
        if (
          typeof item.sessionId !== "string" ||
          typeof item.profileId !== "string"
        ) {
          continue;
        }
        this.associations.set(item.sessionId, {
          sessionId: item.sessionId,
          profileId: item.profileId,
          mode: item.mode === "automatic" ? "automatic" : "manual",
          associatedAt:
            typeof item.associatedAt === "number" ? item.associatedAt : 0,
        });
      }
    }

    if (Array.isArray(stored.rules)) {
      for (const item of stored.rules) {
        if (!isRecord(item)) continue;
        if (typeof item.domain !== "string" || typeof item.profileId !== "string") {
          continue;
        }
        const domain = normalizeRuleDomain(item.domain);
        if (!domain) continue;
        this.rules.set(domain, {
          domain,
          profileId: item.profileId,
          enabled: item.enabled !== false,
          createdAt: typeof item.createdAt === "number" ? item.createdAt : 0,
        });
      }
    }
  }

  /** Returns all current associations (copies). */
  listAssociations(): SessionAssociation[] {
    return [...this.associations.values()].map((a) => ({ ...a }));
  }

  /** Returns the profile ID associated with a session, or undefined. */
  getAssociation(sessionId: SessionId): ProfileId | undefined {
    return this.associations.get(sessionId)?.profileId;
  }

  /** Returns the association record for a session, or undefined. */
  getAssociationRecord(sessionId: SessionId): SessionAssociation | undefined {
    const found = this.associations.get(sessionId);
    return found ? { ...found } : undefined;
  }

  /** Returns the session IDs associated with a profile. */
  getSessionsForProfile(profileId: ProfileId): SessionId[] {
    return [...this.associations.values()]
      .filter((a) => a.profileId === profileId)
      .map((a) => a.sessionId);
  }

  /**
   * Associates a session with a profile and mirrors the association into
   * `SessionMetadata.profileId` (Session Core remains the source of session data).
   */
  async associate(
    sessionId: SessionId,
    profileId: ProfileId,
    mode: AssociationMode = "manual",
  ): Promise<AssociationResult> {
    const session = this.sessionManager.get(sessionId);
    if (!session) {
      return { ok: false, reason: `Session "${sessionId}" not found.` };
    }
    const profile = this.profileManager.get(profileId);
    if (!profile) {
      return { ok: false, reason: `Profile "${profileId}" not found.` };
    }
    if (profile.state === "archived" || profile.state === "deleted") {
      return {
        ok: false,
        reason: `Profile "${profileId}" is ${profile.state} and cannot receive sessions.`,
      };
    }

    try {
      const updated = await this.sessionManager.update(sessionId, { profileId });
      this.associations.set(sessionId, {
        sessionId,
        profileId,
        mode,
        associatedAt: this.now(),
      });
      await this.persist();
      return { ok: true, session: updated };
    } catch (error) {
      return {
        ok: false,
        reason: `Could not update the session: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  /** Reassigns a session to another profile. */
  async reassign(
    sessionId: SessionId,
    newProfileId: ProfileId,
  ): Promise<AssociationResult> {
    if (!this.associations.has(sessionId)) {
      return { ok: false, reason: `Session "${sessionId}" has no association.` };
    }
    return this.associate(sessionId, newProfileId, "manual");
  }

  /**
   * Removes the association. The session keeps existing unless `detachSession`
   * is true, in which case its `profileId` returns to the default profile.
   */
  async dissociate(
    sessionId: SessionId,
    options: { detachSession?: boolean } = {},
  ): Promise<boolean> {
    const existed = this.associations.delete(sessionId);
    if (existed) await this.persist();
    if (options.detachSession && this.sessionManager.get(sessionId)) {
      await this.sessionManager.update(sessionId, {
        profileId: DEFAULT_PROFILE_ID,
      });
    }
    return existed;
  }

  /**
   * Automatically associates a session with a profile based on domain rules.
   * Manual associations are never overwritten. Returns null when no rule matches.
   */
  async autoAssociateByDomain(
    session: Session,
    options: { defaultProfileId?: ProfileId | null } = {},
  ): Promise<AssociationResult | null> {
    const existing = this.associations.get(session.id);
    if (existing?.mode === "manual") return null;

    const domain = session.metadata.domain;
    if (domain) {
      const matching = [...this.rules.values()]
        .filter((rule) => rule.enabled && domainMatches(domain, rule.domain))
        .sort((a, b) => b.domain.length - a.domain.length);

      for (const rule of matching) {
        const profile = this.profileManager.get(rule.profileId);
        if (!profile || !receivesSessions(profile)) continue;
        return this.associate(session.id, rule.profileId, "automatic");
      }
    }

    if (options.defaultProfileId) {
      const profile = this.profileManager.get(options.defaultProfileId);
      if (profile && receivesSessions(profile)) {
        return this.associate(session.id, profile.id, "automatic");
      }
    }
    return null;
  }

  /** Adds or updates a domain association rule. */
  async addRule(
    rule: Omit<ProfileAssociationRule, "createdAt" | "domain"> & {
      domain: string;
    },
  ): Promise<ProfileAssociationRule> {
    const profile = this.profileManager.get(rule.profileId);
    if (!profile) throw new Error(`Profile "${rule.profileId}" not found.`);
    const domain = normalizeRuleDomain(rule.domain);
    if (!domain) throw new Error("Enter a valid domain, for example example.com.");

    const record: ProfileAssociationRule = {
      domain,
      profileId: rule.profileId,
      enabled: rule.enabled,
      createdAt: this.now(),
    };
    this.rules.set(domain, record);
    await this.persist();
    return { ...record };
  }

  /** Removes a domain association rule. */
  async removeRule(domain: string): Promise<boolean> {
    const normalized = normalizeRuleDomain(domain);
    if (!normalized) return false;
    if (!this.rules.delete(normalized)) return false;
    await this.persist();
    return true;
  }

  /** Enables or disables a rule. */
  async setRuleEnabled(domain: string, enabled: boolean): Promise<boolean> {
    const normalized = normalizeRuleDomain(domain);
    if (!normalized) return false;
    const rule = this.rules.get(normalized);
    if (!rule) return false;
    rule.enabled = enabled;
    await this.persist();
    return true;
  }

  /** Returns all association rules (copies). */
  listRules(): ProfileAssociationRule[] {
    return [...this.rules.values()].map((rule) => ({ ...rule }));
  }

  /** Returns the rule for a domain, if any. */
  getRule(domain: string): ProfileAssociationRule | undefined {
    const normalized = normalizeRuleDomain(domain);
    if (!normalized) return undefined;
    const found = this.rules.get(normalized);
    return found ? { ...found } : undefined;
  }

  /**
   * Moves every association of one profile to another. Used by the deletion
   * flow when the user chooses “reassign”.
   */
  async reassignAll(
    fromProfileId: ProfileId,
    toProfileId: ProfileId,
  ): Promise<AssociationResult[]> {
    const target = this.profileManager.get(toProfileId);
    if (!target || !receivesSessions(target)) {
      return [
        {
          ok: false,
          reason: `Profile "${toProfileId}" cannot receive sessions.`,
        },
      ];
    }
    const sessionIds = this.getSessionsForProfile(fromProfileId);
    const results: AssociationResult[] = [];
    for (const sessionId of sessionIds) {
      results.push(await this.associate(sessionId, toProfileId, "manual"));
    }
    return results;
  }

  /**
   * Clears every association for a profile and returns the affected session IDs.
   * Sessions are not deleted. With `detachSessions`, they return to the default
   * profile in Session Core as well.
   */
  async clearAssociationsForProfile(
    profileId: ProfileId,
    options: { detachSessions?: boolean } = {},
  ): Promise<SessionId[]> {
    const affected: SessionId[] = [];
    for (const [sessionId, association] of this.associations) {
      if (association.profileId === profileId) {
        affected.push(sessionId);
        this.associations.delete(sessionId);
      }
    }
    if (affected.length > 0) await this.persist();

    if (options.detachSessions) {
      for (const sessionId of affected) {
        if (this.sessionManager.get(sessionId)) {
          await this.sessionManager.update(sessionId, {
            profileId: DEFAULT_PROFILE_ID,
          });
        }
      }
    }
    return affected;
  }

  /** Clears all associations (rules are kept). */
  async clearAll(): Promise<void> {
    this.associations.clear();
    await this.persist();
  }

  private persist(): Promise<void> {
    const data = {
      associations: [...this.associations.values()].map((a) => ({ ...a })),
      rules: [...this.rules.values()].map((r) => ({ ...r })),
    };
    this.writing = this.writing
      .then(() => this.area.set({ [PROFILE_ASSOCIATIONS_KEY]: data }))
      .catch(() => {});
    return this.writing;
  }
}

/** A profile only receives sessions while it is active or temporary. */
function receivesSessions(profile: Profile): boolean {
  return profile.state === "active" || profile.state === "temporary";
}

/** True when `domain` equals `ruleDomain` or is a subdomain of it. */
export function domainMatches(domain: string, ruleDomain: string): boolean {
  const d = domain.toLowerCase();
  const r = ruleDomain.toLowerCase();
  return d === r || d.endsWith(`.${r}`);
}
