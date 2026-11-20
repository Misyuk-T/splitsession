/**
 * Profile Manager — Profile Protection (AEGOX_multisession).
 *
 * Protects profiles with the global master password or with an optional
 * independent profile password. The actual key derivation and authenticated
 * encryption live in Module 02 (`security/vault`, AES-256-GCM + PBKDF2 via
 * Web Crypto). This module only decides *whether* a profile is locked and
 * tracks failed unlock attempts. It never stores or logs a password.
 *
 * Derived from SplitSession's security patterns
 * (https://github.com/Misyuk-T/splitsession, MIT License).
 */

import type { VaultManager } from "../../security/vault/vault-manager";

/** Protection mode for a profile. */
export type ProfileProtectionMode = "none" | "master" | "independent";

/** Result of a protection check. */
export interface ProtectionCheck {
  /** Whether the profile has protection configured. */
  protected: boolean;
  /** Whether a password is required right now. */
  locked: boolean;
  /** The protection mode configured. */
  mode: ProfileProtectionMode;
  /** Whether the user needs to provide a password now. */
  requiresPassword: boolean;
  /** Reason if protection cannot be applied or is temporarily locked out. */
  reason?: string;
}

/** Result of unlocking a profile. */
export interface UnlockResult {
  /** Whether unlocking succeeded. */
  ok: boolean;
  /** Error message if unlocking failed. */
  error?: string;
  /** Whether the account is temporarily locked out. */
  lockedOut: boolean;
}

/** Maximum failed attempts before a temporary lockout. */
export const MAX_FAILED_ATTEMPTS = 5;

/** Lockout duration in ms (15 minutes). */
export const LOCKOUT_MS = 15 * 60 * 1000;

/** Minimal profile shape needed to decide protection. */
export interface ProtectableProfile {
  id: string;
  hasIndependentPassword: boolean;
  state: string;
}

interface FailedAttempts {
  count: number;
  lockedUntil: number | null;
}

/** Key used for the global master vault in the in-memory maps. */
const MASTER_KEY = "master";

/**
 * Manages profile protection state. Encryption is delegated to `VaultManager`;
 * this class keeps no password and no derived key.
 */
export class ProfileProtection {
  private masterVault: VaultManager | null = null;
  private readonly profileVaults = new Map<string, VaultManager>();
  private readonly unlocked = new Set<string>();
  private readonly failedAttempts = new Map<string, FailedAttempts>();
  private readonly now: () => number;

