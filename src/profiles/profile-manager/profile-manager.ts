/**
 * Profile Manager — Profile Manager (AEGOX_multisession).
 *
 * Business logic for profile CRUD, organization (folders, tags, ordering),
 * search, sorting and filtering. Integrates with Session Core (Module 02)
 * without replacing it: a profile is referenced by `SessionMetadata.profileId`.
 *
 * Pure TypeScript: persistence is delegated to a provided `StorageAreaLike`.
 *
 * Derived from SplitSession's `ContainerStore` pattern
 * (https://github.com/Misyuk-T/splitsession, MIT License).
 */

import type { StorageAreaLike } from "../../engine/storage/storage-area";
import {
  collapseProfileName,
  createProfile,
  DEFAULT_PROFILE_SETTINGS,
  generateProfileId,
  MAX_PROFILE_NAME,
  MAX_PROFILE_TAGS,
  MAX_WEBSITE_RULES,
  normalizeColor,
  normalizeSettings,
  normalizeTag,
  validateFolderName,
  validateProfileMetadata,
} from "./profile";
import type {
  Profile,
  ProfileCreateInput,
  ProfileCreated,
  ProfileFolder,
  ProfileId,
  ProfileMetadata,
  ProfileOrigin,
  ProfileSettings,
  ProfileState,
  WebsiteRule,
} from "./profile";
import { checkDuplicate } from "../profile-duplicate/duplicate-detector";

/** `chrome.storage.local` key holding the profile list. */
export const PROFILES_KEY = "profiles";

/** `chrome.storage.local` key holding the folder list. */
export const PROFILE_FOLDERS_KEY = "profileFolders";

/** Error thrown by the profile manager. */
export class ProfileError extends Error {}

/** Options for the profile manager. */
export interface ProfileManagerOptions {
  /** Now function (ms). Default Date.now. */
  now?: () => number;
  /** Random function for ID generation. Default Math.random. */
  random?: () => number;
}

/** Sort options for profile listings. */
export type ProfileSortField = "name" | "createdAt" | "lastUsedAt" | "state" | "order";

/** Sort direction. */
export type ProfileSortDirection = "asc" | "desc";

/** Filter options for profile listings. */
export interface ProfileFilters {
  /** Search text matched against name, description, tags and folder name. */
  search?: string;
  /** Only profiles in this folder (null = no folder, undefined = all). */
  folderId?: string | null;
  /** Only profiles with all of these tags (case-insensitive). */
  tags?: string[];
  /** Only profiles with this state. */
  state?: ProfileState;
  /** Include archived/deleted profiles. Default false. */
  includeArchived?: boolean;
  /** Include temporary profiles. Default true. */
  includeTemporary?: boolean;
  /** Include the soft-deleted profiles. Default false. */
  includeDeleted?: boolean;
}

/** Result of listing profiles with filters and sorting. */
export interface ProfileListing {
  profiles: Profile[];
  /** Total profiles in the store (before filtering). */
  total: number;
  /** Profiles after filtering. */
  filtered: number;
}

/** Patch accepted by `ProfileManager.update`. */
export interface ProfilePatch {
  name?: string;
  color?: string | null;
  icon?: string | null;
  description?: string | null;
  isDefault?: boolean;
  lastUsedAt?: number | null;
  state?: ProfileState;
  folderId?: string | null;
  tags?: string[];
  expiresAt?: number | null;
  hasIndependentPassword?: boolean;
  settings?: Partial<ProfileSettings>;
}

