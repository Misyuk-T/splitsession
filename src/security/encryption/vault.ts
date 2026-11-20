/**
 * Session Core — Encryption Vault (AEGOX_multisession).
 *
 * Authenticated encryption using AES-256-GCM (Web Crypto SubtleCrypto).
 * Never implements custom cryptographic algorithms.
 *
 * The master password is never stored. The encryption key is derived from the
 * password via PBKDF2 (see key-derivation/argon2id.ts) and held in memory only.
 *
 * Derived from SplitSession's security patterns
 * (https://github.com/Misyuk-T/splitsession, MIT License).
 */

import {
  deriveKey,
  generateSalt,
} from "../key-derivation/argon2id";
import type { KeyDerivationError } from "../key-derivation/argon2id";

/** An encrypted vault entry: ciphertext + metadata (salt, iv, etc.). */
export interface VaultEntry {
  /** Base64-encoded ciphertext (AES-256-GCM output). */
  ciphertext: string;
  /** Base64-encoded salt used for key derivation. */
  salt: string;
  /** Base64-encoded IV (nonce) used for encryption. Unique per operation. */
  iv: string;
  /** When this entry was created (epoch ms). */
  createdAt: number;
  /** Version of the vault format. */
  version: number;
}

/** Errors thrown by the vault. */
export class VaultError extends Error {}
export class VaultLockedError extends VaultError {}
export class VaultCorruptedError extends VaultError {}

/** Vault format version. */
export const VAULT_VERSION = 1;

/** Size of the GCM IV (nonce) in bytes. */
export const IV_LENGTH_BYTES = 12;

/** Additional authenticated data (AAD) bound to the vault entry. */
const VAULT_AAD = new TextEncoder().encode("AEGOX_multisession-vault-v1");

/**
 * Encrypts a plaintext string using a derived key.
 * Returns a VaultEntry with salt and IV stored alongside the ciphertext.
 */
export async function encrypt(
  plaintext: string,
  key: CryptoKey,
): Promise<VaultEntry> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH_BYTES));
  const encoded = new TextEncoder().encode(plaintext);

  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: VAULT_AAD },
    key,
    encoded,
  );

  return {
    ciphertext: arrayBufferToBase64(ciphertextBuffer),
    salt: "", // salt is managed at the key-derivation level; stored per vault
    iv: arrayBufferToBase64(iv),
    createdAt: Date.now(),
    version: VAULT_VERSION,
  };
}

/**
 * Decrypts a VaultEntry back to plaintext using a derived key.
 */
export async function decrypt(
  entry: VaultEntry,
  key: CryptoKey,
): Promise<string> {
  const iv = base64ToBytes(entry.iv);
  const ciphertext = base64ToBytes(entry.ciphertext);

  const plaintextBuffer = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: VAULT_AAD },
    key,
    ciphertext,
  );

  return new TextDecoder().decode(plaintextBuffer);
}

/**
 * Creates a new vault: derives a key from the password and returns both the key
 * (for in-memory use) and the salt (to store alongside encrypted data).
 */
export async function createVault(
  password: string,
  iterations: number = 210_000,
): Promise<{ key: CryptoKey; salt: string }> {
  const salt = generateSalt();
  const key = await deriveKey({
    password,
    salt,
    iterations,
    hash: "SHA-256",
  });
  return {
    key,
    salt: arrayBufferToBase64(salt),
  };
}

/**
 * Re-derives a key from an existing password and salt (for unlocking an existing vault).
 */
export async function unlockVault(
  password: string,
  saltBase64: string,
  iterations: number = 210_000,
): Promise<CryptoKey> {
  const salt = base64ToBytes(saltBase64);
  return deriveKey({
    password,
    salt,
    iterations,
    hash: "SHA-256",
  });
}

/** Re-encrypts all entries with a new password (password change / re-encryption). */
export async function reencryptVault(
  entries: VaultEntry[],
  oldKey: CryptoKey,
  newPassword: string,
  iterations: number = 210_000,
): Promise<VaultEntry[]> {
  const newVault = await createVault(newPassword, iterations);
  const newKey = newVault.key;

  const reencrypted: VaultEntry[] = [];
  for (const entry of entries) {
    const plaintext = await decrypt(entry, oldKey);
    const reEncrypted = await encrypt(plaintext, newKey);
    reencrypted.push({
      ...reEncrypted,
      salt: newVault.salt,
    });
  }
  return reencrypted;
}

/** Checks whether a vault entry is valid (correct version, fields present). */
export function isValidEntry(entry: unknown): entry is VaultEntry {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry))
    return false;
  const e = entry as Record<string, unknown>;
  return (
    typeof e.ciphertext === "string" &&
    typeof e.salt === "string" &&
    typeof e.iv === "string" &&
    typeof e.createdAt === "number" &&
    typeof e.version === "number" &&
    e.version === VAULT_VERSION
  );
}

/** Converts binary data to base64 (no padding issues for storage). */
function arrayBufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

/** Converts base64 to bytes (ArrayBuffer-backed, as SubtleCrypto requires). */
function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
