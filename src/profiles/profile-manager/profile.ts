/**
 * Profile Manager — Profile types (AEGOX_multisession).
 *
 * Pure data types: no `chrome.*` references. Profiles are the user's
 * organizational layer above Session Core (Module 02): a profile groups
 * sessions, rules and settings, and may be protected by the global master
 * password or by its own password.
 *
 * Derived from SplitSession's container model
 * (https://github.com/Misyuk-T/splitsession, MIT License).
 */

import { generateSessionId } from "../../core/session-manager/session";

/** Unique identifier for a profile (UUID v4). */
export type ProfileId = string;

/**
 * Lifecycle states for a profile.
 *
 * `temporary` is a normal profile with an expiration time; expiry is evaluated
 * from `expiresAt`, not from a separate state. `deleted` is a soft-delete marker
 * used by callers that want an undo window before `ProfileManager.delete`.
 */
export type ProfileState = "active" | "archived" | "temporary" | "deleted";

/** How a profile was created. */
export type ProfileOrigin = "manual" | "automatic";

/** A website restriction rule. */
export interface WebsiteRule {
  /** Registrable domain or exact host, lowercase, no scheme and no path. */
  domain: string;
  /** What to do when the domain matches. */
  action: "allow" | "block";
  /** Whether the rule is active. */
  enabled: boolean;
  /** When the rule was added (epoch ms). */
  createdAt: number;
}

/** Per-profile configuration. */
export interface ProfileSettings {
  /** Reopen the profile's sessions when the browser starts. */
  restoreSessionsOnStartup: boolean;
  /** Keep session data on disk (browser permitting). */
  persistSessionData: boolean;
  /**
   * How `websiteRules` are interpreted:
   * - `blocklist`: everything is allowed except matching `block` rules.
   * - `allowlist`: everything is blocked except matching `allow` rules.
   */
  websiteMode: "blocklist" | "allowlist";
  /** Collect local, aggregate usage counters. Off by default. */
  collectStatistics: boolean;
  /**
   * What to do when a temporary profile reaches `expiresAt`:
   * `notify` leaves it untouched and asks the user; `archive` archives it.
   * Nothing is ever deleted automatically.
   */
  temporaryExpiryAction: "notify" | "archive";
}

/** Metadata associated with a profile. */
export interface ProfileMetadata {
  /** Human-readable name, unique among non-imported profiles. */
  name: string;
  /** Visual color (`#rgb`/`#rrggbb`/`#rrggbbaa`) or null. */
  color: string | null;
  /** Short icon identifier or emoji, or null. */
  icon: string | null;
  /** Optional description. */
  description: string | null;
  /** When the profile was created (epoch ms). */
  createdAt: number;
  /** When the profile was last used (epoch ms), or null. */
  lastUsedAt: number | null;
  /** Whether this is the default profile for new sessions. */
  isDefault: boolean;
}

/** A folder for organizing profiles. */
export interface ProfileFolder {
  /** Unique folder ID. */
  id: string;
  /** Human-readable folder name. */
  name: string;
  /** Optional color. */
  color: string | null;
  /** Creation time (epoch ms). */
  createdAt: number;
  /** Manual sort position (lower comes first). */
  order: number;
}

/** One profile: a container for sessions with its own configuration. */
export interface Profile {
  /** Unique identifier (UUID). Never changes during the profile's lifetime. */
  id: ProfileId;
  /** Current lifecycle state. */
  state: ProfileState;
  /** Profile metadata. */
  metadata: ProfileMetadata;
  /** Creation origin. */
  origin: ProfileOrigin;
  /** Optional expiration for temporary profiles (epoch ms). */
  expiresAt: number | null;
  /** Folder this profile belongs to, if any. */
  folderId: string | null;
  /** Tags/labels for organization and search. */
  tags: string[];
  /** Manual sort position (lower comes first). */
  order: number;
  /** Whether the profile has independent password protection. */
  hasIndependentPassword: boolean;
  /** Website restrictions for this profile. */
  websiteRules: WebsiteRule[];
  /** Per-profile configuration. */
  settings: ProfileSettings;
}

/** Input accepted by `ProfileManager.create` (validated, then normalized). */
export interface ProfileCreateInput {
  name?: unknown;
  color?: unknown;
  icon?: unknown;
  description?: unknown;
  isDefault?: unknown;
  tags?: unknown;
  folderId?: unknown;
  state?: unknown;
  origin?: unknown;
  expiresAt?: unknown;
  settings?: unknown;
}

/** Result of creating a profile. */
export interface ProfileCreated {
  profile: Profile;
  /** True if another profile looks very similar (not merged). */
  duplicateDetected: boolean;
}

/** Validation result for profile metadata. */
export type ProfileValidation =
  | { ok: true; metadata: ProfileMetadata }
  | { ok: false; message: string };

