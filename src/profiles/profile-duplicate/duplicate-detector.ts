/**
 * Profile Manager — Profile Duplicate Detection (AEGOX_multisession).
 *
 * Detects potentially duplicate profiles from stable metadata (name,
 * description, color, tags). It never merges, archives or deletes anything:
 * every decision is left to the user.
 *
 * Pure TypeScript: no `chrome.*` references.
 *
 * Derived from SplitSession's duplicate detection patterns
 * (https://github.com/Misyuk-T/splitsession, MIT License).
 */

import type { Profile, ProfileId } from "../profile-manager/profile";

/** Result of a duplicate check. */
export interface DuplicateCheck {
  /** True if the profile is similar enough to deserve the user's attention. */
  isDuplicate: boolean;
  /** The most similar existing profile, if any. */
  existing?: Profile;
  /** Similarity score (0-1, where 1 is identical). */
  similarity: number;
  /** Human-readable reason for the determination. */
  reason?: string;
}

/** A duplicate group: profiles that may be duplicates. */
export interface DuplicateGroup {
  /** Stable key identifying the group. */
  key: string;
  /** Profiles in this group (two or more). */
  profiles: Profile[];
  /** Why they might be duplicates. */
  reason: string;
}

/** A pair of similar profiles with the reasons why. */
export interface SimilarPair {
  a: Profile;
  b: Profile;
  similarity: number;
  reasons: string[];
}

/** Action the user can take on duplicates. */
export type DuplicateAction = "keep" | "merge" | "remove" | "none";

/** The user's explicit decision. Nothing is applied automatically. */
export interface DuplicateDecision {
  /** The profile ID to keep (if merging or keeping one). */
  keepId?: ProfileId;
  /** The profile ID to remove (if removing). */
  removeId?: ProfileId;
  /** The action chosen by the user. */
  action: DuplicateAction;
}

/** Below this score two profiles are considered unrelated. */
export const SIMILARITY_REVIEW_THRESHOLD = 0.6;

/** At or above this score a profile is very likely a duplicate. */
export const SIMILARITY_STRONG_THRESHOLD = 0.85;

/** Tokenizes a string for containment comparisons. */
function tokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9\u00c0-\uffff]+/u)
    .filter(Boolean);
}

