/**
 * Profile Manager — Profile Deletion (AEGOX_multisession).
 *
 * Deleting a profile never deletes its sessions silently. The caller must
 * choose what happens to them explicitly, and deleting sessions requires a
 * second confirmation flag. This module is the only supported way to remove a
 * profile together with session handling.
 *
 * Pure TypeScript: works through the Profile, Association and Session managers.
 *
 * Derived from SplitSession's delete-confirmation pattern
 * (https://github.com/Misyuk-T/splitsession, MIT License).
 */

import type { Session, SessionId } from "../../core/session-manager/session";
import type { SessionManager } from "../../core/session-manager/session-manager";
import type { ProfileId } from "../profile-manager/profile";
import type { ProfileManager } from "../profile-manager/profile-manager";
import type { ProfileAssociationManager } from "../profile-association/association";
import type { WebsiteRulesManager } from "../profile-rules/website-rules";
import type { ProfileStatsManager } from "../profile-stats/stats";

/** What the user chose to do with the profile's sessions. */
export type SessionDisposition =
  | { action: "keep" }
  | { action: "reassign"; toProfileId: ProfileId }
  | { action: "delete"; confirmed: boolean };

/** Request to delete one profile. */
export interface DeleteProfileRequest {
  profileId: ProfileId;
  /** Required; there is no implicit default. */
  sessions: SessionDisposition;
}

/** Result of a deletion attempt. */
export interface DeleteProfileResult {
  ok: boolean;
  /** Sessions that were associated with the profile. */
  affectedSessions: SessionId[];
  /** Sessions kept in Session Core (moved to the default profile). */
  keptSessions: SessionId[];
  /** Sessions whose `profileId` was moved to another profile. */
  reassignedSessions: SessionId[];
  /** Sessions deleted after explicit confirmation. */
  deletedSessions: SessionId[];
  /** Reason when `ok` is false. */
  reason?: string;
}

/** What the confirmation dialog needs to show before deleting. */
export interface DeletionImpact {
  profileId: ProfileId;
  profileName: string;
  sessionCount: number;
  sessions: Array<{ id: SessionId; name: string; domain: string | null }>;
  /** True when the profile has independent protection (a vault is not deleted). */
  hasIndependentPassword: boolean;
}

/**
 * Describes what deleting this profile would affect. Use it to populate the
 * confirmation dialog before calling `deleteProfileWithSessions`.
 */
export function describeDeletionImpact(
  profileId: ProfileId,
  profileManager: ProfileManager,
  associationManager: ProfileAssociationManager,
  sessionManager: SessionManager,
): DeletionImpact {
  const profile = profileManager.get(profileId);
  if (!profile) throw new Error(`Profile "${profileId}" not found.`);

  const sessions = associationManager
    .getSessionsForProfile(profileId)
    .map((sessionId) => sessionManager.get(sessionId))
    .filter((session): session is Session => session !== undefined)
    .map((session) => ({
      id: session.id,
      name: session.metadata.name,
      domain: session.metadata.domain,
    }));

  return {
    profileId,
    profileName: profile.metadata.name,
    sessionCount: sessions.length,
    sessions,
    hasIndependentPassword: profile.hasIndependentPassword,
  };
}

/**
 * Deletes a profile after applying the user's explicit session disposition.
 *
 * Order of operations:
 * 1. Validate the request (including the second confirmation for deletion).
 * 2. Handle sessions (reassign, detach, delete after confirmation, or keep).
 * 3. Delete the profile record.
 * 4. Remove its website rules and local statistics.
 *
 * If step 1 fails nothing changes. An error in step 2 aborts before the profile
 * is removed, so the user can retry instead of losing the reference.
 */
export async function deleteProfileWithSessions(
  dependencies: {
    profileManager: ProfileManager;
    associationManager: ProfileAssociationManager;
    sessionManager: SessionManager;
    websiteRules?: WebsiteRulesManager;
    stats?: ProfileStatsManager;
  },
  request: DeleteProfileRequest,
): Promise<DeleteProfileResult> {
  const { profileManager, associationManager, sessionManager } = dependencies;
  const { profileId, sessions } = request;

  const profile = profileManager.get(profileId);
  if (!profile) {
    return {
      ok: false,
      affectedSessions: [],
      reassignedSessions: [],
      keptSessions: [],
      deletedSessions: [],
      reason: `Profile "${profileId}" not found.`,
    };
  }

  const affectedSessions = associationManager.getSessionsForProfile(profileId);

  if (sessions.action === "delete" && sessions.confirmed !== true) {
    return {
      ok: false,
      affectedSessions,
      reassignedSessions: [],
      keptSessions: [],
      deletedSessions: [],
      reason:
        "Deleting the profile's sessions requires explicit confirmation. Nothing was changed.",
    };
  }

  if (sessions.action === "reassign") {
    if (sessions.toProfileId === profileId) {
      return {
        ok: false,
        affectedSessions,
        reassignedSessions: [],
        keptSessions: [],
        deletedSessions: [],
        reason: "Choose a different profile to receive the sessions.",
      };
    }
    const target = profileManager.get(sessions.toProfileId);
    if (!target) {
      return {
        ok: false,
        affectedSessions,
        reassignedSessions: [],
        keptSessions: [],
        deletedSessions: [],
        reason: `Profile "${sessions.toProfileId}" not found.`,
      };
    }
    if (target.state !== "active" && target.state !== "temporary") {
      return {
        ok: false,
        affectedSessions,
        reassignedSessions: [],
        keptSessions: [],
        deletedSessions: [],
        reason: `Profile "${target.metadata.name}" is ${target.state} and cannot receive sessions.`,
      };
    }
  }

  const reassignedSessions: SessionId[] = [];
  const keptSessions: SessionId[] = [];
  const deletedSessions: SessionId[] = [];

  switch (sessions.action) {
    case "keep": {
      // The sessions stay in Session Core. Their association record is removed
      // and their profile reference returns to the default profile, so nothing
      // points at a profile that no longer exists.
      keptSessions.push(
        ...(await associationManager.clearAssociationsForProfile(profileId, {
          detachSessions: true,
        })),
      );
      break;
    }
    case "reassign": {
      const results = await associationManager.reassignAll(
        profileId,
        sessions.toProfileId,
      );
      for (const result of results) {
        if (!result.ok) {
          return {
            ok: false,
            affectedSessions,
            reassignedSessions,
            keptSessions,
            deletedSessions,
            reason: result.reason ?? "Could not reassign every session.",
          };
        }
        if (result.session) reassignedSessions.push(result.session.id);
      }
      break;
    }
    case "delete": {
      for (const sessionId of affectedSessions) {
        if (await sessionManager.delete(sessionId)) deletedSessions.push(sessionId);
      }
      await associationManager.clearAssociationsForProfile(profileId);
      break;
    }
  }

  const deleted = await profileManager.delete(profileId);
  if (!deleted) {
    return {
      ok: false,
      affectedSessions,
      reassignedSessions,
      keptSessions,
      deletedSessions,
      reason: `Profile "${profileId}" disappeared before it could be deleted.`,
    };
  }

  await dependencies.websiteRules?.clearForProfile(profileId);
  dependencies.stats?.forget(profileId);

  return {
    ok: true,
    affectedSessions,
    reassignedSessions,
    keptSessions,
    deletedSessions,
  };
}