/** Maximum length for a profile name. */
export const MAX_PROFILE_NAME = 64;

/** Maximum length for a profile description. */
export const MAX_PROFILE_DESCRIPTION = 500;

/** Maximum number of tags per profile. */
export const MAX_PROFILE_TAGS = 32;

/** Maximum length of one tag. */
export const MAX_TAG_LENGTH = 32;

/** Maximum number of website rules per profile. */
export const MAX_WEBSITE_RULES = 500;

/** Default profile color. */
export const DEFAULT_PROFILE_COLOR = "#4f46e5";

/** Default profile icon. */
export const DEFAULT_PROFILE_ICON = "folder";

/** Default profile settings; conservative and local-only. */
export const DEFAULT_PROFILE_SETTINGS: ProfileSettings = {
  restoreSessionsOnStartup: true,
  persistSessionData: true,
  websiteMode: "blocklist",
  collectStatistics: false,
  temporaryExpiryAction: "notify",
};

/**
 * Generates a UUID v4 identifier. Reuses Session Core's generator so both
 * modules produce the same, RFC 4122-compatible shape.
 */
export function generateProfileId(random: () => number = Math.random): ProfileId {
  return generateSessionId(random);
}

/** Collapses whitespace in a profile name. */
export const collapseProfileName = (raw: string): string =>
  raw.replace(/\s+/g, " ").trim();

/** Sanitizes raw user input for a profile name while typing. */
export function sanitizeProfileNameInput(
  raw: string,
  max: number = MAX_PROFILE_NAME,
): string {
  const kept = Array.from(raw)
    .filter((ch) => !isStrippable(ch.codePointAt(0)!))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(kept).slice(0, max).join("");
}

/** Control characters, zero-width characters, bidi overrides, byte-order mark. */
function isStrippable(cp: number): boolean {
  return (
    cp <= 0x1f ||
    (cp >= 0x7f && cp <= 0x9f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x2028 && cp <= 0x202e) ||
    cp === 0x2060 ||
    cp === 0xfeff
  );
}

/**
 * Normalizes a color to `#rgb`, `#rrggbb` or `#rrggbbaa` (lowercase), or null.
 * The UI renders this value in a style attribute, so only a strict hex shape
 * is accepted (never arbitrary CSS).
 */
export function normalizeColor(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  if (value === "") return null;
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(value) ? value : null;
}

/** Normalizes an icon to a short, markup-free token (letters, digits, `-_.`, emoji). */
export function normalizeIcon(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = Array.from(raw.trim())
    .filter((ch) => !isStrippable(ch.codePointAt(0)!))
    .join("")
    .slice(0, 32)
    .trim();
  return value === "" ? null : value;
}

/** Normalizes one tag; returns null when nothing usable remains. */
export function normalizeTag(raw: string): string | null {
  const value = collapseProfileName(raw)
    .replace(/[,\n\r]/g, " ")
    .slice(0, MAX_TAG_LENGTH)
    .trim();
  return value === "" ? null : value;
}

/** Validates and normalizes a folder name. */
export function validateFolderName(
  raw: unknown,
  existingNames: readonly string[],
  ownName?: string,
): { ok: true; name: string } | { ok: false; message: string } {
  const name = collapseProfileName(typeof raw === "string" ? raw : "");
  if (name.length < 1) return { ok: false, message: "Give the folder a name." };
  if (Array.from(name).length > MAX_PROFILE_NAME) {
    return { ok: false, message: `Use at most ${MAX_PROFILE_NAME} characters.` };
  }
  const lower = name.toLowerCase();
  const own = ownName === undefined ? undefined : collapseProfileName(ownName).toLowerCase();
  if (existingNames.some((n) => collapseProfileName(n).toLowerCase() === lower && lower !== own)) {
    return { ok: false, message: `A folder named “${name}” already exists.` };
  }
  return { ok: true, name };
}

/** Parses profile settings from untrusted input, falling back to defaults. */
export function normalizeSettings(raw: unknown): ProfileSettings {
  const source =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const bool = (value: unknown, fallback: boolean): boolean =>
    typeof value === "boolean" ? value : fallback;
  return {
    restoreSessionsOnStartup: bool(
      source.restoreSessionsOnStartup,
      DEFAULT_PROFILE_SETTINGS.restoreSessionsOnStartup,
    ),
    persistSessionData: bool(
      source.persistSessionData,
      DEFAULT_PROFILE_SETTINGS.persistSessionData,
    ),
    websiteMode:
      source.websiteMode === "allowlist" || source.websiteMode === "blocklist"
        ? source.websiteMode
        : DEFAULT_PROFILE_SETTINGS.websiteMode,
    collectStatistics: bool(
      source.collectStatistics,
      DEFAULT_PROFILE_SETTINGS.collectStatistics,
    ),
    temporaryExpiryAction:
      source.temporaryExpiryAction === "archive" ||
      source.temporaryExpiryAction === "notify"
        ? source.temporaryExpiryAction
        : DEFAULT_PROFILE_SETTINGS.temporaryExpiryAction,
  };
}

