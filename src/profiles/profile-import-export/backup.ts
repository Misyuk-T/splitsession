/**
 * Profile Manager — Profile Import/Export (AEGOX_multisession).
 *
 * Exports profile metadata, organization (folders/tags) and settings.
 * It NEVER exports cookies, authentication tokens, passwords, vault entries or
 * session data. Imports are strictly validated before any change is made, and
 * incompatible versions are rejected with an explanation.
 *
 * Pure TypeScript: no `chrome.*` references.
 *
 * Derived from SplitSession's export/import pattern
 * (https://github.com/Misyuk-T/splitsession, MIT License).
 */

import type {
  Profile,
  ProfileFolder,
  ProfileId,
  ProfileSettings,
  ProfileState,
  WebsiteRule,
} from "../profile-manager/profile";
import {
  MAX_PROFILE_DESCRIPTION,
  MAX_PROFILE_NAME,
  MAX_PROFILE_TAGS,
  MAX_TAG_LENGTH,
  MAX_WEBSITE_RULES,
  normalizeColor,
  normalizeSettings,
} from "../profile-manager/profile";
import type { ProfileManager } from "../profile-manager/profile-manager";
import { normalizeRuleDomain } from "../profile-manager/profile-manager";

/** Current export format version. */
export const PROFILE_EXPORT_FORMAT_VERSION = 1;

/** Marker that identifies a profile export file. */
export const PROFILE_EXPORT_FORMAT = "aegox-multisession-profiles";

/** Maximum accepted import size (bytes). */
export const MAX_PROFILE_IMPORT_BYTES = 5 * 1024 * 1024; // 5 MiB

/** Maximum number of profiles in one file. */
export const MAX_PROFILES_PER_IMPORT = 10_000;

/** One exported profile: metadata and configuration, never secrets. */
export interface ExportedProfile {
  id: ProfileId;
  name: string;
  color: string | null;
  icon: string | null;
  description: string | null;
  state: ProfileState;
  origin: "manual" | "automatic";
  expiresAt: number | null;
  folderId: string | null;
  tags: string[];
  order: number;
  websiteRules: Array<{
    domain: string;
    action: "allow" | "block";
    enabled: boolean;
  }>;
  settings: ProfileSettings;
}

/** A validated profile export package. */
export interface ProfileExportPackage {
  format: typeof PROFILE_EXPORT_FORMAT;
  version: number;
  exportedAt: number;
  profiles: ExportedProfile[];
  organization: {
    folders: ProfileFolder[];
    tags: string[];
  };
  /** Always false for profile exports; a file claiming otherwise is rejected. */
  includesSensitiveData: false;
}

/** Validation result for an import file. */
export interface ProfileImportValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
  preview?: {
    profilesToCreate: number;
    profilesToUpdate: number;
    profilesToSkip: number;
    folders: number;
    hasSensitiveData: boolean;
  };
}

/** Result of importing a package. */
export interface ProfileImportResult {
  imported: number;
  updated: number;
  skipped: number;
  errors: string[];
  warnings: string[];
}

/** Error thrown when an import file must not be applied. */
export class ProfileImportError extends Error {}

const FORBIDDEN_KEY = /^(cookies?|tokens?|passwords?|secrets?|credentials?|authorization|accesstoken|refreshtoken|authtoken|apikey|privatekey)$/i;

/**
 * Fails when any forbidden key appears in a profile export. This is a defense
 * in depth check: the exporter never creates such keys, and the importer
 * refuses files that contain them instead of silently ignoring data.
 */
function findForbiddenKey(value: unknown, path = ""): string | null {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = findForbiddenKey(value[i], `${path}[${i}]`);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== "object" || value === null) return null;

  for (const [key, child] of Object.entries(value)) {
    const nextPath = path === "" ? key : `${path}.${key}`;
    if (FORBIDDEN_KEY.test(key.replace(/[_-]/g, ""))) return nextPath;
    const found = findForbiddenKey(child, nextPath);
    if (found) return found;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validState(value: unknown): value is ProfileState {
  return (
    value === "active" ||
    value === "archived" ||
    value === "temporary" ||
    value === "deleted"
  );
}

function validProfileId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9-]{1,64}$/.test(value);
}

function validFolderId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9-]{1,64}$/.test(value);
}

/** Validates a website rule from an import file. */
function readRule(value: unknown, index: number, errors: string[]): ExportedProfile["websiteRules"][number] | null {
  if (!isRecord(value)) {
    errors.push(`Website rule ${index} is not an object.`);
    return null;
  }
  if (typeof value.domain !== "string") {
    errors.push(`Website rule ${index} has no domain.`);
    return null;
  }
  const domain = normalizeRuleDomain(value.domain);
  if (!domain) {
    errors.push(`Website rule ${index} has an invalid domain.`);
    return null;
  }
  if (value.action !== "allow" && value.action !== "block") {
    errors.push(`Website rule ${index} has an invalid action.`);
    return null;
  }
  return {
    domain,
    action: value.action,
    enabled: value.enabled !== false,
  };
}

