import { describe, expect, it } from "vitest";

import { type Cookie, parseSetCookie } from "../../core";
import type { CookieChange } from "./stale-detector";
import {
  pathMatches,
  RecentCookieChanges,
  sameCookie,
  type StaleRequest,
} from "./stale-response";

const T0 = 1_000_000;
const URL_USER = "https://shop.example.com/user/1?check_logged_in=1";
/** Drupal's login answer: the session cookie on the redirect, Domain = the host itself. */
const login: CookieChange = {
  name: "SSESSabc",
  value: "logged-in",
  domain: "shop.example.com",
  hostOnly: false,
  secure: true,
  sameSite: "lax",
  partitioned: false,
  path: "/",
  partitionKey: null,
};
const hop = (over: Partial<StaleRequest> = {}): StaleRequest => ({
  url: URL_USER,
  method: "GET",
  sentAt: T0 + 3,
  cookie: null,
  ...over,
});
const cookie = (header: string, url = URL_USER): Cookie => {
  const parsed = parseSetCookie(header, { url, now: T0 });
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.cookie;
};

function recent() {
  const clock = { now: T0 + 10 };
  const r = new RecentCookieChanges({ now: () => clock.now });
  return { r, clock };
}

describe("pathMatches", () => {
  it("follows RFC 6265 5.1.4", () => {
    expect(pathMatches("/", "/")).toBe(true);
    expect(pathMatches("/user/1", "/")).toBe(true);
    expect(pathMatches("/user/1", "/user")).toBe(true);
    expect(pathMatches("/user", "/user/")).toBe(false);
    expect(pathMatches("/username", "/user")).toBe(false);
    expect(pathMatches("/other", "/user")).toBe(false);
  });
});

describe("sameCookie", () => {
  it("matches the jar identity: name, domain, host-only flag, path, partition", () => {
    const anon = cookie(
      "SSESSabc=anon; path=/; domain=.shop.example.com; secure; HttpOnly",
    );
    expect(sameCookie(login, anon)).toBe(true);
    expect(
      sameCookie(
        login,
        cookie("SSESSabc=anon; path=/; secure"), // host-only: another cookie
      ),
    ).toBe(false);
    expect(
      sameCookie(
        login,
        cookie("SSESSabc=anon; path=/user; domain=.shop.example.com; secure"),
      ),
    ).toBe(false);
    expect(
      sameCookie(
        login,
        cookie("other=1; path=/; domain=.shop.example.com; secure"),
      ),
    ).toBe(false);
    expect(sameCookie({ ...login, path: undefined }, anon)).toBe(false);
  });
});

describe("RecentCookieChanges.missedBy", () => {
  it("reports the cookie a hop sent after the change missed, while its rules are pending", () => {
    const { r } = recent();
    r.open("c1", T0, [login]);
    expect(r.missedBy("c1", hop())).toEqual([login]);
    // An older value of the cookie counts as missing it (Drupal migrates an anonymous session on login).
    expect(r.missedBy("c1", hop({ cookie: "SSESSabc=anon" }))).toEqual([login]);
  });

  it("does not report a hop that carried the new value", () => {
    const { r } = recent();
    r.open("c1", T0, [login]);
    expect(
      r.missedBy("c1", hop({ cookie: "x=1; SSESSabc=logged-in" })),
    ).toEqual([]);
  });

  it("only within [from, rules + lag): earlier requests and requests after the rules settled are answered normally", () => {
    const { r, clock } = recent();
    const handle = r.open("c1", T0, [login]);
    expect(r.missedBy("c1", hop({ sentAt: T0 - 1 }))).toEqual([]); // in flight before the change: real-browser order
    handle.settle(T0 + 20);
    expect(r.missedBy("c1", hop({ sentAt: T0 + 1_019 }))).toEqual([login]);
    expect(r.missedBy("c1", hop({ sentAt: T0 + 1_020 }))).toEqual([]);
    clock.now = T0 + 20 + 1_000 + 10_001; // forgotten after the retention
    expect(r.missedBy("c1", hop({ sentAt: T0 + 5 }))).toEqual([]);
  });

  it("is per container", () => {
    const { r } = recent();
    r.open("c1", T0, [login]);
    expect(r.missedBy("c2", hop())).toEqual([]);
  });

  it("never for non-GET requests (a 307/308 replays the POST; its answer is imported as before)", () => {
    const { r } = recent();
    r.open("c1", T0, [login]);
    expect(r.missedBy("c1", hop({ method: "POST" }))).toEqual([]);
  });

  it("ignores changes the request legitimately goes without: other host, other path, Secure on http, Strict, partitioned", () => {
    const { r } = recent();
    r.open("c1", T0, [
      { ...login, domain: "other.example.com" },
      { ...login, name: "p", path: "/admin" },
      { ...login, name: "s", sameSite: "strict" },
      { ...login, name: "chips", partitioned: true },
    ]);
    expect(r.missedBy("c1", hop())).toEqual([]);
    const { r: r2 } = recent();
    r2.open("c1", T0, [login]);
    expect(
      r2.missedBy("c1", hop({ url: "http://shop.example.com/user/1" })),
    ).toEqual([]);
  });

  it("a deleted cookie that the hop still carried counts as missed (by its previous value)", () => {
    const { r } = recent();
    const deleted = { ...login, value: null, previousValue: "old" };
    r.open("c1", T0, [deleted]);
    expect(r.missedBy("c1", hop({ cookie: "SSESSabc=old" }))).toEqual([
      deleted,
    ]);
    expect(r.missedBy("c1", hop())).toEqual([]);
  });

  it("only the latest change of a cookie counts: a request carrying B after A->B is fresh (rotation, logout)", () => {
    const { r } = recent();
    const a = { ...login, value: "A" };
    const b = { ...login, value: "B" };
    r.open("c1", T0, [a]).settle(T0 + 5);
    r.open("c1", T0 + 100, [b]).settle(T0 + 105);
    expect(
      r.missedBy("c1", hop({ sentAt: T0 + 200, cookie: "SSESSabc=B" })),
    ).toEqual([]);
    // Sent after B without it: stale against B, not A.
    expect(
      r.missedBy("c1", hop({ sentAt: T0 + 200, cookie: "SSESSabc=A" })),
    ).toEqual([b]);
    // Sent between A and B: A was the state then.
    expect(r.missedBy("c1", hop({ sentAt: T0 + 50 }))).toEqual([a]);
    expect(
      r.missedBy("c1", hop({ sentAt: T0 + 50, cookie: "SSESSabc=A" })),
    ).toEqual([]);
  });

  it("a same-name cookie of another identity is no evidence of a missed deletion", () => {
    const { r } = recent();
    // Host-only sid (value h1) deleted; a Domain sid (d1) of the same name lives on.
    const deletedHostOnly = {
      ...login,
      name: "sid",
      hostOnly: true,
      value: null,
      previousValue: "h1",
    };
    r.open("c1", T0, [deletedHostOnly]);
    expect(r.missedBy("c1", hop({ cookie: "sid=d1" }))).toEqual([]);
    expect(r.missedBy("c1", hop({ cookie: "sid=d1; sid=h1" }))).toEqual([
      deletedHostOnly,
    ]);
    // Previous value unknown: ambiguous, the update is allowed.
    r.open("c1", T0 + 1, [{ ...deletedHostOnly, previousValue: undefined }]);
    expect(r.missedBy("c1", hop({ cookie: "sid=h1" }))).toEqual([]);
  });
});
