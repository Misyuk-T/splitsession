/**
 * Session Core — Vault Manager (AEGOX_multisession).
 *
 * Manages encryption vaults for individual profiles. Each profile can have its own
 * independent vault with its own master password.
 *
 * The master password is never stored. Vault entries are stored in the provided
 * StorageAreaLike (e.g. chrome.storage.local).
 *
 * Never logs passwords or plaintext data.
 *
 * Derived from SplitSession's storage patterns
 * (https://github.com/Misyuk-T/splitsession, MIT License).
 */

import type { StorageAreaLike } from "../../engine/storage/storage-area";
import {
  VAULT_VERSION,
  VaultError,
  VaultLockedError,
  VaultCorruptedError,
  createVault,
  unlockVault,
  reencryptVault,
  encrypt,
  decrypt,
  isValidEntry,
} from "../encryption/vault";
import type { VaultEntry } from "../encryption/vault";
import { validatePassword } from "../key-derivation/argon2id";

/**
 * Prefix for the `chrome.storage.local` key that holds a profile's vault
 * metadata (not the key itself). The profile ID is appended so that several
 * independent profile vaults can coexist in one browser profile.
 */
export const VAULT_METADATA_KEY = "sessionVaultMetadata";

/** Separator used between a key prefix and the profile ID. */
export const VAULT_PROFILE_SEPARATOR = ":";

/** `chrome.storage.local` key prefix for vault metadata. */
export const VAULT_METADATA_KEY_PREFIX = `${VAULT_METADATA_KEY}${VAULT_PROFILE_SEPARATOR}`;

/** `chrome.storage.local` key prefix for vault entries (profile ID + timestamp follows). */
export const VAULT_ENTRY_KEY_PREFIX = "sessionVaultEntry:";

/** Metadata about a vault (no secrets stored here). */
export interface VaultMetadata {
  /** Profile ID this vault belongs to. */
  profileId: string;
  /** Salt used for key derivation (base64). Not secret, but needed to unlock. */
  salt: string;
  /** Number of PBKDF2 iterations used. */
  iterations: number;
  /** Vault format version. */
  version: number;
  /** When the vault was created (epoch ms). */
  createdAt: number;
  /** When the vault was last modified (epoch ms). */
  lastModifiedAt: number;
  /** Whether the vault is currently unlocked (key in memory). */
  unlocked: boolean;
  /**
   * AES-GCM encryption of a fixed marker, produced with the derived key.
   * It lets a later unlock prove that the password is correct: a wrong
   * password derives a different key and authentication fails.
   *
   * `null` only for vaults created before this check existed; they get a
   * verifier on their first successful unlock (trust on first use).
   */
  verifier: VaultEntry | null;
}

/** Marker encrypted into the verifier. Not a secret. */
const VAULT_VERIFIER_MARKER = "aegox-multisession-vault-verifier-v1";

/** State of the vault manager. */
export interface VaultManagerState {
  /** Whether a vault exists for the current profile. */
  hasVault: boolean;
  /** Whether the vault is currently unlocked. */
  isUnlocked: boolean;
  /** Profile ID. */
  profileId: string | null;
}

/**
 * Manages encryption vaults per profile.
 * The master password is held in memory only while the vault is unlocked.
 */