  constructor(
    private readonly globalMasterPasswordSet: boolean = false,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  /** Registers the vault protected by the global master password. */
  setMasterVault(vault: VaultManager): void {
    this.masterVault = vault;
  }

  /** Registers a vault protected by a profile's independent password. */
  setProfileVault(profileId: string, vault: VaultManager): void {
    this.profileVaults.set(profileId, vault);
  }

  /** Forgets a profile's independent vault (e.g. after deleting the profile). */
  removeProfileVault(profileId: string): void {
    this.profileVaults.delete(profileId);
    this.unlocked.delete(profileId);
    this.failedAttempts.delete(profileId);
  }

  /** Returns the configured protection mode for a profile. */
  getProtectionMode(profile: ProtectableProfile): ProfileProtectionMode {
    if (profile.hasIndependentPassword) return "independent";
    if (this.globalMasterPasswordSet) return "master";
    return "none";
  }

  /** Checks whether a profile is protected and whether it is currently locked. */
  checkProtection(profile: ProtectableProfile): ProtectionCheck {
    const mode = this.getProtectionMode(profile);
    if (mode === "none") {
      return { protected: false, locked: false, mode, requiresPassword: false };
    }
    if (profile.state === "deleted") {
      return {
        protected: true,
        locked: true,
        mode,
        requiresPassword: true,
        reason: "This profile is marked as deleted.",
      };
    }

    const key = this.keyFor(profile, mode);
    const failure = this.failedAttempts.get(key);
    if (failure?.lockedUntil && this.now() < failure.lockedUntil) {
      const minutes = Math.ceil((failure.lockedUntil - this.now()) / 60_000);
      return {
        protected: true,
        locked: true,
        mode,
        requiresPassword: true,
        reason: `Too many failed attempts. Try again in ${minutes} minute(s).`,
      };
    }

    const locked = !this.unlocked.has(key);
    return { protected: true, locked, mode, requiresPassword: locked };
  }

  /**
   * Attempts to unlock a profile.
   *
   * The password is verified by the corresponding `VaultManager`; this method
   * never compares passwords itself and never logs them.
   */
  async unlock(
    profile: ProtectableProfile,
    password: string,
  ): Promise<UnlockResult> {
    const mode = this.getProtectionMode(profile);
    if (mode === "none") {
      return { ok: true, lockedOut: false };
    }

    const key = this.keyFor(profile, mode);
    const failure = this.failedAttempts.get(key);
    if (failure?.lockedUntil && this.now() < failure.lockedUntil) {
      return {
        ok: false,
        error: "Account temporarily locked due to too many failed attempts.",
        lockedOut: true,
      };
    }

    if (typeof password !== "string" || password === "") {
      return { ok: false, error: "Enter the password.", lockedOut: false };
    }

    const vault =
      mode === "independent"
        ? this.profileVaults.get(profile.id) ?? null
        : this.masterVault;
    if (!vault) {
      return {
        ok: false,
        error:
          mode === "independent"
            ? "No independent vault is available for this profile."
            : "No master vault is available.",
        lockedOut: false,
      };
    }

    try {
      // VaultManager refuses to unlock an already-unlocked vault, so lock it
      // first. It retains no key, therefore this does not weaken the check.
      if (vault.isUnlocked()) vault.lock();
      await vault.unlock(password);
      this.unlocked.add(key);
      this.failedAttempts.delete(key);
      return { ok: true, lockedOut: false };
    } catch (error) {
      const current = this.failedAttempts.get(key) ?? {
        count: 0,
        lockedUntil: null,
      };
      current.count += 1;
      if (current.count >= MAX_FAILED_ATTEMPTS) {
        current.lockedUntil = this.now() + LOCKOUT_MS;
      }
      this.failedAttempts.set(key, current);

      const lockedOut = current.count >= MAX_FAILED_ATTEMPTS;
      return {
        ok: false,
        error: lockedOut
          ? "Too many failed attempts. The profile is temporarily locked."
          : error instanceof Error &&
              /no vault|already unlocked/i.test(error.message)
            ? error.message
            : "Incorrect password.",
        lockedOut,
      };
    }
  }

  /** Locks one profile, or the master vault when no profile is given. */
  lock(profile?: ProtectableProfile): void {
    if (profile) {
      const mode = this.getProtectionMode(profile);
      if (mode === "none") return;
      const key = this.keyFor(profile, mode);
      this.unlocked.delete(key);
      if (mode === "independent") this.profileVaults.get(profile.id)?.lock();
      else this.masterVault?.lock();
      return;
    }
    this.unlocked.clear();
    this.masterVault?.lock();
    for (const vault of this.profileVaults.values()) vault.lock();
  }

  /** Clears failed-attempt records (e.g. after a successful password change). */
  clearFailedAttempts(): void {
    this.failedAttempts.clear();
  }

  /** Returns whether the global master password is configured. */
  isMasterPasswordSet(): boolean {
    return this.globalMasterPasswordSet;
  }

  /** Marks a profile as unlocked after a successful vault creation. */
  markUnlocked(profile?: ProtectableProfile): void {
    if (!profile) {
      this.unlocked.add(MASTER_KEY);
      return;
    }
    const mode = this.getProtectionMode(profile);
    if (mode !== "none") this.unlocked.add(this.keyFor(profile, mode));
  }

  private keyFor(
    profile: ProtectableProfile,
    mode: ProfileProtectionMode,
  ): string {
    return mode === "independent" ? profile.id : MASTER_KEY;
  }
}
