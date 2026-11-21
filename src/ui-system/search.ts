/**
 * Global local search (AEGOX_multisession, Module 04).
 *
 * Searches only user-visible metadata: profile names, descriptions, tags and
 * folder IDs are not secrets; session names and domains are not secrets.
 * Cookies, tokens, passwords, credentials and vault contents are never read
 * here, because this module only receives the public entities.
 */

import type { Profile } from "../profiles/profile-manager/profile";
import type { Session } from "../core/session-manager/session";

export type SearchKind = "profile" | "session";

export interface SearchResult {
  kind: SearchKind;
  id: string;
  title: string;
  subtitle: string;
  /** Higher is better. */
  score: number;
  /** Extra context shown as a badge. */
  badge: string | null;
}

export interface SearchResults {
  query: string;
  profiles: SearchResult[];
  sessions: SearchResult[];
  total: number;
}

/** Minimum query length before searching. */
export const MIN_QUERY_LENGTH = 1;

/** Maximum results per category shown in the palette. */
export const SEARCH_LIMIT = 8;

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function bestScore(fields: ReadonlyArray<{ text: string | null; weight: number }>, tokens: string[]): number {
  let total = 0;
  for (const token of tokens) {
    let tokenBest = 0;
    for (const field of fields) {
      if (!field.text) continue;
      const haystack = normalize(field.text);
      if (!haystack.includes(token)) continue;
      let value = 10;
      if (haystack === token) value = 100;
      else if (haystack.startsWith(token)) value = 70;
      else if (haystack.split(/[\s._-]+/).some((word) => word.startsWith(token))) value = 45;
      tokenBest = Math.max(tokenBest, value * field.weight);
    }
    if (tokenBest === 0) return 0;
    total += tokenBest;
  }
  return total;
}

function profileResult(profile: Profile, tokens: string[]): SearchResult | null {
  const score = bestScore(
    [
      { text: profile.metadata.name, weight: 1 },
      { text: profile.metadata.description, weight: 0.6 },
      { text: profile.tags.join(" "), weight: 0.5 },
      { text: profile.folderId, weight: 0.2 },
    ],
    tokens,
  );
  if (score === 0) return null;
  const subtitleParts = [
    profile.metadata.description,
    profile.tags.length ? profile.tags.map((tag) => `#${tag}`).join(" ") : null,
    `${profile.state} profile`,
  ].filter((part): part is string => Boolean(part));
  return {
    kind: "profile",
    id: profile.id,
    title: profile.metadata.name,
    subtitle: subtitleParts.join(" · "),
    score,
    badge: profile.metadata.isDefault ? "Default" : null,
  };
}

function sessionResult(session: Session, profileName: string | null, tokens: string[]): SearchResult | null {
  const score = bestScore(
    [
      { text: session.metadata.name, weight: 1 },
      { text: session.metadata.domain, weight: 0.7 },
      { text: profileName, weight: 0.4 },
      { text: session.state, weight: 0.3 },
    ],
    tokens,
  );
  if (score === 0) return null;
  const subtitleParts = [
    session.metadata.domain,
    profileName,
    `${session.state} session`,
  ].filter((part): part is string => Boolean(part));
  return {
    kind: "session",
    id: session.id,
    title: session.metadata.name,
    subtitle: subtitleParts.join(" · "),
    score,
    badge: session.state === "active" ? "Active" : null,
  };
}

/** Searches profiles and sessions in memory, grouped by category. */
export function searchAll(
  query: string,
  profiles: ReadonlyArray<Profile>,
  sessions: ReadonlyArray<Session>,
  limit = SEARCH_LIMIT,
): SearchResults {
  const normalized = normalize(query);
  if (normalized.length < MIN_QUERY_LENGTH) {
    return { query, profiles: [], sessions: [], total: 0 };
  }
  const tokens = normalized.split(/\s+/).filter(Boolean);
  const profileNames = new Map(profiles.map((profile) => [profile.id, profile.metadata.name]));

  const profileMatches = profiles
    .map((profile) => profileResult(profile, tokens))
    .filter((result): result is SearchResult => result !== null)
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, limit);

  const sessionMatches = sessions
    .map((session) =>
      sessionResult(
        session,
        session.metadata.profileId ? profileNames.get(session.metadata.profileId) ?? null : null,
        tokens,
      ),
    )
    .filter((result): result is SearchResult => result !== null)
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, limit);

  return {
    query,
    profiles: profileMatches,
    sessions: sessionMatches,
    total: profileMatches.length + sessionMatches.length,
  };
}

/** Flattened order used by arrow-key navigation. */
export function flattenResults(results: SearchResults): SearchResult[] {
  return [...results.profiles, ...results.sessions];
}

/** Moves the active index with wrap-around. */
export function moveIndex(current: number, delta: number, total: number): number {
  if (total <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : total - 1;
  return (current + delta + total) % total;
}

/** Keeps an index inside the result set after the results change. */
export function clampIndex(index: number, total: number): number {
  if (total <= 0) return -1;
  return Math.min(total - 1, Math.max(0, index));
}

/** Searches only profiles, returning matched results sorted by score. */
export function searchProfiles(
  query: string,
  profiles: ReadonlyArray<Profile>,
  limit = SEARCH_LIMIT,
): SearchResult[] {
  const results = searchAll(query, profiles, [], limit);
  return results.profiles;
}

/** Searches only sessions, returning matched results sorted by score. */
export function searchSessions(
  query: string,
  sessions: ReadonlyArray<Session>,
  limit = SEARCH_LIMIT,
): SearchResult[] {
  const results = searchAll(query, [], sessions, limit);
  return results.sessions;
}
