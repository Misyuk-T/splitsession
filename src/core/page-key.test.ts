import { createHash, createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  base32,
  bytesToHex,
  createPageKeyCache,
  hexToBytes,
  hmacSha256,
  PAGE_KEY_PATTERN,
  pageKey,
  sha256,
} from "./page-key";

const enc = (s: string) => new TextEncoder().encode(s);
const hex = (b: Uint8Array) => bytesToHex(b);

describe("sha256 / hmac", () => {
  it("matches known vectors and Node for many lengths", () => {
    expect(hex(sha256(enc("")))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(hex(sha256(enc("abc")))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    for (let n = 0; n < 200; n += 7) {
      const data = randomBytes(n);
      expect(hex(sha256(data))).toBe(
        createHash("sha256").update(data).digest("hex"),
      );
    }
  });

  it("HMAC matches RFC 4231 case 2 and Node, short and long keys", () => {
    expect(
      hex(hmacSha256(enc("Jefe"), enc("what do ya want for nothing?"))),
    ).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
    for (const keyLength of [1, 32, 64, 65, 131]) {
      const key = randomBytes(keyLength);
      const msg = randomBytes(77);
      expect(hex(hmacSha256(key, msg))).toBe(
        createHmac("sha256", key).update(msg).digest("hex"),
      );
    }
  });
});

describe("page keys", () => {
  const secret = new Uint8Array(32).fill(7);
  it("are 16 lowercase base32 characters, stable, and differ per site, container and secret", () => {
    const a = pageKey(secret, "abc123", "a.example");
    expect(a).toMatch(PAGE_KEY_PATTERN);
    expect(pageKey(secret, "abc123", "a.example")).toBe(a);
    expect(pageKey(secret, "abc123", "b.example")).not.toBe(a);
    expect(pageKey(secret, "abc124", "a.example")).not.toBe(a);
    expect(pageKey(new Uint8Array(32).fill(8), "abc123", "a.example")).not.toBe(
      a,
    );
    expect(a).not.toContain("abc123");
  });

  it("cache returns the same keys", () => {
    const key = createPageKeyCache(secret, 2);
    expect(key("x", "a.example")).toBe(pageKey(secret, "x", "a.example"));
    key("y", "a.example");
    key("z", "a.example");
    expect(key("x", "a.example")).toBe(pageKey(secret, "x", "a.example"));
  });

  it("base32 and hex helpers", () => {
    expect(base32(enc("foobar"))).toBe("mzxw6ytboi");
    expect(hexToBytes("00ff10")).toEqual(new Uint8Array([0, 255, 16]));
    expect(hexToBytes("0g")).toBeNull();
  });
});