/** Reads a folder from an import file. */
function readFolder(value: unknown, index: number, errors: string[]): ProfileFolder | null {
  if (!isRecord(value)) {
    errors.push(`Folder ${index} is not an object.`);
    return null;
  }
  if (!validFolderId(value.id)) {
    errors.push(`Folder ${index} has an invalid id.`);
    return null;
  }
  if (typeof value.name !== "string" || value.name.trim() === "") {
    errors.push(`Folder ${index} has no name.`);
    return null;
  }
  return {
    id: value.id,
    name: value.name.trim().slice(0, MAX_PROFILE_NAME),
    color: normalizeColor(value.color),
    createdAt: isFiniteNumber(value.createdAt) ? value.createdAt : 0,
    order: isFiniteNumber(value.order) ? value.order : index,
  };
}

/**
 * Validates a profile export package before import.
 * Any error rejects the whole file; warnings are informational.
 */
export function validateProfileExportPackage(
  raw: unknown,
  options: { existingIds?: readonly ProfileId[] } = {},
): ProfileImportValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isRecord(raw)) {
    return {
      valid: false,
      errors: ["The profile export must be a JSON object."],
      warnings,
    };
  }

  if (raw.format !== PROFILE_EXPORT_FORMAT) {
    errors.push("This is not an AEGOX_multisession profile export.");
  }

  if (raw.version === PROFILE_EXPORT_FORMAT_VERSION) {
    // supported
  } else if (typeof raw.version === "number" && raw.version > PROFILE_EXPORT_FORMAT_VERSION) {
    errors.push(
      `This file was created by a newer version (format ${raw.version}); this build supports format ${PROFILE_EXPORT_FORMAT_VERSION}.`,
    );
  } else if (typeof raw.version !== "number") {
    errors.push("The export has no format version.");
  } else {
    errors.push(
      `Unsupported export version ${raw.version}; this build supports ${PROFILE_EXPORT_FORMAT_VERSION}.`,
    );
  }

  if (!isFiniteNumber(raw.exportedAt)) {
    errors.push("The export has no valid exportedAt timestamp.");
  }

  if (raw.includesSensitiveData === true) {
    errors.push(
      "This file claims to contain sensitive data (cookies, tokens or passwords). Profile imports never accept secrets.",
    );
  }

  const forbidden = findForbiddenKey(raw);
  if (forbidden) {
    errors.push(
      `The file contains a forbidden secret field (“${forbidden}”). Profile exports must never include credentials.`,
    );
  }

  let folders: ProfileFolder[] = [];
  if (isRecord(raw.organization)) {
    if (Array.isArray(raw.organization.folders)) {
      const seen = new Set<string>();
      for (let i = 0; i < raw.organization.folders.length; i++) {
        const folder = readFolder(raw.organization.folders[i], i, errors);
        if (!folder) continue;
        if (seen.has(folder.id)) {
          errors.push(`Folder id "${folder.id}" appears twice.`);
          continue;
        }
        seen.add(folder.id);
        folders.push(folder);
      }
    }
    if (
      raw.organization.tags !== undefined &&
      !Array.isArray(raw.organization.tags)
    ) {
      errors.push("organization.tags must be an array if present.");
    }
  }

  const existing = new Set(options.existingIds ?? []);
  const seenProfileIds = new Set<string>();
  let toCreate = 0;
  let toUpdate = 0;

  if (!Array.isArray(raw.profiles)) {
    errors.push("The export has no profiles array.");
  } else {
    if (raw.profiles.length > MAX_PROFILES_PER_IMPORT) {
      errors.push(
        `The export contains more than ${MAX_PROFILES_PER_IMPORT} profiles.`,
      );
    }
    for (let i = 0; i < raw.profiles.length; i++) {
      const value = raw.profiles[i];
      if (!isRecord(value)) {
        errors.push(`Profile ${i} is not an object.`);
        continue;
      }
      if (!validProfileId(value.id)) {
        errors.push(`Profile ${i} has an invalid id.`);
        continue;
      }
      if (seenProfileIds.has(value.id)) {
        errors.push(`Profile id "${value.id}" appears twice.`);
        continue;
      }
      seenProfileIds.add(value.id);

      if (
        typeof value.name !== "string" ||
        value.name.trim() === "" ||
        Array.from(value.name.trim()).length > MAX_PROFILE_NAME
      ) {
        errors.push(`Profile ${i} has an invalid name.`);
      }
      if (value.color !== undefined && value.color !== null && normalizeColor(value.color) === null) {
        errors.push(`Profile ${i} has an invalid color.`);
      }
      if (!validState(value.state)) {
        errors.push(`Profile ${i} has an invalid state.`);
      }
      if (
        value.description !== undefined &&
        value.description !== null &&
        (typeof value.description !== "string" ||
          Array.from(value.description).length > MAX_PROFILE_DESCRIPTION)
      ) {
        errors.push(`Profile ${i} has an invalid description.`);
      }
      if (value.folderId !== undefined && value.folderId !== null) {
        if (!validFolderId(value.folderId)) {
          errors.push(`Profile ${i} has an invalid folder id.`);
        } else if (!folders.some((folder) => folder.id === value.folderId)) {
          warnings.push(
            `Profile ${i} references folder "${value.folderId}", which is not in the file; it will be imported without a folder.`,
          );
        }
      }
      if (value.tags !== undefined) {
        if (!Array.isArray(value.tags)) {
          errors.push(`Profile ${i} has invalid tags.`);
        } else if (value.tags.length > MAX_PROFILE_TAGS) {
          errors.push(`Profile ${i} has too many tags.`);
        } else if (
          value.tags.some(
            (tag) =>
              typeof tag !== "string" ||
              tag.trim() === "" ||
              Array.from(tag).length > MAX_TAG_LENGTH,
          )
        ) {
          errors.push(`Profile ${i} has an invalid tag.`);
        }
      }
      if (value.websiteRules !== undefined) {
        if (!Array.isArray(value.websiteRules)) {
          errors.push(`Profile ${i} has invalid website rules.`);
        } else if (value.websiteRules.length > MAX_WEBSITE_RULES) {
          errors.push(`Profile ${i} has too many website rules.`);
        } else {
          value.websiteRules.forEach((rule, index) => {
            readRule(rule, index, errors);
          });
        }
      }
      if (value.settings !== undefined) {
        if (!isRecord(value.settings)) {
          errors.push(`Profile ${i} has invalid settings.`);
        } else {
          for (const key of [
            "restoreSessionsOnStartup",
            "persistSessionData",
            "collectStatistics",
          ]) {
            if (
              value.settings[key] !== undefined &&
              typeof value.settings[key] !== "boolean"
            ) {
              errors.push(`Profile ${i} setting "${key}" must be true or false.`);
            }
          }
          if (
            value.settings.websiteMode !== undefined &&
            value.settings.websiteMode !== "blocklist" &&
            value.settings.websiteMode !== "allowlist"
          ) {
            errors.push(`Profile ${i} has an invalid websiteMode.`);
          }
          if (
            value.settings.temporaryExpiryAction !== undefined &&
            value.settings.temporaryExpiryAction !== "notify" &&
            value.settings.temporaryExpiryAction !== "archive"
          ) {
            errors.push(
              `Profile ${i} has an invalid temporaryExpiryAction.`,
            );
          }
        }
      }

      if (existing.has(value.id)) toUpdate += 1;
      else toCreate += 1;
    }
  }

  const valid = errors.length === 0;
  return {
    valid,
    errors,
    warnings,
    ...(valid
      ? {
          preview: {
            profilesToCreate: toCreate,
            profilesToUpdate: toUpdate,
            profilesToSkip: 0,
            folders: folders.length,
            hasSensitiveData: false,
          },
        }
      : {}),
  };
}