/** Jaccard similarity of two token sets (0-1). */
function tokenSimilarity(a: string, b: string): number {
  const left = new Set(tokens(a));
  const right = new Set(tokens(b));
  if (left.size === 0 && right.size === 0) return 1;
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

/** Computes a similarity score between two profiles (0-1). */
export function profileSimilarity(a: Profile, b: Profile): number {
  let score = 0;
  let weight = 0;

  // Name: 45 points.
  weight += 45;
  const aName = a.metadata.name.toLowerCase();
  const bName = b.metadata.name.toLowerCase();
  if (aName === bName) {
    score += 45;
  } else if (aName.includes(bName) || bName.includes(aName)) {
    score += 30;
  } else {
    score += tokenSimilarity(aName, bName) * 20;
  }

  // Description: 20 points.
  weight += 20;
  if (a.metadata.description && b.metadata.description) {
    if (a.metadata.description === b.metadata.description) {
      score += 20;
    } else {
      score += tokenSimilarity(a.metadata.description, b.metadata.description) * 20;
    }
  } else if (!a.metadata.description && !b.metadata.description) {
    // Both missing is weak evidence, not a duplicate signal.
    score += 5;
  }

  // Color: 15 points.
  weight += 15;
  if (a.metadata.color === b.metadata.color) score += 15;

  // Tags: 20 points.
  weight += 20;
  if (a.tags.length > 0 || b.tags.length > 0) {
    const aTags = new Set(a.tags.map((t) => t.toLowerCase()));
    const bTags = new Set(b.tags.map((t) => t.toLowerCase()));
    let intersection = 0;
    for (const tag of aTags) if (bTags.has(tag)) intersection += 1;
    const union = new Set([...aTags, ...bTags]).size;
    score += union === 0 ? 0 : (intersection / union) * 20;
  }

  return weight === 0 ? 0 : Math.min(1, score / weight);
}

/** Stable duplicate key for a profile: name + color. */
export function duplicateKey(profile: Profile): string {
  return `${profile.metadata.name.toLowerCase()}|${(profile.metadata.color ?? "").toLowerCase()}`;
}

/**
 * Checks whether a candidate profile duplicates any existing profile.
 * Returns the most similar match and an explanation.
 */
export function checkDuplicate(
  candidate: Profile,
  existing: readonly Profile[],
): DuplicateCheck {
  let best: DuplicateCheck | undefined;

  for (const profile of existing) {
    if (profile.id === candidate.id) continue;
    const similarity = profileSimilarity(candidate, profile);
    if (similarity < SIMILARITY_REVIEW_THRESHOLD) continue;
    if (!best || similarity > best.similarity) {
      best = {
        isDuplicate: true,
        existing: profile,
        similarity,
        reason: `Profile “${profile.metadata.name}” is ${Math.round(
          similarity * 100,
        )}% similar (${explainDuplicate(candidate, profile)[0] ?? "similar metadata"}).`,
      };
    }
  }

  return best ?? { isDuplicate: false, similarity: 0 };
}

/**
 * Groups profiles by duplicate key. Only groups with more than one profile are
 * returned. Grouping is intentionally conservative: same name (case-insensitive)
 * and same color.
 */
export function findDuplicateGroups(
  profiles: readonly Profile[],
): DuplicateGroup[] {
  const groups = new Map<string, Profile[]>();
  for (const profile of profiles) {
    const key = duplicateKey(profile);
    const list = groups.get(key) ?? [];
    list.push(profile);
    groups.set(key, list);
  }

  const out: DuplicateGroup[] = [];
  for (const [key, list] of groups) {
    if (list.length > 1) {
      const [name] = key.split("|");
      out.push({
        key,
        profiles: [...list],
        reason: `${list.length} profiles share the name “${name}” and color.`,
      });
    }
  }
  return out;
}

/** Returns all profiles that are part of at least one conservative duplicate group. */
export function findDuplicateProfiles(profiles: readonly Profile[]): Profile[] {
  const groups = findDuplicateGroups(profiles);
  const seen = new Set<ProfileId>();
  const out: Profile[] = [];
  for (const group of groups) {
    for (const profile of group.profiles) {
      if (!seen.has(profile.id)) {
        seen.add(profile.id);
        out.push(profile);
      }
    }
  }
  return out;
}

/** Returns pairs whose similarity is at or above `threshold`, with reasons. */
export function findSimilarPairs(
  profiles: readonly Profile[],
  threshold: number = SIMILARITY_STRONG_THRESHOLD,
): SimilarPair[] {
  const out: SimilarPair[] = [];
  for (let i = 0; i < profiles.length; i++) {
    for (let j = i + 1; j < profiles.length; j++) {
      const a = profiles[i]!;
      const b = profiles[j]!;
      const similarity = profileSimilarity(a, b);
      if (similarity >= threshold) {
        out.push({ a, b, similarity, reasons: explainDuplicate(a, b) });
      }
    }
  }
  return out.sort((x, y) => y.similarity - x.similarity);
}

/** Formats a human-readable explanation of why two profiles may be duplicates. */
export function explainDuplicate(a: Profile, b: Profile): string[] {
  const reasons: string[] = [];
  if (a.metadata.name.toLowerCase() === b.metadata.name.toLowerCase()) {
    reasons.push(`Same name: “${a.metadata.name}”.`);
  } else if (a.metadata.name.toLowerCase().includes(b.metadata.name.toLowerCase()) ||
    b.metadata.name.toLowerCase().includes(a.metadata.name.toLowerCase())) {
    reasons.push("One name contains the other.");
  }

  if (a.metadata.color === b.metadata.color) {
    reasons.push(`Same color: ${a.metadata.color ?? "none"}.`);
  }

  if (
    a.metadata.description &&
    b.metadata.description &&
    a.metadata.description === b.metadata.description
  ) {
    reasons.push(`Same description: “${a.metadata.description}”.`);
  }

  const aTags = new Set(a.tags.map((t) => t.toLowerCase()));
  const bTags = new Set(b.tags.map((t) => t.toLowerCase()));
  const shared = [...aTags].filter((tag) => bTags.has(tag));
  if (shared.length > 0) {
    reasons.push(`Shared tags: ${shared.join(", ")}.`);
  }

  if (reasons.length === 0) {
    reasons.push("Similar combined metadata (name, description, color and tags).");
  }
  return reasons;
}
