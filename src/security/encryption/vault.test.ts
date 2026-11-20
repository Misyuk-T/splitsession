/**
 * Unit tests for `src/security/encryption/vault.ts`.
 * Uses Web Crypto (available in Node 22+ and browsers).
 */

import { describe, expect, it } from "vitest";

import {
  encrypt,
  decrypt,
  createVault,
  unlockVault,
  reencryptVault,
  isValidEntry,
} from "./vault";
import type { VaultEntry } from "./vault";

describe("createVault / unlockVault round-trip", () => {
  it("derives a key from password + salt and can unlock with same salt", async () => {
    const { key, salt } = await createVault("TestPass123!", 10_000);
    expect(key).toBeInstanceOf(CryptoKey);
    expect(typeof salt).toBe("string");

    const unlockedKey = await unlockVault("TestPass123!", salt, 10_000);
    expect(unlockedKey).toBeInstanceOf(CryptoKey);
  });

  it("fails to unlock with wrong password", async () => {
    const { key, salt } = await createVault("CorrectPass123!", 10_000);
    expect(key).toBeInstanceOf(CryptoKey);

    await expect(unlockVault("WrongPass123!", salt, 10_000)).rejects.toThrow();
  });
});

describe("encrypt / decrypt", () => {
  it("encrypts and decrypts round-trip", async () => {
    const { key } = await createVault("VaultPass123!", 10_000);
    const entry = await encrypt("secret data", key);
    expect(entry.ciphertext).toBeTruthy();
    expect(entry.iv).toBeTruthy();
    expect(entry.version).toBe(1);

    const decrypted = await decrypt(entry, key);
    expect(decrypted).toBe("secret data");
  });

  it("fails to decrypt with wrong key", async () => {
    const { key } = await createVault("Pass123!", 10_000);
    const { key: wrongKey } = await createVault("OtherPass123!", 10_000);

    const entry = await encrypt("secret", key);
    await expect(decrypt(entry, wrongKey)).rejects.toThrow();
  });

  it("produces different ciphertext for same plaintext (random IV)", async () => {
    const { key } = await createVault("IVPass123!", 10_000);
    const a = await encrypt("same plaintext", key);
    const b = await encrypt("same plaintext", key);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.iv).not.toBe(b.iv);
  });
});

describe("reencryptVault", () => {
  it("re-encrypts entries with a new password", async () => {
    const { key: oldKey } = await createVault("OldPass123!", 10_000);
    const entry = await encrypt("my secret", oldKey);

    const reencrypted = await reencryptVault([entry], oldKey, "NewPass123!", 10_000);
    expect(reencrypted.length).toBe(1);

    // The new salt travels with each re-encrypted entry; unlock with it.
    const first = reencrypted[0]!;
    const newKey = await unlockVault("NewPass123!", first.salt, 10_000);
    const decrypted = await decrypt(first, newKey);
    expect(decrypted).toBe("my secret");
  });
});

describe("isValidEntry", () => {
  it("validates a well-formed entry", () => {
    const entry: VaultEntry = {
      ciphertext: "abc",
      salt: "def",
      iv: "ghi",
      createdAt: 1000,
      version: 1,
    };
    expect(isValidEntry(entry)).toBe(true);
  });

  it("rejects invalid entries", () => {
    expect(isValidEntry(null)).toBe(false);
    expect(isValidEntry("string")).toBe(false);
    expect(isValidEntry({ ciphertext: "a" })).toBe(false);
    expect(isValidEntry({ ...{ ciphertext: "a", salt: "b", iv: "c", createdAt: 1, version: 2 } as VaultEntry })).toBe(false);
  });
});
