/**
 * Session Core — Key Derivation (AEGOX_multisession).
 *
 * Derives encryption keys from a user-provided master password.
 *
 * Web Crypto API does not provide Argon2id natively. This module uses PBKDF2
 * (available in SubtleCrypto) as the derivation function, which is an established,
 * audited algorithm. Argon2id is the preferred algorithm per the AEGOX specification;
 * if an Argon2id implementation (e.g. via WebAssembly or a trusted library) is
 * added later, this module is the place to swap it in.
 *
 * Never implements custom cryptographic algorithms.
 *
 * Derived from SplitSession's security patterns
 * (https://github.com/Misyuk-T/splitsession, MIT License).
 */

import type { StorageAreaLike } from "../../engine/storage/storage-area";

/** Parameters for key derivation. */
export interface DerivationParams {
  /** The master password (never stored, never logged). */
  password: string;
  /** Random salt, unique per vault. */
  salt: Uint8Array<ArrayBuffer>;
  /** Number of iterations. Higher = slower but more resistant to brute force. */
  iterations: number;
  /** Hash algorithm. */
  hash: "SHA-256" | "SHA-512";
}

/** Recommended minimum iterations for PBKDF2 (OWASP baseline). */
export const RECOMMENDED_ITERATIONS = 210_000;

/** Length of the derived key in bytes (256 bits for AES-256). */
export const KEY_LENGTH_BITS = 256;

/** Length of the salt in bytes. */
export const SALT_LENGTH_BYTES = 16;

/** Errors thrown by key derivation. */
export class KeyDerivationError extends Error {}

/**
 * Generates a cryptographically random salt.
 */
export function generateSalt(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(SALT_LENGTH_BYTES));
}

/**
 * Derives an AES-256 key from a master password using PBKDF2.
 *
 * The derived key is a CryptoKey usable with AES-GCM. The salt must be stored
 * alongside the encrypted data (it is not secret), but the password must never
 * be stored.
 */
export async function deriveKey(
  params: DerivationParams,
): Promise<CryptoKey> {
  const { password, salt, iterations, hash } = params;

  // Import the password as raw key material.
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );

  // Derive an AES-GCM key.
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations,
      hash,
    },
    keyMaterial,
    { name: "AES-GCM", length: KEY_LENGTH_BITS },
    false, // not extractable: the key never leaves the Web Crypto subsystem
    ["encrypt", "decrypt"],
  );
}

/**
 * Validates a master password against AEGOX minimum requirements.
 *
 * Requirements:
 * - At least 10 characters.
 * - At least 2 uppercase letters.
 * - At least 2 numbers.
 * - At least 2 special characters.
 *
 * Returns a strength assessment and any validation errors.
 */
export interface PasswordValidation {
  valid: boolean;
  score: number; // 0-4
  errors: string[];
  feedback: string;
}

/** Special characters (non-alphanumeric). */
const SPECIAL_CHAR_RE = /[^A-Za-z0-9]/g;

/**
 * Validates password strength and AEGOX minimum requirements.
 */
export function validatePassword(
  password: string,
): PasswordValidation {
  const errors: string[] = [];
  let score = 0;

  if (password.length < 10) {
    errors.push("At least 10 characters.");
  } else {
    score += 1;
  }

  const upperCount = (password.match(/[A-Z]/g) || []).length;
  if (upperCount < 2) {
    errors.push("At least 2 uppercase letters.");
  } else {
    score += 1;
  }

  const digitCount = (password.match(/[0-9]/g) || []).length;
  if (digitCount < 2) {
    errors.push("At least 2 numbers.");
  } else {
    score += 1;
  }

  const specialCount = (password.match(SPECIAL_CHAR_RE) || []).length;
  if (specialCount < 2) {
    errors.push("At least 2 special characters.");
  } else {
    score += 1;
  }

  // Bonus for length beyond minimum.
  if (password.length >= 16) score += 1;

  const valid = errors.length === 0;

  let feedback: string;
  if (!valid) {
    feedback = "Password does not meet minimum requirements.";
  } else if (score <= 2) {
    feedback = "Weak password. Consider making it longer and more varied.";
  } else if (score <= 3) {
    feedback = "Moderate password.";
  } else {
    feedback = "Strong password.";
  }

  return { valid, score: Math.min(score, 4), errors, feedback };
}