/** Input for `createWithId` (restore and import). */
export interface ProfileImportInput {
  id: ProfileId;
  name: string;
  color?: string | null;
  icon?: string | null;
  description?: string | null;
  state?: ProfileState;
  origin?: ProfileOrigin;
  expiresAt?: number | null;
  folderId?: string | null;
  tags?: string[];
  order?: number;
  hasIndependentPassword?: boolean;
  websiteRules?: Array<{ domain: string; action: "allow" | "block"; enabled?: boolean }>;
  settings?: Partial<ProfileSettings>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validState(value: unknown): value is ProfileState {
  return (
    value === "active" ||
    value === "archived" ||
    value === "temporary" ||
    value === "deleted"
  );
}

/** Normalizes a stored (possibly old or damaged) profile. Returns null if unusable. */
function normalizeStoredProfile(value: unknown): Profile | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || value.id === "") return null;
  if (!isRecord(value.metadata)) return null;
  if (typeof value.metadata.name !== "string") return null;
  const name = collapseProfileName(value.metadata.name);
  if (name === "") return null;

  const tags: string[] = [];
  if (Array.isArray(value.tags)) {
    for (const item of value.tags) {
      if (typeof item !== "string") continue;
      const tag = normalizeTag(item);
      if (tag && !tags.includes(tag)) tags.push(tag);
      if (tags.length >= MAX_PROFILE_TAGS) break;
    }
  }

  const rules: WebsiteRule[] = [];
  if (Array.isArray(value.websiteRules)) {
    for (const rule of value.websiteRules.slice(0, MAX_WEBSITE_RULES)) {
      if (!isRecord(rule)) continue;
      if (typeof rule.domain !== "string") continue;
      const domain = normalizeRuleDomain(rule.domain);
      const action = rule.action === "allow" || rule.action === "block" ? rule.action : null;
      if (!domain || !action) continue;
      rules.push({
        domain,
        action,
        enabled: rule.enabled !== false,
        createdAt:
          typeof rule.createdAt === "number" && Number.isFinite(rule.createdAt)
            ? rule.createdAt
            : 0,
      });
    }
  }

  return {
    id: value.id,
    state: validState(value.state) ? value.state : "active",
    metadata: {
      name,
      color: normalizeColor(value.metadata.color),
      icon: typeof value.metadata.icon === "string" ? value.metadata.icon : null,
      description:
        typeof value.metadata.description === "string"
          ? value.metadata.description
          : null,
      createdAt:
        typeof value.metadata.createdAt === "number"
          ? value.metadata.createdAt
          : 0,
      lastUsedAt:
        typeof value.metadata.lastUsedAt === "number"
          ? value.metadata.lastUsedAt
          : null,
      isDefault: value.metadata.isDefault === true,
    },
    origin: value.origin === "automatic" ? "automatic" : "manual",
    expiresAt:
      typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt)
        ? value.expiresAt
        : null,
    folderId: typeof value.folderId === "string" ? value.folderId : null,
    tags,
    order:
      typeof value.order === "number" && Number.isFinite(value.order)
        ? value.order
        : 0,
    hasIndependentPassword: value.hasIndependentPassword === true,
    websiteRules: rules,
    settings: normalizeSettings(value.settings),
  };
}

/** Normalizes a stored folder. */
function normalizeStoredFolder(value: unknown): ProfileFolder | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || value.id === "") return null;
  const name = collapseProfileName(typeof value.name === "string" ? value.name : "");
  if (name === "") return null;
  return {
    id: value.id,
    name,
    color: normalizeColor(value.color),
    createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
    order: typeof value.order === "number" ? value.order : 0,
  };
}

/** Normalizes a rule domain: lowercase host, no scheme, no path, no port. */
export function normalizeRuleDomain(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "") return null;
  try {
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
      ? new URL(trimmed)
      : new URL(`http://${trimmed}`);
    // Never accept a URL that carries credentials.
    if (url.username !== "" || url.password !== "") return null;
    const host = url.hostname.toLowerCase();
    if (host === "" || host.includes(" ")) return null;
    if (host.length > 253) return null;
    return host;
  } catch {
    return null;
  }
}

/**
 * Manages profiles in memory with a persisted copy in storage.
 * Profiles are the user's top-level grouping for sessions.
 */
