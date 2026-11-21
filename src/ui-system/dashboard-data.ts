/**
 * Dashboard aggregation (AEGOX_multisession, Module 04).
 *
 * Reads the public entities returned by Session Core and Profile Manager and
 * computes overview numbers, warnings, favorites and recent activity. Every
 * value is derived from stored fields; nothing is invented and no statistics
 * are estimated.
 */

import type { Session, SessionState } from "../core/session-manager/session";
import type { Profile } from "../profiles/profile-manager/profile";
import type { AggregateStats } from "../profiles/profile-stats/stats";

export interface SessionTotals extends Record<SessionState, number> {
  total: number;
}

export interface ProfileTotals {
  total: number;
  active: number;
  archived: number;
  temporary: number;
  deleted: number;
  favorites: number;
}

export interface ProfileSummary {
  profile: Profile;
  sessionCount: number;
  activeSessionCount: number;
  favorite: boolean;
}

export type ActivityKind = "session-created" | "session-used" | "profile-created" | "profile-used";

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  title: string;
  detail: string;
  at: number;
  page: "sessions" | "profiles";
}

export interface SecurityWarning {
  id: string;
  severity: "warning" | "critical";
  title: string;
  detail: string;
  page: "sessions" | "profiles";
}

export interface DashboardOverview {
  sessions: SessionTotals;
  profiles: ProfileTotals;
  /** Optional aggregate statistics, only when the caller supplies real ones. */
  statistics: AggregateStats | null;
  profileSummaries: ProfileSummary[];
  recentActivity: ActivityItem[];
  warnings: SecurityWarning[];
  favorites: {
    profiles: Profile[];
    sessions: Session[];
  };
  isEmpty: boolean;
}

/** Returns true when the dashboard has nothing to show (empty state). */
export function isDashboardEmpty(overview: DashboardOverview): boolean {
  return overview.isEmpty;
}

/** Returns the total number of items (profiles + sessions) in the overview. */
export function totalItemCount(overview: DashboardOverview): number {
  return overview.sessions.total + overview.profiles.total;
}

/** Returns the number of active sessions across all profiles. */
export function activeSessionCount(sessions: SessionTotals): number {
  return sessions.active;
}

/** Returns the number of sessions needing attention (expired). */
export function attentionCount(sessions: SessionTotals): number {
  return sessions.expired;
}

/** Counts sessions by their real lifecycle state. */
export function sessionTotals(sessions: ReadonlyArray<Session>): SessionTotals {
  const totals: SessionTotals = {
    total: sessions.length,
    active: 0,
    paused: 0,
    expired: 0,
    archived: 0,
    closed: 0,
  };
  for (const session of sessions) totals[session.state] += 1;
  return totals;
}

/** Counts profiles by state, excluding nothing the caller passed in. */
export function profileTotals(
  profiles: ReadonlyArray<Profile>,
  favoriteIds: readonly string[] = [],
): ProfileTotals {
  const totals: ProfileTotals = {
    total: profiles.length,
    active: 0,
    archived: 0,
    temporary: 0,
    deleted: 0,
    favorites: 0,
  };
  for (const profile of profiles) totals[profile.state] += 1;
  const known = new Set(profiles.map((profile) => profile.id));
  totals.favorites = [...new Set(favoriteIds)].filter((id) => known.has(id)).length;
  return totals;
}

/** Groups real session counts under each profile. */
export function profileSummaries(
  profiles: ReadonlyArray<Profile>,
  sessions: ReadonlyArray<Session>,
  favoriteIds: readonly string[] = [],
): ProfileSummary[] {
  const counts = new Map<string, { total: number; active: number }>();
  for (const session of sessions) {
    const id = session.metadata.profileId;
    if (!id) continue;
    const entry = counts.get(id) ?? { total: 0, active: 0 };
    entry.total += 1;
    if (session.state === "active") entry.active += 1;
    counts.set(id, entry);
  }
  const favorites = new Set(favoriteIds);
  return profiles.map((profile) => {
    const entry = counts.get(profile.id) ?? { total: 0, active: 0 };
    return {
      profile,
      sessionCount: entry.total,
      activeSessionCount: entry.active,
      favorite: favorites.has(profile.id),
    };
  });
}

/**
 * Recent activity from real timestamps. A session contributes its last use and
 * creation time; a profile contributes its last use and creation time. Items
 * with no timestamp are skipped.
 */