/**
 * Validates profile metadata as the user types.
 *
 * `existingNames` is ignored when `allowDuplicateName` is true (used by import,
 * where duplicates must be preserved and surfaced to the user instead of being
 * silently renamed or dropped).
 */
export function validateProfileMetadata(
  raw: Pick<
    ProfileCreateInput,
    "name" | "color" | "icon" | "description" | "isDefault" | "tags"
  >,
  existingNames: readonly string[],
  ownName?: string,
  options: { allowDuplicateName?: boolean } = {},
): ProfileValidation {
  const name = collapseProfileName(typeof raw.name === "string" ? raw.name : "");
  if (name.length < 1) {
    return { ok: false, message: "Give the profile a name." };
  }
  if (Array.from(name).length > MAX_PROFILE_NAME) {
    return { ok: false, message: `Use at most ${MAX_PROFILE_NAME} characters.` };
  }

  const lower = name.toLowerCase();
  const ownLower =
    ownName === undefined ? undefined : collapseProfileName(ownName).toLowerCase();
  if (
    !options.allowDuplicateName &&
    existingNames.some(
      (n) => collapseProfileName(n).toLowerCase() === lower && lower !== ownLower,
    )
  ) {
    return { ok: false, message: `A profile named “${name}” already exists.` };
  }

  if (
    raw.color !== undefined &&
    raw.color !== null &&
    normalizeColor(raw.color) === null
  ) {
    return { ok: false, message: "Use a color like #4f46e5." };
  }
  if (
    raw.icon !== undefined &&
    raw.icon !== null &&
    typeof raw.icon !== "string"
  ) {
    return { ok: false, message: "Icon must be a text value." };
  }
  if (
    raw.description !== undefined &&
    raw.description !== null &&
    typeof raw.description !== "string"
  ) {
    return { ok: false, message: "Description must be a text value." };
  }

  const description =
    typeof raw.description === "string"
      ? Array.from(raw.description.trim()).slice(0, MAX_PROFILE_DESCRIPTION).join("") || null
      : null;

  const tags: string[] = [];
  if (Array.isArray(raw.tags)) {
    for (const item of raw.tags) {
      if (typeof item !== "string") continue;
      const tag = normalizeTag(item);
      if (tag && !tags.some((t) => t.toLowerCase() === tag.toLowerCase())) {
        tags.push(tag);
      }
      if (tags.length >= MAX_PROFILE_TAGS) break;
    }
  }

  return {
    ok: true,
    metadata: {
      name,
      color: normalizeColor(raw.color) ?? DEFAULT_PROFILE_COLOR,
      icon: normalizeIcon(raw.icon) ?? DEFAULT_PROFILE_ICON,
      description,
      createdAt: Date.now(),
      lastUsedAt: null,
      isDefault: raw.isDefault === true,
      // `tags` is deliberately not part of metadata; callers store it on the
      // profile. Kept here as a normalized side output via `createProfile`.
    },
  };
}

/** Creates a fresh `Profile` from validated metadata. */
export function createProfile(
  metadata: ProfileMetadata,
  options: {
    id?: ProfileId;
    origin?: ProfileOrigin;
    state?: ProfileState;
    expiresAt?: number | null;
    folderId?: string | null;
    tags?: string[];
    websiteRules?: WebsiteRule[];
    settings?: Partial<ProfileSettings>;
    hasIndependentPassword?: boolean;
    order?: number;
  } = {},
): Profile {
  return {
    id: options.id ?? generateProfileId(),
    state: options.state ?? "active",
    metadata: { ...metadata },
    origin: options.origin ?? "manual",
    expiresAt: options.expiresAt ?? null,
    folderId: options.folderId ?? null,
    tags: [...(options.tags ?? [])],
    order: options.order ?? 0,
    hasIndependentPassword: options.hasIndependentPassword ?? false,
    websiteRules: (options.websiteRules ?? []).map((rule) => ({ ...rule })),
    settings: { ...DEFAULT_PROFILE_SETTINGS, ...options.settings },
  };
}

/** Checks whether a profile's metadata looks like a duplicate of another. */
export function isDuplicateProfile(a: Profile, b: Profile): boolean {
  return (
    a.metadata.name.toLowerCase() === b.metadata.name.toLowerCase() ||
    (a.metadata.color === b.metadata.color &&
      a.metadata.description === b.metadata.description &&
      a.metadata.description !== null)
  );
}
