/**
 * Profile Manager — Temporary Profiles (AEGOX_multisession).
 *
 * Temporary profiles have a configurable expiration. When one expires it is
 * never deleted automatically: the configured action is either “notify” (leave
 * it and ask the user) or “archive” (soft-hide it, still recoverable).
 *
 * Pure TypeScript: delegates profile changes to `ProfileManager`.
 *
 * Derived from SplitSession's session lifecycle patterns
 * (https://github.com/Misyuk-T/splitsession, MIT License).
 */

import type {
  Profile,
  ProfileCreateInput,
  ProfileId,
} from "../profile-manager/profile";
import type { ProfileManager } from "../profile-manager/profile-manager";

/** Result of checking expiration status. */
export interface ExpirationStatus {
  /** Whether the profile is expired. */
  expired: boolean;
  /** Time until expiration in ms (0 once expired), or null if not temporary. */
  timeRemainingMs: number | null;
  /** When the profile expires (epoch ms), or null. */
  expiresAt: number | null;
}

/** Options for making a profile temporary. */
export interface TemporaryProfileOptions {
  /** How long until the profile expires (ms, must be > 0). */
  ttlMs: number;
  /** Overrides the profile setting for this expiration. */
  onExpire?: "archive" | "notify";
}

/** Result of sweeping expired temporary profiles. */
export interface ExpirationSweep {
  /** Profiles that expired and were archived. */
  archived: Profile[];
  /** Profiles that expired and need the user's attention. */
  needsAttention: Profile[];
}

/**
 * Manages temporary profiles and their expiration.
 * Expired profiles are not destroyed; the user decides what happens next.
 */
export class TemporaryProfileManager {
  private readonly now: () => number;

  constructor(
    private readonly profileManager: ProfileManager,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  /** Creates a profile and immediately makes it temporary. */
  async create(
    input: ProfileCreateInput,
    options: TemporaryProfileOptions,
  ): Promise<Profile> {
    const ttlMs = validateTtl(options.ttlMs);
    const created = await this.profileManager.create({
      ...input,
      state: "temporary",
      expiresAt: this.now() + ttlMs,
      settings: {
        ...(typeof input.settings === "object" && input.settings !== null
          ? (input.settings as Record<string, unknown>)
          : {}),
        ...(options.onExpire
          ? { temporaryExpiryAction: options.onExpire }
          : {}),
      },
    });
    return created.profile;
  }

  /** Converts an existing profile to temporary. */
  async makeTemporary(
    profileId: ProfileId,
    options: TemporaryProfileOptions,
  ): Promise<Profile> {
    const profile = this.profileManager.get(profileId);
    if (!profile) throw new Error(`Profile "${profileId}" not found.`);
    const ttlMs = validateTtl(options.ttlMs);
    return this.profileManager.update(profileId, {
      state: "temporary",
      expiresAt: this.now() + ttlMs,
      settings: options.onExpire
        ? { temporaryExpiryAction: options.onExpire }
        : undefined,
    });
  }

  /** Checks if a profile is expired. */
  checkExpiration(profile: Profile): ExpirationStatus {
    if (profile.state !== "temporary" || profile.expiresAt === null) {
      return { expired: false, timeRemainingMs: null, expiresAt: null };
    }
    const remaining = profile.expiresAt - this.now();
    return {
      expired: remaining <= 0,
      timeRemainingMs: Math.max(0, remaining),
      expiresAt: profile.expiresAt,
    };
  }

  /** Returns expired temporary profiles from the store. */
  getExpiredProfiles(profiles?: Profile[]): Profile[] {
    const source = profiles ?? this.profileManager.list();
    return source.filter((profile) => this.checkExpiration(profile).expired);
  }

  /** Returns temporary profiles that have not expired yet. */
  getActiveTemporaryProfiles(profiles?: Profile[]): Profile[] {
    const source = profiles ?? this.profileManager.list();
    return source.filter(
      (profile) =>
        profile.state === "temporary" &&
        profile.expiresAt !== null &&
        !this.checkExpiration(profile).expired,
    );
  }

  /** Extends a temporary profile's expiration. */
  async extend(profileId: ProfileId, additionalMs: number): Promise<Profile> {
    const profile = this.profileManager.get(profileId);
    if (!profile) throw new Error(`Profile "${profileId}" not found.`);
    if (profile.state !== "temporary") {
      throw new Error(`Profile "${profileId}" is not temporary.`);
    }
    const extra = validateTtl(additionalMs);
    const base = Math.max(profile.expiresAt ?? this.now(), this.now());
    return this.profileManager.update(profileId, { expiresAt: base + extra });
  }

  /** Converts a temporary profile back to a permanent, active profile. */
  async makePermanent(profileId: ProfileId): Promise<Profile> {
    const profile = this.profileManager.get(profileId);
    if (!profile) throw new Error(`Profile "${profileId}" not found.`);
    return this.profileManager.update(profileId, {
      state: "active",
      expiresAt: null,
    });
  }

  /**
   * Evaluates every temporary profile. Only profiles configured with
   * `temporaryExpiryAction: "archive"` are archived; the rest are reported so
   * the UI can ask the user. Never deletes anything.
   */
  async sweep(): Promise<ExpirationSweep> {
    const archived: Profile[] = [];
    const needsAttention: Profile[] = [];
    for (const profile of this.getExpiredProfiles()) {
      if (profile.settings.temporaryExpiryAction === "archive") {
        archived.push(await this.archiveExpired(profile.id));
      } else {
        needsAttention.push(profile);
      }
    }
    return { archived, needsAttention };
  }

  /** Archives an expired temporary profile on explicit request. */
  async archiveExpired(profileId: ProfileId): Promise<Profile> {
    const profile = this.profileManager.get(profileId);
    if (!profile) throw new Error(`Profile "${profileId}" not found.`);
    return this.profileManager.update(profileId, {
      state: "archived",
      expiresAt: null,
    });
  }
}

/** Validates a TTL: a finite, positive number of milliseconds. */
function validateTtl(ttlMs: number): number {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error("Expiration must be a positive number of milliseconds.");
  }
  return Math.floor(ttlMs);
}