export class VaultManager {
  private state: VaultManagerState = {
    hasVault: false,
    isUnlocked: false,
    profileId: null,
  };
  private metadata: VaultMetadata | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly area: StorageAreaLike,
    private readonly profileId: string,
  ) {
    this.state.profileId = profileId;
  }

  /** Loads vault metadata from storage. Does not unlock. */
  async load(): Promise<void> {
    const key = this.metadataKey();
    const stored = (await this.area.get(key))[key];
    if (isVaultMetadata(stored) && stored.profileId === this.profileId) {
      this.metadata = stored;
      this.state.hasVault = true;
      this.state.profileId = this.profileId;
      return;
    }

    // Backward compatibility with Module 02, which stored a single global
    // metadata object. Migrate it to the per-profile key when it matches.
    const legacy = (await this.area.get(VAULT_METADATA_KEY))[VAULT_METADATA_KEY];
    if (isVaultMetadata(legacy) && legacy.profileId === this.profileId) {
      this.metadata = legacy;
      this.state.hasVault = true;
      this.state.profileId = this.profileId;
      await this.area.set({ [key]: { ...legacy } });
    }
  }

  /** Returns the current vault state (no secrets). */
  getState(): VaultManagerState {
    return { ...this.state };
  }

  /** Returns vault metadata (no secrets), or null if no vault exists. */
  getMetadata(): VaultMetadata | null {
    return this.metadata ? { ...this.metadata } : null;
  }

  /**
   * Creates a new vault for this profile with the given master password.
   * Validates the password first. The key is held in memory (unlocked state).
   */
  async createVaultWithPassword(
    password: string,
    iterations: number = 210_000,
  ): Promise<void> {
    if (this.state.hasVault) {
      throw new VaultError("A vault already exists for this profile.");
    }

    const validation = validatePassword(password);
    if (!validation.valid) {
      throw new VaultError(
        `Password does not meet requirements: ${validation.errors.join(" ")}`,
      );
    }

    const { key, salt } = await createVault(password, iterations);
    this.metadata = {
      profileId: this.profileId,
      salt,
      iterations,
      version: VAULT_VERSION,
      createdAt: Date.now(),
      lastModifiedAt: Date.now(),
      unlocked: true,
      verifier: await encrypt(VAULT_VERIFIER_MARKER, key),
    };
    this.state.hasVault = true;
    this.state.isUnlocked = true;

    await this.persistMetadata();
  }

  /**
   * Unlocks an existing vault with the master password.
   * Returns the derived CryptoKey for in-memory encryption/decryption.
   * The key is NOT stored persistently.
   */
  async unlock(password: string): Promise<CryptoKey> {
    if (!this.state.hasVault || !this.metadata) {
      throw new VaultLockedError("No vault exists for this profile.");
    }
    if (this.state.isUnlocked) {
      throw new VaultError("Vault is already unlocked.");
    }

    const key = await unlockVault(password, this.metadata.salt, this.metadata.iterations);
    if (this.metadata.verifier) {
      const correct = await verifies(key, this.metadata.verifier);
      if (!correct) {
        throw new VaultError("Incorrect password.");
      }
    } else {
      // Legacy vault without a verifier: accept this password once and store
      // the verifier so the next unlock is actually checked.
      this.metadata.verifier = await encrypt(VAULT_VERIFIER_MARKER, key);
    }
    this.state.isUnlocked = true;
    this.metadata.unlocked = true;
    await this.persistMetadata();
    return key;
  }

  /** Locks the vault: drops the in-memory key. */
  lock(): void {
    this.state.isUnlocked = false;
    if (this.metadata) this.metadata.unlocked = false;
    // The in-memory key is dropped by not keeping a reference.
    // Callers must discard their CryptoKey reference.
  }

  /** Checks if the vault is unlocked. */
  isUnlocked(): boolean {
    return this.state.isUnlocked;
  }

  /**
   * Changes the master password by re-encrypting all entries with a new key.
   * Requires the vault to be unlocked.
   */
  async changePassword(
    currentKey: CryptoKey,
    newPassword: string,
    iterations: number = 210_000,
  ): Promise<void> {
    if (!this.state.isUnlocked) {
      throw new VaultLockedError("Vault is locked. Unlock before changing password.");
    }

    const validation = validatePassword(newPassword);
    if (!validation.valid) {
      throw new VaultError(
        `New password does not meet requirements: ${validation.errors.join(" ")}`,
      );
    }

    // Load all existing entries.
    const entries = await this.loadAllEntries();

    if (entries.length > 0) {
      const reencrypted = await reencryptVault(entries, currentKey, newPassword, iterations);

      // Save re-encrypted entries.
      for (const entry of reencrypted) {
        await this.saveEntry(entry);
      }

      // Update metadata. The new salt travels with every re-encrypted entry.
      const salt = reencrypted[0]!.salt;
      const newKey = await unlockVault(newPassword, salt, iterations);
      this.metadata = {
        ...this.metadata!,
        salt,
        iterations,
        lastModifiedAt: Date.now(),
        unlocked: true,
        verifier: await encrypt(VAULT_VERIFIER_MARKER, newKey),
      };
    } else {
      // No entries to re-encrypt: create a fresh salt and verifier so the new
      // password can still be verified later.
      const { key, salt } = await createVault(newPassword, iterations);
      this.metadata = {
        ...this.metadata!,
        salt,
        iterations,
        lastModifiedAt: Date.now(),
        unlocked: true,
        verifier: await encrypt(VAULT_VERIFIER_MARKER, key),
      };
    }
    await this.persistMetadata();
  }

  /**
   * Removes the vault and all encrypted entries from storage.
   * Used for password reset: the user is warned that data is unrecoverable.
   */
  async destroyVault(): Promise<void> {
    if (!this.state.hasVault) return;

    // Remove this profile's metadata and every encrypted entry that belongs to
    // it. Never touch entries of another profile.
    const all = await this.area.get(null);
    const prefix = this.entryPrefix();
    const keysToRemove = Object.keys(all).filter((k) => k.startsWith(prefix));
    keysToRemove.push(this.metadataKey());
    await this.area.remove(keysToRemove);

    this.state.hasVault = false;
    this.state.isUnlocked = false;
    this.state.profileId = this.profileId;
    this.metadata = null;
  }

  /** Saves an encrypted vault entry to storage. */
  async saveEntry(entry: VaultEntry): Promise<void> {
    if (!isValidEntry(entry)) {
      throw new VaultCorruptedError("Invalid vault entry.");
    }
    const key = `${this.entryPrefix()}${entry.createdAt}`;
    this.writing = this.writing.then(() =>
      this.area.set({ [key]: entry }).catch(() => {}),
    );
    return this.writing;
  }

  /** Loads all vault entries for this profile. */
  async loadAllEntries(): Promise<VaultEntry[]> {
    const all = await this.area.get(null);
    const prefix = this.entryPrefix();
    return Object.entries(all)
      .filter(([key]) => key.startsWith(prefix))
      .map(([, value]) => value)
      .filter(isValidEntry);
  }

  /** Gets an entry by ID (timestamp). */
  async getEntry(timestamp: number): Promise<VaultEntry | null> {
    const key = `${this.entryPrefix()}${timestamp}`;
    const stored = (await this.area.get(key))[key];
    return isValidEntry(stored) ? stored : null;
  }

  /** Key that holds this profile's vault metadata. */
  private metadataKey(): string {
    return `${VAULT_METADATA_KEY_PREFIX}${this.profileId}`;
  }

  /** Prefix of this profile's encrypted entry keys. */
  private entryPrefix(): string {
    return `${VAULT_ENTRY_KEY_PREFIX}${this.profileId}${VAULT_PROFILE_SEPARATOR}`;
  }

  private async persistMetadata(): Promise<void> {
    if (!this.metadata) return;
    const key = this.metadataKey();
    this.writing = this.writing.then(() =>
      this.area.set({ [key]: { ...this.metadata } }).catch(() => {}),
    );
    return this.writing;
  }
}

/** Structural check for stored vault metadata (untrusted storage input). */
function isVaultMetadata(value: unknown): value is VaultMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.profileId === "string" &&
    typeof v.salt === "string" &&
    typeof v.iterations === "number" &&
    typeof v.version === "number" &&
    typeof v.createdAt === "number" &&
    typeof v.lastModifiedAt === "number" &&
    typeof v.unlocked === "boolean" &&
    (v.verifier === undefined || v.verifier === null || isValidEntry(v.verifier))
  );
}

/**
 * Returns true when `key` decrypts the verifier marker. Any authentication
 * failure (wrong password) is a false result, never an exception.
 */
async function verifies(key: CryptoKey, verifier: VaultEntry): Promise<boolean> {
  try {
    return (await decrypt(verifier, key)) === VAULT_VERIFIER_MARKER;
  } catch {
    return false;
  }
}
