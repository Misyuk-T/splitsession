/**
 * Unit tests for `src/profiles/profile-protection/protection.ts`.
 * Uses the real AES-GCM / PBKDF2 vault with low iteration counts for speed.
 */

import { describe, expect, it } from "vitest";

import {
  LOCKOUT_MS,
  MAX_FAILED_ATTEMPTS,
  ProfileProtection,
} from "./protection";
import { VaultManager } from "../../security/vault/vault-manager";
import { MemoryStorageArea } from "../../engine/storage/storage-area";

const PASSWORD = "CorrectPass123!?";
const WRONG = "WrongPass456!?";
const ITERATIONS = 1000;

const profile = (overrides: Partial<{ id: string; hasIndependentPassword: boolean; state: string }> = {}) => ({
  id: "profile-1",
  hasIndependentPassword: false,
  state: "active",
  ...overrides,
});

const masterSetup = async (now = 1000) => {
  const area = new MemoryStorageArea();
  const vault = new VaultManager(area, "master");
  await vault.createVaultWithPassword(PASSWORD, ITERATIONS);
  vault.lock();

  const protection = new ProfileProtection(true, { now: () => now });
  protection.setMasterVault(vault);
  return { area, vault, protection };
};

describe("ProfileProtection — modes", () => {
  it("reports no protection when no master password and no independent password", () => {
    const protection = new ProfileProtection(false);
    const check = protection.checkProtection(profile());
    expect(check.protected).toBe(false);
    expect(check.mode).toBe("none");
    expect(check.requiresPassword).toBe(false);
    expect(protection.unlock(profile(), "")).resolves.toEqual({
      ok: true,
      lockedOut: false,
    });
  });

  it("uses the master mode when the global password is configured", () => {
    const protection = new ProfileProtection(true);
    const check = protection.checkProtection(profile());
    expect(check.mode).toBe("master");
    expect(check.locked).toBe(true);
    expect(check.requiresPassword).toBe(true);
  });

  it("prefers the independent mode for profiles that have their own password", () => {
    const protection = new ProfileProtection(true);
    const check = protection.checkProtection(profile({ hasIndependentPassword: true }));
    expect(check.mode).toBe("independent");
  });

  it("flags deleted profiles as locked with a reason", () => {
    const protection = new ProfileProtection(true);
    const check = protection.checkProtection(profile({ state: "deleted" }));
    expect(check.locked).toBe(true);
    expect(check.reason).toContain("deleted");
  });
});

describe("ProfileProtection — master vault", () => {
  it("unlocks with the correct password and reports the state", async () => {
    const { protection } = await masterSetup();
    const result = await protection.unlock(profile(), PASSWORD);
    expect(result.ok).toBe(true);
    expect(protection.checkProtection(profile()).locked).toBe(false);
    expect(protection.isMasterPasswordSet()).toBe(true);
  });

  it("rejects a wrong password without unlocking", async () => {
    const { protection } = await masterSetup();
    const result = await protection.unlock(profile(), WRONG);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Incorrect password.");
    expect(protection.checkProtection(profile()).locked).toBe(true);
  });

  it("rejects an empty password", async () => {
    const { protection } = await masterSetup();
    const result = await protection.unlock(profile(), "");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Enter the password");
  });

  it("reports a missing vault instead of pretending to unlock", async () => {
    const protection = new ProfileProtection(true);
    const result = await protection.unlock(profile(), PASSWORD);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("No master vault");
  });

  it("locks the master vault again", async () => {
    const { protection, vault } = await masterSetup();
    await protection.unlock(profile(), PASSWORD);
    expect(vault.isUnlocked()).toBe(true);

    protection.lock();
    expect(protection.checkProtection(profile()).locked).toBe(true);
    expect(vault.isUnlocked()).toBe(false);
  });

  it(`locks out after ${MAX_FAILED_ATTEMPTS} wrong attempts and recovers after the timeout`, async () => {
    let now = 1000;
    const { protection } = await masterSetup(now);

    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      const attempt = await protection.unlock(profile(), WRONG);
      expect(attempt.ok).toBe(false);
    }

    const blocked = await protection.unlock(profile(), PASSWORD);
    expect(blocked.lockedOut).toBe(true);
    const check = protection.checkProtection(profile());
    expect(check.locked).toBe(true);
    expect(check.reason).toContain("Too many failed attempts");

    now += LOCKOUT_MS + 1;
    const recovered = await protection.unlock(profile(), PASSWORD);
    expect(recovered.ok).toBe(true);
  });

  it("clears failed attempts after a successful unlock", async () => {
    const { protection } = await masterSetup();
    await protection.unlock(profile(), WRONG);
    await protection.unlock(profile(), PASSWORD);
    await protection.unlock(profile(), WRONG);

    const check = protection.checkProtection(profile());
    expect(check.locked).toBe(true);
    expect(check.reason).toBeUndefined();
  });
});

describe("ProfileProtection — independent vault", () => {
  it("uses the profile's own vault, not the master vault", async () => {
    const area = new MemoryStorageArea();
    const profileVault = new VaultManager(area, "profile-1");
    await profileVault.createVaultWithPassword(PASSWORD, ITERATIONS);
    profileVault.lock();

    const masterVault = new VaultManager(area, "master");
    await masterVault.createVaultWithPassword("MasterPass123!?", ITERATIONS);
    masterVault.lock();

    const protection = new ProfileProtection(true);
    protection.setMasterVault(masterVault);
    protection.setProfileVault("profile-1", profileVault);

    const target = profile({ hasIndependentPassword: true });
    expect((await protection.unlock(target, PASSWORD)).ok).toBe(true);
    expect(protection.checkProtection(target).locked).toBe(false);

    protection.lock(target);
    expect(protection.checkProtection(target).locked).toBe(true);
  });

  it("rejects a wrong independent password", async () => {
    const area = new MemoryStorageArea();
    const vault = new VaultManager(area, "profile-1");
    await vault.createVaultWithPassword(PASSWORD, ITERATIONS);
    vault.lock();

    const protection = new ProfileProtection(false);
    protection.setProfileVault("profile-1", vault);

    const target = profile({ hasIndependentPassword: true });
    expect((await protection.unlock(target, WRONG)).ok).toBe(false);
    expect(protection.checkProtection(target).locked).toBe(true);
  });

  it("reports a missing independent vault", async () => {
    const protection = new ProfileProtection(false);
    const target = profile({ hasIndependentPassword: true });
    const result = await protection.unlock(target, PASSWORD);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("No independent vault");
  });

  it("forgets a removed profile vault", async () => {
    const { protection } = await masterSetup();
    protection.markUnlocked(profile());
    expect(protection.checkProtection(profile()).locked).toBe(false);

    protection.removeProfileVault("profile-1");
    expect(protection.checkProtection(profile({ hasIndependentPassword: true })).locked).toBe(
      true,
    );
  });
});
