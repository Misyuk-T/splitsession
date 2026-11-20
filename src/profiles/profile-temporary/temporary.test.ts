/**
 * Unit tests for `src/profiles/profile-temporary/temporary.ts`.
 * Uses in-memory storage and a controllable clock.
 */

import { describe, expect, it } from "vitest";

import { MemoryStorageArea } from "../../engine/storage/storage-area";
import { ProfileManager } from "../profile-manager/profile-manager";
import { TemporaryProfileManager } from "./temporary";

const make = () => {
  const clock = { now: 1000 };
  const area = new MemoryStorageArea();
  const pm = new ProfileManager(area, { now: () => clock.now });
  const tmp = new TemporaryProfileManager(pm, { now: () => clock.now });
  return { clock, area, pm, tmp };
};

describe("TemporaryProfileManager — creation", () => {
  it("creates a temporary profile with an expiration", async () => {
    const { tmp } = make();
    const profile = await tmp.create({ name: "Temp" }, { ttlMs: 1000 });

    expect(profile.state).toBe("temporary");
    expect(profile.expiresAt).toBe(2000);
    expect(profile.settings.temporaryExpiryAction).toBe("notify");
  });

  it("validates the TTL", async () => {
    const { tmp } = make();
    await expect(tmp.create({ name: "Temp" }, { ttlMs: 0 })).rejects.toThrow(
      /positive number/,
    );
    await expect(
      tmp.create({ name: "Temp" }, { ttlMs: Number.NaN }),
    ).rejects.toThrow(/positive number/);
  });

  it("converts an existing profile to temporary and back", async () => {
    const { tmp, pm } = make();
    const { profile } = await pm.create({ name: "Persistent" });

    const temporary = await tmp.makeTemporary(profile.id, { ttlMs: 500 });
    expect(temporary.state).toBe("temporary");
    expect(temporary.expiresAt).toBe(1500);

    const permanent = await tmp.makePermanent(profile.id);
    expect(permanent.state).toBe("active");
    expect(permanent.expiresAt).toBeNull();
  });
});

describe("TemporaryProfileManager — expiration", () => {
  it("reports remaining time and expiration", async () => {
    const { clock, tmp } = make();
    const profile = await tmp.create({ name: "Temp" }, { ttlMs: 1000 });

    expect(tmp.checkExpiration(profile)).toEqual({
      expired: false,
      timeRemainingMs: 1000,
      expiresAt: 2000,
    });

    clock.now = 2000;
    expect(tmp.checkExpiration(profile).expired).toBe(true);
    expect(tmp.checkExpiration(profile).timeRemainingMs).toBe(0);
  });

  it("ignores profiles that are not temporary", async () => {
    const { pm, tmp } = make();
    const { profile } = await pm.create({ name: "Active" });
    expect(tmp.checkExpiration(profile)).toEqual({
      expired: false,
      timeRemainingMs: null,
      expiresAt: null,
    });
  });

  it("lists expired and still-running temporary profiles", async () => {
    const { clock, tmp } = make();
    const short = await tmp.create({ name: "Short" }, { ttlMs: 500 });
    const long = await tmp.create({ name: "Long" }, { ttlMs: 5000 });

    expect(tmp.getActiveTemporaryProfiles().map((p) => p.id)).toEqual([
      short.id,
      long.id,
    ]);

    clock.now = 2000;
    expect(tmp.getExpiredProfiles().map((p) => p.id)).toEqual([short.id]);
    expect(tmp.getActiveTemporaryProfiles().map((p) => p.id)).toEqual([long.id]);
  });

  it("extends the expiration from the later of now and expiresAt", async () => {
    const { clock, tmp } = make();
    const profile = await tmp.create({ name: "Temp" }, { ttlMs: 1000 });

    clock.now = 1200;
    const extended = await tmp.extend(profile.id, 1000);
    expect(extended.expiresAt).toBe(3000);

    await expect(tmp.extend("missing", 1000)).rejects.toThrow(/not found/);
  });

  it("refuses to extend a profile that is not temporary", async () => {
    const { pm, tmp } = make();
    const { profile } = await pm.create({ name: "Active" });
    await expect(tmp.extend(profile.id, 1000)).rejects.toThrow(/not temporary/);
  });
});

describe("TemporaryProfileManager — sweep", () => {
  it("only reports expired profiles configured to notify", async () => {
    const { clock, pm, tmp } = make();
    const profile = await tmp.create({ name: "Notify" }, { ttlMs: 100 });
    clock.now = 2000;

    const sweep = await tmp.sweep();
    expect(sweep.archived).toHaveLength(0);
    expect(sweep.needsAttention.map((p) => p.id)).toEqual([profile.id]);
    expect(pm.get(profile.id)?.state).toBe("temporary");
  });

  it("archives expired profiles configured to archive", async () => {
    const { clock, pm, tmp } = make();
    const profile = await tmp.create(
      { name: "Archive" },
      { ttlMs: 100, onExpire: "archive" },
    );
    clock.now = 2000;

    const sweep = await tmp.sweep();
    expect(sweep.archived.map((p) => p.id)).toEqual([profile.id]);
    expect(pm.get(profile.id)?.state).toBe("archived");
    expect(pm.get(profile.id)?.expiresAt).toBeNull();
  });

  it("never deletes a profile automatically", async () => {
    const { clock, pm, tmp } = make();
    const profile = await tmp.create({ name: "Temp" }, { ttlMs: 100 });
    clock.now = 1_000_000;
    await tmp.sweep();
    expect(pm.get(profile.id)).toBeDefined();
  });

  it("archives on explicit request", async () => {
    const { pm, tmp } = make();
    const profile = await tmp.create({ name: "Temp" }, { ttlMs: 100 });
    const archived = await tmp.archiveExpired(profile.id);
    expect(archived.state).toBe("archived");
    expect(pm.get(profile.id)?.state).toBe("archived");
  });
});
