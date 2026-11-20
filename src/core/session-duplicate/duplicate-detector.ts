/**
 * Session Core — Duplicate Detection (AEGOX_multisession).
 *
 * Detects duplicate session configurations using stable metadata (domain + profile).
 * Never merges or deletes sessions automatically; user data is always preserved.
 *
 * Pure TypeScript: no `chrome.*` references.
 *
 * Derived from SplitSession's container name and copy detection patterns
 * (https://github.com/Misyuk-T/splitsession, MIT License).
 */

import type { Session, SessionId } from "../session-manager/session";

/** Result of a duplicate check. */
export interface DuplicateCheck {
  /** True if a potential duplicate was found. */
  isDuplicate: boolean;
  /** The existing session that matches, if any. */
  existing?: Session;
  /** Reason for the duplicate determination. */
  reason?: string;
}

/** A duplicate group: sessions that share domain + profile. */
export interface DuplicateGroup {
  /** Key identifying the group: "domain|profileId" or "domain|null". */
  key: string;
  /** Sessions in this group. */
  sessions: Session[];
}

/** Computes the stable duplicate key for a session: domain + profile. */
export function duplicateKey(session: Session): string {
  const domain = session.metadata.domain ?? "<no-domain>";
  const profile = session.metadata.profileId ?? "<no-profile>";
  return `${domain.toLowerCase()}|${profile}`;
}

/**
 * Checks whether a candidate session duplicates any existing session
 * by domain + profile association (not by name).
 */
export function checkDuplicate(
  candidate: Session,
  existing: readonly Session[],
): DuplicateCheck {
  const key = duplicateKey(candidate);
  for (const s of existing) {
    if (s.id === candidate.id) continue;
    if (duplicateKey(s) === key) {
      return {
        isDuplicate: true,
        existing: s,
        reason: `A session for "${candidate.metadata.domain ?? "<no domain>"}" in profile "${
          candidate.metadata.profileId ?? "<default>"
        }" already exists ("${s.metadata.name}").`,
      };
    }
  }
  return { isDuplicate: false };
}

/**
 * Groups sessions by duplicate key. Sessions with no domain are grouped
 * under their profile only; sessions with no profile are grouped under
 * their domain only.
 */
export function findDuplicateGroups(sessions: readonly Session[]): DuplicateGroup[] {
  const groups = new Map<string, Session[]>();
  for (const s of sessions) {
    const key = duplicateKey(s);
    const list = groups.get(key) ?? [];
    list.push(s);
    groups.set(key, list);
  }
  const out: DuplicateGroup[] = [];
  for (const [key, list] of groups) {
    if (list.length > 1) {
      out.push({ key, sessions: [...list] });
    }
  }
  return out;
}

/** Returns all sessions that are part of at least one duplicate group. */
export function findDuplicateSessions(sessions: readonly Session[]): Session[] {
  const groups = findDuplicateGroups(sessions);
  const seen = new Set<SessionId>();
  const out: Session[] = [];
  for (const g of groups) {
    for (const s of g.sessions) {
      if (!seen.has(s.id)) {
        seen.add(s.id);
        out.push(s);
      }
    }
  }
  return out;
}

/** Validates that a new session would not create an unwanted duplicate. */
export function validateNoUnwantedDuplicate(
  candidate: Session,
  existing: readonly Session[],
  allowDuplicates: boolean,
): DuplicateCheck {
  const check = checkDuplicate(candidate, existing);
  if (check.isDuplicate && !allowDuplicates) {
    return {
      ...check,
      reason: check.reason ?? "Duplicate session detected.",
    };
  }
  return check;
}
