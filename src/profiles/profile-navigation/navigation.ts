/**
 * Profile Manager — Profile Navigation (AEGOX_multisession).
 *
 * The data behind the three access surfaces required by the module:
 * the extension popup (quick switch list), the dashboard (folder view) and
 * the browser context menu (menu model + click handler). The components and
 * the browser-side registration are intentionally thin: this module contains
 * no `chrome.*` call, so the same logic is testable and reusable.
 *
 * Pure TypeScript: persistence is delegated to a provided `StorageAreaLike`.
 *
 * Derived from SplitSession's popup and API patterns
 * (https://github.com/Misyuk-T/splitsession, MIT License).
 */

import type { StorageAreaLike } from "../../engine/storage/storage-area";
import type { Profile, ProfileId } from "../profile-manager/profile";
import type { ProfileManager } from "../profile-manager/profile-manager";

/** `chrome.storage.local` key holding the active profile ID. */
export const ACTIVE_PROFILE_KEY = "activeProfileId";

/** Prefix for context-menu item IDs owned by this module. */
export const PROFILE_MENU_ID_PREFIX = "aegox-profile:";

/** Parent context-menu item ID. */
export const PROFILE_MENU_PARENT_ID = "aegox-profiles";

/** Result of switching to a profile. */
export interface ProfileSwitchResult {
  ok: boolean;
  profile?: Profile;
  error?: string;
}

/** One context-menu entry for profile switching. */
export interface ContextMenuProfileItem {
  /** Profile ID. */
  profileId: ProfileId;
  /** Display name. */
  title: string;
  /** Whether this is the active profile. */
  active: boolean;
  /** Whether the profile can be switched to (active or temporary). */
  available: boolean;
}

/** A browser-agnostic context-menu tree (Chrome and Firefox both accept this shape). */
export interface ProfileContextMenu {
  id: string;
  title: string;
  contexts: Array<"page" | "action">;
  children: Array<{
    id: string;
    title: string;
    enabled: boolean;
    type: "radio" | "normal";
    checked?: boolean;
  }>;
}

/**
 * Manages the active profile and the navigation models derived from it.
 */
export class ProfileNavigation {
  private activeProfileId: ProfileId | null = null;
  private writing: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  constructor(
    private readonly profileManager: ProfileManager,
    private readonly area: StorageAreaLike,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  /** Loads the persisted active profile; invalid references are cleared. */
  async load(): Promise<void> {
    const stored = (await this.area.get(ACTIVE_PROFILE_KEY))[ACTIVE_PROFILE_KEY];
    if (typeof stored !== "string") {
      this.activeProfileId = null;
      return;
    }
    const profile = this.profileManager.get(stored);
    this.activeProfileId =
      profile && profile.state !== "deleted" && profile.state !== "archived"
        ? profile.id
        : null;
  }

  /** Returns the active profile ID, or null. */
  getActiveProfileId(): ProfileId | null {
    return this.activeProfileId;
  }

  /** Returns the active profile, or undefined. */
  getActiveProfile(): Profile | undefined {
    if (!this.activeProfileId) return undefined;
    return this.profileManager.get(this.activeProfileId);
  }

  /** Sets (and persists) the active profile. Pass null to clear it. */
  async setActiveProfile(profileId: ProfileId | null): Promise<void> {
    if (profileId !== null) {
      const profile = this.profileManager.get(profileId);
      if (!profile) throw new Error(`Profile "${profileId}" not found.`);
      if (profile.state === "archived" || profile.state === "deleted") {
        throw new Error(`Profile "${profileId}" is ${profile.state}.`);
      }
    }
    this.activeProfileId = profileId;
    this.writing = this.writing
      .then(() =>
        profileId === null
          ? this.area.remove(ACTIVE_PROFILE_KEY)
          : this.area.set({ [ACTIVE_PROFILE_KEY]: profileId }),
      )
      .catch(() => {});
    await this.writing;
  }

  /** Switches to a profile, validating availability and recording last use. */
  async switchTo(profileId: ProfileId): Promise<ProfileSwitchResult> {
    const profile = this.profileManager.get(profileId);
    if (!profile) {
      return { ok: false, error: `Profile "${profileId}" not found.` };
    }
    if (profile.state === "archived") {
      return { ok: false, error: `Profile "${profileId}" is archived.` };
    }
    if (profile.state === "deleted") {
      return { ok: false, error: `Profile "${profileId}" is deleted.` };
    }

    try {
      await this.setActiveProfile(profileId);
      const updated = await this.profileManager.touch(profileId);
      return { ok: true, profile: updated };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Context-menu items, with the active profile first. */
  getContextMenuItems(): ContextMenuProfileItem[] {
    return this.profileManager
      .list()
      .filter((profile) => profile.state !== "deleted")
      .map((profile) => ({
        profileId: profile.id,
        title: profile.metadata.name,
        active: profile.id === this.activeProfileId,
        available: profile.state === "active" || profile.state === "temporary",
      }))
      .sort((a, b) => Number(b.active) - Number(a.active));
  }

  /** Compact list for the popup: available profiles, active first. */
  getQuickSwitchProfiles(): Profile[] {
    return this.profileManager
      .list()
      .filter(
        (profile) => profile.state === "active" || profile.state === "temporary",
      )
      .sort(
        (a, b) =>
          Number(b.id === this.activeProfileId) -
          Number(a.id === this.activeProfileId),
      );
  }

  /** Profiles grouped by folder (null = no folder) for the dashboard. */
  getProfilesByFolder(): Map<string | null, Profile[]> {
    const groups = new Map<string | null, Profile[]>();
    for (const profile of this.profileManager.list()) {
      if (profile.state === "deleted") continue;
      const key = profile.folderId ?? null;
      const list = groups.get(key) ?? [];
      list.push(profile);
      groups.set(key, list);
    }
    return groups;
  }

  /** Profiles that have a tag (case-insensitive). */
  getProfilesByTag(tag: string): Profile[] {
    const wanted = tag.trim().toLowerCase();
    if (wanted === "") return [];
    return this.profileManager
      .list()
      .filter((profile) => profile.tags.some((t) => t.toLowerCase() === wanted));
  }

  /** Builds the context-menu tree. Register it with `chrome.contextMenus`. */
  buildContextMenu(): ProfileContextMenu {
    return {
      id: PROFILE_MENU_PARENT_ID,
      title: "Profiles",
      contexts: ["page", "action"],
      children: this.getContextMenuItems().map((item) => ({
        id: `${PROFILE_MENU_ID_PREFIX}${item.profileId}`,
        title: item.title,
        enabled: item.available,
        type: "radio" as const,
        checked: item.active,
      })),
    };
  }

  /** True when a context-menu ID belongs to this module. */
  ownsMenuId(menuItemId: string): boolean {
    return menuItemId.startsWith(PROFILE_MENU_ID_PREFIX);
  }

  /** Handles a context-menu click. Returns null for IDs this module does not own. */
  async handleContextMenuClick(
    menuItemId: string,
  ): Promise<ProfileSwitchResult | null> {
    if (!this.ownsMenuId(menuItemId)) return null;
    const profileId = menuItemId.slice(PROFILE_MENU_ID_PREFIX.length);
    if (profileId === "") return { ok: false, error: "Empty profile ID." };
    return this.switchTo(profileId);
  }

  /** Records the current time for callers that build their own models. */
  nowMs(): number {
    return this.now();
  }
}