/** Throws if an object contains a forbidden secret field (belt and braces). */
function assertNoSecrets(value: unknown): void {
  const forbidden = findForbiddenKey(value);
  if (forbidden) {
    throw new ProfileImportError(
      `Refusing to export: forbidden secret field “${forbidden}”.`,
    );
  }
}

function exportProfile(profile: Profile): ExportedProfile {
  return {
    id: profile.id,
    name: profile.metadata.name,
    color: profile.metadata.color,
    icon: profile.metadata.icon,
    description: profile.metadata.description,
    state: profile.state,
    origin: profile.origin,
    expiresAt: profile.expiresAt,
    folderId: profile.folderId,
    tags: [...profile.tags],
    order: profile.order,
    websiteRules: profile.websiteRules.map((rule) => ({
      domain: rule.domain,
      action: rule.action,
      enabled: rule.enabled,
    })),
    settings: { ...profile.settings },
    // `hasIndependentPassword` is deliberately omitted: it describes a vault
    // that is not part of the export, and the import must not claim protection.
  };
}

/**
 * Serializes profiles and the organization structure into an export package.
 * Never includes cookies, tokens, passwords, vault entries or sessions.
 */
export function createProfileExportPackage(
  profiles: readonly Profile[],
  folders: readonly ProfileFolder[] = [],
  options: { now?: () => number } = {},
): ProfileExportPackage {
  const tags = new Set<string>();
  for (const profile of profiles) {
    for (const tag of profile.tags) tags.add(tag);
  }

  const pkg: ProfileExportPackage = {
    format: PROFILE_EXPORT_FORMAT,
    version: PROFILE_EXPORT_FORMAT_VERSION,
    exportedAt: (options.now ?? Date.now)(),
    profiles: profiles.map(exportProfile),
    organization: {
      folders: folders.map((folder) => ({ ...folder })),
      tags: [...tags].sort((a, b) => a.localeCompare(b)),
    },
    includesSensitiveData: false,
  };
  assertNoSecrets(pkg);
  return pkg;
}