export function recentActivity(
  profiles: ReadonlyArray<Profile>,
  sessions: ReadonlyArray<Session>,
  limit = 8,
): ActivityItem[] {
  const items: ActivityItem[] = [];
  for (const session of sessions) {
    if (session.metadata.lastUsedAt !== null) {
      items.push({
        id: `session-used:${session.id}`,
        kind: "session-used",
        title: session.metadata.name,
        detail: `${session.state} session${session.metadata.domain ? ` · ${session.metadata.domain}` : ""}`,
        at: session.metadata.lastUsedAt,
        page: "sessions",
      });
    }
    items.push({
      id: `session-created:${session.id}`,
      kind: "session-created",
      title: session.metadata.name,
      detail: "Session created",
      at: session.metadata.createdAt,
      page: "sessions",
    });
  }
  for (const profile of profiles) {
    if (profile.metadata.lastUsedAt !== null) {
      items.push({
        id: `profile-used:${profile.id}`,
        kind: "profile-used",
        title: profile.metadata.name,
        detail: `${profile.state} profile`,
        at: profile.metadata.lastUsedAt,
        page: "profiles",
      });
    }
    items.push({
      id: `profile-created:${profile.id}`,
      kind: "profile-created",
      title: profile.metadata.name,
      detail: "Profile created",
      at: profile.metadata.createdAt,
      page: "profiles",
    });
  }
  return items
    .filter((item) => Number.isFinite(item.at) && item.at > 0)
    .sort((a, b) => b.at - a.at || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, limit));
}

/** Real conditions that deserve attention. These are never hidden by layout. */
export function securityWarnings(
  profiles: ReadonlyArray<Profile>,
  sessions: ReadonlyArray<Session>,
  now = Date.now(),
): SecurityWarning[] {
  const warnings: SecurityWarning[] = [];
  const expired = sessions.filter((session) => session.state === "expired");
  if (expired.length > 0) {
    warnings.push({
      id: "expired-sessions",
      severity: "warning",
      title: `${expired.length} expired session${expired.length === 1 ? "" : "s"}`,
      detail: "Restore or archive expired sessions. They cannot be opened until restored.",
      page: "sessions",
    });
  }
  const expiredTemporary = profiles.filter(
    (profile) =>
      profile.state === "temporary" &&
      profile.expiresAt !== null &&
      profile.expiresAt <= now,
  );
  if (expiredTemporary.length > 0) {
    warnings.push({
      id: "expired-temporary-profiles",
      severity: "warning",
      title: `${expiredTemporary.length} temporary profile${
        expiredTemporary.length === 1 ? " has" : "s have"
      } reached its expiry`,
      detail: "Nothing was deleted automatically. Review the temporary profiles.",
      page: "profiles",
    });
  }
  const unprotected = profiles.filter(
    (profile) => profile.state === "active" && !profile.hasIndependentPassword,
  );
  if (profiles.length > 0 && unprotected.length === profiles.length) {
    warnings.push({
      id: "no-profile-password",
      severity: "warning",
      title: "No profile has independent password protection",
      detail:
        "Independent passwords are optional. Session data is isolated by the browser but is not encrypted at rest by the dashboard.",
      page: "profiles",
    });
  }
  return warnings;
}

export interface DashboardInput {
  profiles: ReadonlyArray<Profile>;
  sessions: ReadonlyArray<Session>;
  favoriteProfileIds?: readonly string[];
  favoriteSessionIds?: readonly string[];
  statistics?: AggregateStats | null;
  now?: number;
  activityLimit?: number;
}

/** Builds every dashboard value from real stores. */
export function buildDashboard(input: DashboardInput): DashboardOverview {
  const {
    profiles,
    sessions,
    favoriteProfileIds = [],
    favoriteSessionIds = [],
    statistics = null,
    now = Date.now(),
    activityLimit = 8,
  } = input;
  const profileIds = new Set(profiles.map((profile) => profile.id));
  const sessionIds = new Set(sessions.map((session) => session.id));
  return {
    sessions: sessionTotals(sessions),
    profiles: profileTotals(profiles, favoriteProfileIds),
    statistics,
    profileSummaries: profileSummaries(profiles, sessions, favoriteProfileIds),
    recentActivity: recentActivity(profiles, sessions, activityLimit),
    warnings: securityWarnings(profiles, sessions, now),
    favorites: {
      profiles: profiles.filter((profile) => favoriteProfileIds.includes(profile.id)),
      sessions: sessions.filter((session) => favoriteSessionIds.includes(session.id)),
    },
    isEmpty: profileIds.size === 0 && sessionIds.size === 0,
  };
}