export class ProfileManager {
  private profiles = new Map<ProfileId, Profile>();
  private folders = new Map<string, ProfileFolder>();
  private writing: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(
    private readonly area: StorageAreaLike,
    options: ProfileManagerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  /** Loads profiles and folders from storage. Invalid entries are dropped. */
  async load(): Promise<void> {
    const stored = await this.area.get([PROFILES_KEY, PROFILE_FOLDERS_KEY]);

    this.profiles = new Map();
    const rawProfiles = stored[PROFILES_KEY];
    if (Array.isArray(rawProfiles)) {
      for (const item of rawProfiles) {
        const profile = normalizeStoredProfile(item);
        if (profile) this.profiles.set(profile.id, profile);
      }
    }

    this.folders = new Map();
    const rawFolders = stored[PROFILE_FOLDERS_KEY];
    if (Array.isArray(rawFolders)) {
      for (const item of rawFolders) {
        const folder = normalizeStoredFolder(item);
        if (folder) this.folders.set(folder.id, folder);
      }
    }

    // Drop folder references that no longer resolve.
    for (const profile of this.profiles.values()) {
      if (profile.folderId && !this.folders.has(profile.folderId)) {
        profile.folderId = null;
      }
    }
  }

  /** Returns a copy of all profiles. */
  list(): Profile[] {
    return [...this.profiles.values()].map((p) => cloneProfile(p));
  }

  /** Returns a profile by ID, or undefined. */
  get(id: ProfileId): Profile | undefined {
    const found = this.profiles.get(id);
    return found ? cloneProfile(found) : undefined;
  }

  /** Returns true if the profile exists. */
  has(id: ProfileId): boolean {
    return this.profiles.has(id);
  }

  /** Finds a profile by exact ID first, then by case-insensitive name. */
  resolve(ref: string): Profile | undefined {
    return this.get(ref) ?? this.findByName(ref);
  }

  /** Finds a profile by case-insensitive name (first match). */
  findByName(name: string): Profile | undefined {
    const wanted = collapseProfileName(name).toLowerCase();
    const found = [...this.profiles.values()].find(
      (p) => p.metadata.name.toLowerCase() === wanted,
    );
    return found ? cloneProfile(found) : undefined;
  }

  /** Returns the names of all existing profiles (for uniqueness checks). */
  existingNames(): string[] {
    return [...this.profiles.values()].map((p) => p.metadata.name);
  }

  /** Returns the default profile: `isDefault`, else the first active one. */
  getDefault(): Profile | undefined {
    const all = [...this.profiles.values()];
    const flagged = all.find((p) => p.metadata.isDefault && p.state === "active");
    const fallback = all.find((p) => p.state === "active");
    return flagged ? cloneProfile(flagged) : fallback ? cloneProfile(fallback) : undefined;
  }

  /** Returns all unique tags across profiles, sorted. */
  allTags(): string[] {
    const tags = new Set<string>();
    for (const profile of this.profiles.values()) {
      for (const tag of profile.tags) tags.add(tag);
    }
    return [...tags].sort((a, b) => a.localeCompare(b));
  }

  /** Returns all folders, sorted by `order`. */
  listFolders(): ProfileFolder[] {
    return [...this.folders.values()]
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
      .map((f) => ({ ...f }));
  }

  /** Returns a folder by ID. */
  getFolder(id: string): ProfileFolder | undefined {
    const found = this.folders.get(id);
    return found ? { ...found } : undefined;
  }

  /** Creates a folder. */
  async createFolder(rawName: unknown, color?: unknown): Promise<ProfileFolder> {
    const validation = validateFolderName(
      rawName,
      [...this.folders.values()].map((f) => f.name),
    );
    if (!validation.ok) throw new ProfileError(validation.message);

    const folder: ProfileFolder = {
      id: generateProfileId(this.random),
      name: validation.name,
      color: normalizeColor(color),
      createdAt: this.now(),
      order: this.folders.size,
    };
    this.folders.set(folder.id, folder);
    await this.persist();
    return { ...folder };
  }

  /** Renames a folder. */
  async renameFolder(id: string, rawName: unknown): Promise<ProfileFolder> {
    const folder = this.folders.get(id);
    if (!folder) throw new ProfileError(`no folder "${id}"`);
    const validation = validateFolderName(
      rawName,
      [...this.folders.values()].map((f) => f.name),
      folder.name,
    );
    if (!validation.ok) throw new ProfileError(validation.message);
    folder.name = validation.name;
    await this.persist();
    return { ...folder };
  }

  /**
   * Deletes a folder. Profiles inside it are unassigned (never deleted).
   * Returns the IDs of profiles that were unassigned.
   */
  async deleteFolder(id: string): Promise<ProfileId[]> {
    if (!this.folders.delete(id)) throw new ProfileError(`no folder "${id}"`);
    const unassigned: ProfileId[] = [];
    for (const profile of this.profiles.values()) {
      if (profile.folderId === id) {
        profile.folderId = null;
        unassigned.push(profile.id);
      }
    }
    await this.persist();
    return unassigned;
  }

  /**
   * Creates a new profile from validated metadata.
   * Throws `ProfileError` if validation fails or the name is taken.
   */
  async create(input: ProfileCreateInput = {}): Promise<ProfileCreated> {
    const validation = validateProfileMetadata(input, this.existingNames());
    if (!validation.ok) throw new ProfileError(validation.message);

    const folderId = this.validFolderId(input.folderId);
    const settings = normalizeSettings(input.settings);
    const state = validState(input.state) ? input.state : "active";
    const origin: ProfileOrigin = input.origin === "automatic" ? "automatic" : "manual";
    const expiresAt =
      state === "temporary" && typeof input.expiresAt === "number"
        ? input.expiresAt
        : null;

    const profile = createProfile(
      { ...validation.metadata, createdAt: this.now() },
      {
        id: generateProfileId(this.random),
        origin,
        state,
        expiresAt,
        folderId,
        tags: normalizeTags(input.tags),
        settings,
        order: this.profiles.size,
      },
    );

    const duplicateDetected = checkDuplicate(
      profile,
      [...this.profiles.values()],
    ).isDuplicate;

    this.profiles.set(profile.id, profile);
    await this.persist();
    return { profile: cloneProfile(profile), duplicateDetected };
  }

  /**
   * Creates a profile under a given ID (restore/import).
   *
   * Names may collide here on purpose: an import must preserve what the file
   * says, and duplicate profiles are then shown to the user (never merged or
   * deleted automatically).
   */
  async createWithId(input: ProfileImportInput): Promise<Profile> {
    if (!/^[a-z0-9-]{1,64}$/.test(input.id)) {
      throw new ProfileError(`invalid profile ID "${input.id}"`);
    }
    if (this.profiles.has(input.id)) {
      throw new ProfileError(`a profile "${input.id}" already exists`);
    }

    const validation = validateProfileMetadata(
      {
        name: input.name,
        color: input.color,
        icon: input.icon,
        description: input.description,
        tags: input.tags,
        isDefault: false,
      },
      this.existingNames(),
      undefined,
      { allowDuplicateName: true },
    );
    if (!validation.ok) throw new ProfileError(validation.message);

    const rules: WebsiteRule[] = [];
    for (const rule of (input.websiteRules ?? []).slice(0, MAX_WEBSITE_RULES)) {
      const domain = normalizeRuleDomain(rule.domain);
      if (!domain) continue;
      rules.push({
        domain,
        action: rule.action,
        enabled: rule.enabled !== false,
        createdAt: this.now(),
      });
    }

    const profile = createProfile(
      { ...validation.metadata, createdAt: this.now() },
      {
        id: input.id,
        state: validState(input.state) ? input.state : "active",
        origin: input.origin === "automatic" ? "automatic" : "manual",
        expiresAt: typeof input.expiresAt === "number" ? input.expiresAt : null,
        folderId: this.validFolderId(input.folderId),
        tags: normalizeTags(input.tags),
        websiteRules: rules,
        settings: normalizeSettings(input.settings),
        // A protection flag without the matching vault would lock the profile
        // forever, so imports never restore it. The user re-protects manually.
        hasIndependentPassword: false,
        order: typeof input.order === "number" ? input.order : this.profiles.size,
      },
    );

    this.profiles.set(profile.id, profile);
    await this.persist();
    return cloneProfile(profile);
  }

  /** Updates a profile. Metadata fields and organization fields are validated. */
  async update(
    id: ProfileId,
    patch: ProfilePatch,
    options: { allowDuplicateName?: boolean } = {},
  ): Promise<Profile> {
    const profile = this.profiles.get(id);
    if (!profile) throw new ProfileError(`no profile "${id}"`);

    const touchesMetadata =
      patch.name !== undefined ||
      patch.color !== undefined ||
      patch.icon !== undefined ||
      patch.description !== undefined ||
      patch.isDefault !== undefined ||
      patch.lastUsedAt !== undefined;

    if (touchesMetadata) {
      const validation = validateProfileMetadata(
        {
          name: patch.name ?? profile.metadata.name,
          color:
            patch.color === undefined ? profile.metadata.color : patch.color,
          icon: patch.icon === undefined ? profile.metadata.icon : patch.icon,
          description:
            patch.description === undefined
              ? profile.metadata.description
              : patch.description,
          isDefault: patch.isDefault ?? profile.metadata.isDefault,
        },
        this.existingNames(),
        profile.metadata.name,
        { allowDuplicateName: options.allowDuplicateName === true },
      );
      if (!validation.ok) throw new ProfileError(validation.message);
      profile.metadata = {
        ...profile.metadata,
        ...validation.metadata,
        createdAt: profile.metadata.createdAt,
        lastUsedAt:
          patch.lastUsedAt === undefined
            ? profile.metadata.lastUsedAt
            : patch.lastUsedAt,
      };
    }

    if (patch.state !== undefined) {
      if (!validState(patch.state)) throw new ProfileError("invalid profile state");
      profile.state = patch.state;
    }
    if (patch.folderId !== undefined) {
      profile.folderId = this.validFolderId(patch.folderId);
    }
    if (patch.tags !== undefined) {
      profile.tags = normalizeTags(patch.tags);
    }
    if (patch.expiresAt !== undefined) {
      profile.expiresAt = patch.expiresAt;
    }
    if (patch.hasIndependentPassword !== undefined) {
      profile.hasIndependentPassword = patch.hasIndependentPassword;
    }
    if (patch.settings !== undefined) {
      profile.settings = {
        ...profile.settings,
        ...normalizeSettings({ ...profile.settings, ...patch.settings }),
      };
    }

    await this.persist();
    return cloneProfile(profile);
  }

  /** Changes only the lifecycle state of a profile. */
  async setState(id: ProfileId, state: ProfileState): Promise<Profile> {
    return this.update(id, { state });
  }

  /** Records that a profile was used now. */
  async touch(id: ProfileId): Promise<Profile> {
    return this.update(id, { lastUsedAt: this.now() });
  }

  /** Archives a profile (soft delete; sessions are untouched). */
  async archive(id: ProfileId): Promise<Profile> {
    return this.setState(id, "archived");
  }

  /** Restores an archived profile to active. */
  async restore(id: ProfileId): Promise<Profile> {
    const profile = this.profiles.get(id);
    if (!profile) throw new ProfileError(`no profile "${id}"`);
    if (profile.state !== "archived" && profile.state !== "deleted") {
      throw new ProfileError(`profile "${id}" is not archived`);
    }
    return this.update(id, { state: "active", expiresAt: null });
  }

  /** Marks a profile as deleted (soft delete). Sessions are NOT deleted. */
  async markDeleted(id: ProfileId): Promise<Profile> {
    return this.setState(id, "deleted");
  }

  /**
   * Deletes a profile record permanently. Returns false if not found.
   *
   * This does not touch sessions. Use `deleteProfileWithSessions` from
   * `../profile-lifecycle/deletion` when the user has chosen what to do with
   * the profile's sessions.
   */
  async delete(id: ProfileId): Promise<boolean> {
    if (!this.profiles.delete(id)) return false;
    await this.persist();
    return true;
  }

  /**
   * Duplicates a profile (metadata, tags, folder, rules and settings).
   * The copy never inherits the independent password: its vault is not copied,
   * so it starts unprotected and the user can protect it again deliberately.
   */
  async duplicate(id: ProfileId): Promise<Profile> {
    const source = this.profiles.get(id);
    if (!source) throw new ProfileError(`no profile "${id}"`);

    const name = this.uniqueCopyName(source.metadata.name);
    const now = this.now();
    const copy = createProfile(
      {
        ...source.metadata,
        name,
        createdAt: now,
        lastUsedAt: null,
        isDefault: false,
      },
      {
        origin: "manual",
        state: "active",
        expiresAt: null,
        folderId: source.folderId,
        tags: [...source.tags],
        websiteRules: source.websiteRules.map((rule) => ({
          ...rule,
          createdAt: now,
        })),
        settings: { ...source.settings },
        hasIndependentPassword: false,
        order: this.profiles.size,
      },
    );

    this.profiles.set(copy.id, copy);
    await this.persist();
    return cloneProfile(copy);
  }

  /** Imports a folder preserving its ID (used by profile import). */
  async importFolder(input: ProfileFolder): Promise<ProfileFolder> {
    if (!/^[a-z0-9-]{1,64}$/.test(input.id)) {
      throw new ProfileError(`invalid folder ID "${input.id}"`);
    }
    const name = collapseProfileName(input.name);
    if (name === "") throw new ProfileError("Give the folder a name.");
    const folder: ProfileFolder = {
      id: input.id,
      name: Array.from(name).slice(0, MAX_PROFILE_NAME).join(""),
      color: normalizeColor(input.color),
      createdAt: Number.isFinite(input.createdAt) ? input.createdAt : this.now(),
      order: Number.isFinite(input.order) ? input.order : this.folders.size,
    };
    this.folders.set(folder.id, folder);
    await this.persist();
    return { ...folder };
  }

  /** Replaces the website rules of a profile (import and settings UI). */
  async setWebsiteRules(id: ProfileId, rules: WebsiteRule[]): Promise<Profile> {
    const profile = this.profiles.get(id);
    if (!profile) throw new ProfileError(`no profile "${id}"`);

    const normalized: WebsiteRule[] = [];
    for (const rule of rules.slice(0, MAX_WEBSITE_RULES)) {
      const domain = normalizeRuleDomain(rule.domain);
      if (!domain) continue;
      normalized.push({
        domain,
        action: rule.action === "allow" ? "allow" : "block",
        enabled: rule.enabled !== false,
        createdAt: Number.isFinite(rule.createdAt) ? rule.createdAt : this.now(),
      });
    }
    profile.websiteRules = normalized;
    await this.persist();
    return cloneProfile(profile);
  }

  /** Assigns a profile to a folder (or removes it from any folder with null). */
  async assignFolder(id: ProfileId, folderId: string | null): Promise<Profile> {
    return this.update(id, { folderId });
  }

  /** Adds a tag to a profile. */
  async addTag(id: ProfileId, rawTag: string): Promise<Profile> {
    const profile = this.profiles.get(id);
    if (!profile) throw new ProfileError(`no profile "${id}"`);
    const tag = normalizeTag(rawTag);
    if (!tag) return cloneProfile(profile);
    if (!profile.tags.some((t) => t.toLowerCase() === tag.toLowerCase())) {
      if (profile.tags.length >= MAX_PROFILE_TAGS) {
        throw new ProfileError(`at most ${MAX_PROFILE_TAGS} tags per profile`);
      }
      profile.tags.push(tag);
      await this.persist();
    }
    return cloneProfile(profile);
  }

  /** Removes a tag from a profile (case-insensitive). */
  async removeTag(id: ProfileId, rawTag: string): Promise<Profile> {
    const profile = this.profiles.get(id);
    if (!profile) throw new ProfileError(`no profile "${id}"`);
    const wanted = collapseProfileName(rawTag).toLowerCase();
    profile.tags = profile.tags.filter((t) => t.toLowerCase() !== wanted);
    await this.persist();
    return cloneProfile(profile);
  }

  /**
   * Moves a profile before another profile in the manual order, or to the end
   * when `beforeId` is null. This is the data operation behind drag-and-drop.
   */
  async move(id: ProfileId, beforeId: ProfileId | null): Promise<void> {
    if (!this.profiles.has(id)) throw new ProfileError(`no profile "${id}"`);
    if (beforeId === id) return;
    if (beforeId !== null && !this.profiles.has(beforeId)) {
      throw new ProfileError(`no profile "${beforeId}"`);
    }

    const ordered = [...this.profiles.values()].sort(
      (a, b) => a.order - b.order || a.metadata.createdAt - b.metadata.createdAt,
    );
    const moving = ordered.find((p) => p.id === id)!;
    const rest = ordered.filter((p) => p.id !== id);
    const index = beforeId === null ? rest.length : rest.findIndex((p) => p.id === beforeId);
    rest.splice(index < 0 ? rest.length : index, 0, moving);
    rest.forEach((profile, order) => {
      profile.order = order;
    });
    await this.persist();
  }

  /** Lists profiles with filters and sorting. */
  listFiltered(
    filters: ProfileFilters = {},
    sort: { field?: ProfileSortField; direction?: ProfileSortDirection } = {},
  ): ProfileListing {
    let result = [...this.profiles.values()];

    if (filters.search?.trim()) {
      const query = filters.search.trim().toLowerCase();
      const folderNames = new Map(
        [...this.folders.values()].map((f) => [f.id, f.name.toLowerCase()]),
      );
      result = result.filter(
        (profile) =>
          profile.metadata.name.toLowerCase().includes(query) ||
          (profile.metadata.description ?? "").toLowerCase().includes(query) ||
          profile.tags.some((tag) => tag.toLowerCase().includes(query)) ||
          (profile.folderId
            ? (folderNames.get(profile.folderId) ?? "").includes(query)
            : false),
      );
    }

    if (filters.folderId !== undefined) {
      result = result.filter((p) => p.folderId === filters.folderId);
    }

    if (filters.tags && filters.tags.length > 0) {
      const wanted = filters.tags.map((t) => t.toLowerCase());
      result = result.filter((p) =>
        wanted.every((tag) => p.tags.some((t) => t.toLowerCase() === tag)),
      );
    }

    if (filters.state) {
      result = result.filter((p) => p.state === filters.state);
    }

    if (!filters.includeArchived && filters.state === undefined) {
      result = result.filter((p) => p.state !== "archived");
    }
    if (filters.includeTemporary === false) {
      result = result.filter((p) => p.state !== "temporary");
    }
    if (!filters.includeDeleted && filters.state === undefined) {
      result = result.filter((p) => p.state !== "deleted");
    }

    const total = this.profiles.size;
    const filtered = result.length;

    const field = sort.field ?? "order";
    const direction = sort.direction ?? "asc";
    result.sort((a, b) => {
      let av: string | number;
      let bv: string | number;
      switch (field) {
        case "name":
          av = a.metadata.name.toLowerCase();
          bv = b.metadata.name.toLowerCase();
          break;
        case "createdAt":
          av = a.metadata.createdAt;
          bv = b.metadata.createdAt;
          break;
        case "lastUsedAt":
          av = a.metadata.lastUsedAt ?? 0;
          bv = b.metadata.lastUsedAt ?? 0;
          break;
        case "state":
          av = a.state;
          bv = b.state;
          break;
        case "order":
        default:
          av = a.order;
          bv = b.order;
          break;
      }
      const compared = av < bv ? -1 : av > bv ? 1 : 0;
      return direction === "asc" ? compared : -compared;
    });

    return { profiles: result.map(cloneProfile), total, filtered };
  }

  /** Resolves a name for a copy: "Name copy", "Name copy 2", … within the limit. */
  private uniqueCopyName(base: string): string {
    const suffix = " copy";
    const trimmed = Array.from(base)
      .slice(0, Math.max(1, MAX_PROFILE_NAME - suffix.length - 3))
      .join("");
    let candidate = `${trimmed}${suffix}`;
    let n = 2;
    while (
      [...this.profiles.values()].some(
        (p) => p.metadata.name.toLowerCase() === candidate.toLowerCase(),
      )
    ) {
      candidate = `${trimmed}${suffix} ${n}`;
      n += 1;
    }
    return candidate;
  }

  /** Returns a valid folder ID, or null when the folder does not exist. */
  private validFolderId(raw: unknown): string | null {
    if (typeof raw !== "string" || raw === "") return null;
    return this.folders.has(raw) ? raw : null;
  }

  /** Writes profiles and folders to storage, serialized to keep order. */
  private persist(): Promise<void> {
    const profileSnapshot = [...this.profiles.values()].map(cloneProfile);
    const folderSnapshot = [...this.folders.values()].map((f) => ({ ...f }));
    this.writing = this.writing
      .then(() =>
        this.area.set({
          [PROFILES_KEY]: profileSnapshot,
          [PROFILE_FOLDERS_KEY]: folderSnapshot,
        }),
      )
      .catch(() => {});
    return this.writing;
  }
}

/** Deep-enough copy: profile fields that are objects/arrays are cloned. */
function cloneProfile(profile: Profile): Profile {
  return {
    ...profile,
    metadata: { ...profile.metadata },
    tags: [...profile.tags],
    websiteRules: profile.websiteRules.map((rule) => ({ ...rule })),
    settings: { ...profile.settings },
  };
}

/** Normalizes a list of tags (trim, de-duplicate case-insensitively, cap). */
function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const tags: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const tag = normalizeTag(item);
    if (!tag) continue;
    if (tags.some((t) => t.toLowerCase() === tag.toLowerCase())) continue;
    tags.push(tag);
    if (tags.length >= MAX_PROFILE_TAGS) break;
  }
  return tags;
}

/** Re-exported for callers that only import the manager module. */
export { DEFAULT_PROFILE_SETTINGS };
