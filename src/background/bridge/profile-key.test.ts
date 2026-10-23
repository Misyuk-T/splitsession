import { describe, expect, it } from "vitest";

import { PROFILE_KEY_RE } from "../../bridge/protocol";
import { MemoryStorageArea } from "../../engine/storage/storage-area";
import {
  newProfileKey,
  PROFILE_KEY_KEY,
  readProfileKey,
  renewProfileKey,
} from "./profile-key";

describe("profile key", () => {
  it("is 10 characters a-z0-9 from the CSPRNG, and differs each time", () => {
    const keys = new Set(Array.from({ length: 200 }, () => newProfileKey()));
    expect(keys.size).toBe(200);
    for (const k of keys) {
      expect(k).toMatch(/^[a-z0-9]{10}$/);
      expect(PROFILE_KEY_RE.test(k)).toBe(true);
    }
  });

  it("skips bytes that would bias the alphabet (252-255)", () => {
    let call = 0;
    const key = newProfileKey((b) => {
      call += 1;
      // First batch: only bytes to skip, then two usable ones per batch.
      b.fill(call === 1 ? 255 : 0);
      if (call > 1) b[0] = 35;
      return b;
    });
    expect(key).toBe("9aaaaaaaaa");
    expect(call).toBe(2);
  });

  it("is made once and stored; later reads give the same key", async () => {
    const area = new MemoryStorageArea();
    const first = await readProfileKey(area);
    expect((await area.get(PROFILE_KEY_KEY))[PROFILE_KEY_KEY]).toBe(first);
    expect(await readProfileKey(area)).toBe(first);
  });

  it("a malformed stored key is replaced; renew stores a new one", async () => {
    const area = new MemoryStorageArea();
    await area.set({ [PROFILE_KEY_KEY]: "../../etc" });
    const key = await readProfileKey(area);
    expect(key).toMatch(/^[a-z0-9]{10}$/);
    const renewed = await renewProfileKey(area);
    expect(renewed).not.toBe(key);
    expect(await readProfileKey(area)).toBe(renewed);
  });
});