/** Exports a single profile (individual export). */
export function createSingleProfileExportPackage(
  profile: Profile,
  folders: readonly ProfileFolder[] = [],
  options: { now?: () => number } = {},
): ProfileExportPackage {
  return createProfileExportPackage([profile], folders, options);
}

/** Parses an import file, enforcing the size limit. */
export function parseProfileExportPackage(
  json: string,
  options: { maxBytes?: number } = {},
): unknown {
  const max = options.maxBytes ?? MAX_PROFILE_IMPORT_BYTES;
  const bytes = new TextEncoder().encode(json).byteLength;
  if (bytes > max) {
    throw new ProfileImportError(
      `The file is too large (${bytes} bytes; maximum ${max}).`,
    );
  }
  try {
    return JSON.parse(json) as unknown;
  } catch {
    throw new ProfileImportError("The file is not valid JSON.");
  }
}

/**
 * Validates and imports profiles from a package.
 *
 * - The whole file is validated before any change.
 * - Existing IDs are skipped unless `overwrite` is true.
 * - Independent-password protection is never restored (no vault is in the file).
 * - Folders are imported preserving their IDs.
 */
export async function importProfiles(
  packageData: unknown,
  profileManager: ProfileManager,
  options: { overwrite?: boolean } = {},
): Promise<ProfileImportResult> {
  const validation = validateProfileExportPackage(packageData, {
    existingIds: profileManager.list().map((profile) => profile.id),
  });
  if (!validation.valid || !isRecord(packageData)) {
    throw new ProfileImportError(
      validation.errors.join(" ") || "The profile export is invalid.",
    );
  }

  const raw = packageData as unknown as ProfileExportPackage;
  const warnings = [...validation.warnings];
  const errors: string[] = [];
  let imported = 0;
  let updated = 0;
  let skipped = 0;

  for (const folder of raw.organization.folders) {
    try {
      await profileManager.importFolder(folder);
    } catch (error) {
      warnings.push(
        `Folder “${folder.name}” could not be imported: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  for (const entry of raw.profiles) {
    try {
      const exists = profileManager.get(entry.id);
      if (exists && !options.overwrite) {
        skipped += 1;
        continue;
      }

      const websiteRules: WebsiteRule[] = [];
      for (const rule of entry.websiteRules) {
        const domain = normalizeRuleDomain(rule.domain);
        if (!domain) continue;
        websiteRules.push({
          domain,
          action: rule.action,
          enabled: rule.enabled,
          createdAt: 0,
        });
      }

      if (exists) {
        await profileManager.update(
          entry.id,
          {
            name: entry.name,
            color: entry.color,
            icon: entry.icon,
            description: entry.description,
            state: entry.state,
            expiresAt: entry.expiresAt,
            folderId: entry.folderId,
            tags: entry.tags,
            settings: normalizeSettings(entry.settings),
            hasIndependentPassword: false,
          },
          { allowDuplicateName: true },
        );
        await profileManager.setWebsiteRules(entry.id, websiteRules);
        updated += 1;
      } else {
        await profileManager.createWithId({
          id: entry.id,
          name: entry.name,
          color: entry.color,
          icon: entry.icon,
          description: entry.description,
          state: entry.state,
          origin: entry.origin,
          expiresAt: entry.expiresAt,
          folderId: entry.folderId,
          tags: entry.tags,
          order: entry.order,
          websiteRules,
          settings: entry.settings,
          hasIndependentPassword: false,
        });
        imported += 1;
      }
    } catch (error) {
      errors.push(
        `Profile “${entry.name}” (${entry.id}) could not be imported: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (raw.profiles.some((entry) => entry.state === "temporary")) {
    warnings.push(
      "Temporary profiles keep their expiration time; expired ones are never deleted automatically.",
    );
  }

  return { imported, updated, skipped, errors, warnings };
}
