import { describe, expect, it } from "vitest";

import type { Cookie } from "../types";
import {
  defaultPath,
  MAX_COOKIE_LIFETIME_MS,
  type ParseContext,
  parseCookieDate,
  type ParseRejection,
  parseSetCookie,
} from "./set-cookie-parser";

const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

const ctx = (
  url = "https://www.example.com/a/b",
  extra: Partial<ParseContext> = {},
): ParseContext => ({
  url,
  now: NOW,
  ...extra,
});

function parseOk(header: string, context: ParseContext = ctx()): Cookie {
  const result = parseSetCookie(header, context);
  if (!result.ok)
    throw new Error(
      `expected "${header.slice(0, 80)}" to parse, got ${result.reason}`,
    );
  return result.cookie;
}

function rejection(
  header: string,
  context: ParseContext = ctx(),
): ParseRejection {
  const result = parseSetCookie(header, context);
  if (result.ok)
    throw new Error(`expected "${header.slice(0, 80)}" to be rejected`);
  return result.reason;
}

describe("name and value", () => {
  it("parses a bare name=value as a host-only session cookie", () => {
    expect(parseOk("sid=abc123")).toEqual({
      name: "sid",
      value: "abc123",
      domain: "www.example.com",
      hostOnly: true,
      path: "/a",
      secure: false,
      httpOnly: false,
      sameSite: "unspecified",
      partitioned: false,
      partitionKey: null,
      expires: null,
      creationTime: NOW,
    });
  });

  it('splits only at the first "=" and keeps "=" inside the value', () => {
    const c = parseOk("token=a=b==; Path=/");
    expect([c.name, c.value]).toEqual(["token", "a=b=="]);
  });

  it("trims surrounding whitespace", () => {
    const c = parseOk("  k \t=  v v  ; Path=/");
    expect([c.name, c.value]).toEqual(["k", "v v"]);
  });

  it("accepts an empty value", () => {
    const c = parseOk("flag=");
    expect([c.name, c.value]).toEqual(["flag", ""]);
  });

  it('accepts nameless cookies ("foo" and "=foo")', () => {
    expect(parseOk("foo")).toMatchObject({ name: "", value: "foo" });
    expect(parseOk("=foo")).toMatchObject({ name: "", value: "foo" });
  });

  it.each(["", ";", "=", " ; Path=/"])(
    "rejects an empty cookie: %j",
    (header) => {
      expect(rejection(header)).toBe("empty");
    },
  );

  it("rejects control characters but tolerates tabs", () => {
    expect(rejection("a=b\u0001c")).toBe("control-characters");
    expect(rejection("a=b\nSet-Cookie: x=y")).toBe("control-characters");
    expect(rejection("a=b\u007f")).toBe("control-characters");
    expect(parseOk("a=b\tc").value).toBe("b\tc");
  });

  it("enforces the 4096-octet name+value limit", () => {
    expect(parseOk(`a=${"x".repeat(4095)}`).value).toHaveLength(4095); // 1 + 4095 = 4096
    expect(rejection(`a=${"x".repeat(4096)}`)).toBe("too-long");
  });

  it("rejects an unparseable request URL", () => {
    expect(rejection("a=b", ctx("not a url"))).toBe("invalid-url");
  });
});

describe("attributes", () => {
  it("matches attribute names case-insensitively", () => {
    const c = parseOk(
      "a=b; SECURE; httponly; SameSite=STRICT; PATH=/x; DoMaIn=Example.COM",
    );
    expect(c).toMatchObject({
      secure: true,
      httpOnly: true,
      sameSite: "strict",
      path: "/x",
      domain: "example.com",
    });
  });

  it("ignores unknown attributes and stray semicolons", () => {
    expect(parseOk("a=b;;  ; Priority=High; Foo=bar;")).toMatchObject({
      name: "a",
      value: "b",
    });
  });

  it("ignores attribute values longer than 1024 octets", () => {
    const c = parseOk(`a=b; Path=/${"p".repeat(1030)}`);
    expect(c.path).toBe("/a");
  });

  it.each([
    ["Strict", "strict"],
    ["lax", "lax"],
    ["None", "none"],
    ["Bogus", "unspecified"],
    ["", "unspecified"],
  ])("SameSite=%s -> %s", (value, expected) => {
    expect(
      parseOk(`a=b; Secure; SameSite=${value}`, ctx("https://example.com/"))
        .sameSite,
    ).toBe(expected);
  });

  it("records a missing SameSite as unspecified", () => {
    expect(parseOk("a=b").sameSite).toBe("unspecified");
  });

  it("rejects SameSite=None without Secure", () => {
    expect(rejection("a=b; SameSite=None")).toBe(
      "samesite-none-requires-secure",
    );
  });
});

describe("path", () => {
  it.each([
    ["/", "/"],
    ["/a", "/"],
    ["/a/", "/a"],
    ["/a/b", "/a"],
    ["/a/b/c.html", "/a/b"],
    ["", "/"],
  ])("default-path of %j is %s", (requestPath, expected) => {
    expect(defaultPath(requestPath)).toBe(expected);
  });

  it("uses the default path when Path is absent, empty or not absolute", () => {
    expect(parseOk("a=b", ctx("https://example.com/x/y/z")).path).toBe("/x/y");
    expect(parseOk("a=b; Path=", ctx("https://example.com/x/y/z")).path).toBe(
      "/x/y",
    );
    expect(
      parseOk("a=b; Path=rel", ctx("https://example.com/x/y/z")).path,
    ).toBe("/x/y");
    expect(
      parseOk("a=b; Path=/explicit", ctx("https://example.com/x/y/z")).path,
    ).toBe("/explicit");
  });

  it("lets the last Path attribute win", () => {
    expect(parseOk("a=b; Path=/one; Path=/two").path).toBe("/two");
  });
});

describe("Domain", () => {
  it("strips the leading dot and makes the cookie a domain cookie", () => {
    const c = parseOk("a=b; Domain=.example.com");
    expect(c).toMatchObject({ domain: "example.com", hostOnly: false });
  });

  it("is host-only when the attribute is absent or empty", () => {
    expect(parseOk("a=b")).toMatchObject({
      domain: "www.example.com",
      hostOnly: true,
    });
    expect(parseOk("a=b; Domain=")).toMatchObject({
      domain: "www.example.com",
      hostOnly: true,
    });
  });

  it("accepts a Domain equal to the request host as a domain cookie", () => {
    expect(parseOk("a=b; Domain=www.example.com")).toMatchObject({
      domain: "www.example.com",
      hostOnly: false,
    });
  });

  it("rejects domains that do not domain-match the request host", () => {
    expect(rejection("a=b; Domain=other.com")).toBe("invalid-domain");
    expect(rejection("a=b; Domain=api.example.com")).toBe("invalid-domain"); // sibling
    expect(rejection("a=b; Domain=ww.example.com")).toBe("invalid-domain");
    expect(
      rejection("a=b; Domain=xexample.com", ctx("https://example.com/")),
    ).toBe("invalid-domain");
    expect(rejection("a=b; Domain=sub.www.example.com")).toBe("invalid-domain"); // child
  });

  it("rejects malformed domains", () => {
    expect(rejection("a=b; Domain=exa mple.com")).toBe("invalid-domain");
    expect(rejection("a=b; Domain=example.com:8080")).toBe("invalid-domain");
    expect(rejection("a=b; Domain=.")).toBe("invalid-domain");
  });

  it.each([
    ["com", "https://www.example.com/"],
    [".com", "https://www.example.com/"],
    ["co.uk", "https://www.example.co.uk/"],
    ["github.io", "https://user.github.io/"],
    ["localhost", "http://a.localhost/"],
  ])("rejects the public suffix %s", (domain, url) => {
    expect(rejection(`a=b; Domain=${domain}`, ctx(url))).toBe("public-suffix");
  });

  it("turns a public-suffix Domain equal to the host into a host-only cookie", () => {
    expect(
      parseOk("a=b; Domain=localhost", ctx("http://localhost/")),
    ).toMatchObject({
      domain: "localhost",
      hostOnly: true,
    });
  });

  it("only accepts an identical Domain for IP hosts", () => {
    expect(
      parseOk("a=b; Domain=127.0.0.1", ctx("http://127.0.0.1:3000/")),
    ).toMatchObject({
      domain: "127.0.0.1",
      hostOnly: true,
    });
    expect(rejection("a=b; Domain=0.0.1", ctx("http://10.0.0.1/"))).toBe(
      "invalid-domain",
    );
  });

  it("punycodes internationalised domains", () => {
    const c = parseOk(
      "a=b; Domain=bücher.example",
      ctx("https://www.xn--bcher-kva.example/"),
    );
    expect(c.domain).toBe("xn--bcher-kva.example");
  });

  it("lets the last valid Domain attribute win", () => {
    expect(
      parseOk("a=b; Domain=example.com; Domain=www.example.com").domain,
    ).toBe("www.example.com");
  });
});

describe("Expires and Max-Age", () => {
  it("is a session cookie without either attribute", () => {
    expect(parseOk("a=b").expires).toBeNull();
  });

  it("parses an IMF-fixdate Expires", () => {
    expect(parseOk("a=b; Expires=Wed, 09 Jun 2027 10:18:14 GMT").expires).toBe(
      Date.UTC(2027, 5, 9, 10, 18, 14),
    );
  });

  it("turns Max-Age into an absolute time", () => {
    expect(parseOk("a=b; Max-Age=3600").expires).toBe(NOW + 3600 * 1000);
  });

  it("lets Max-Age win over Expires regardless of order", () => {
    const expires = "Expires=Wed, 09 Jun 2027 10:18:14 GMT";
    expect(parseOk(`a=b; ${expires}; Max-Age=60`).expires).toBe(NOW + 60_000);
    expect(parseOk(`a=b; Max-Age=60; ${expires}`).expires).toBe(NOW + 60_000);
  });

  it.each(["0", "-1", "-99999"])(
    "Max-Age=%s marks the cookie as expired",
    (value) => {
      const c = parseOk(
        `a=b; Max-Age=${value}; Expires=Wed, 09 Jun 2027 10:18:14 GMT`,
      );
      expect(c.expires).not.toBeNull();
      expect(c.expires!).toBeLessThanOrEqual(NOW);
    },
  );

  it.each(["abc", "1.5", "+5", "", "10s"])(
    "ignores an invalid Max-Age %j",
    (value) => {
      expect(
        parseOk(`a=b; Max-Age=${value}; Expires=Wed, 09 Jun 2027 10:18:14 GMT`)
          .expires,
      ).toBe(Date.UTC(2027, 5, 9, 10, 18, 14));
    },
  );

  it("keeps a past Expires as expired", () => {
    const c = parseOk("a=b; Expires=Thu, 01 Jan 1970 00:00:01 GMT");
    expect(c.expires!).toBeLessThanOrEqual(NOW);
  });

  it("ignores an unparseable Expires", () => {
    expect(parseOk("a=b; Expires=tomorrow-ish").expires).toBeNull();
  });

  it("caps the lifetime at 400 days", () => {
    expect(parseOk(`a=b; Max-Age=${10 * 365 * 86400}`).expires).toBe(
      NOW + MAX_COOKIE_LIFETIME_MS,
    );
    expect(parseOk("a=b; Expires=Fri, 31 Dec 9999 23:59:59 GMT").expires).toBe(
      NOW + 400 * DAY,
    );
    expect(parseOk(`a=b; Max-Age=${30 * 86400}`).expires).toBe(NOW + 30 * DAY);
  });
});

describe("parseCookieDate (RFC 6265 5.1.1)", () => {
  const june = Date.UTC(2021, 5, 9, 10, 18, 14);

  it.each([
    ["Wed, 09 Jun 2021 10:18:14 GMT", june], // RFC 1123
    ["Wednesday, 09-Jun-21 10:18:14 GMT", june], // RFC 850, two-digit year
    ["Wed Jun  9 10:18:14 2021", june], // asctime
    ["9 jun 2021 10:18:14", june],
    ["10:18:14 JUN 9 2021", june], // token order does not matter
    ["Wed, 09 Jun 2021 10:18:14 +0000 (UTC)", june],
  ])("%s", (input, expected) => {
    expect(parseCookieDate(input)).toBe(expected);
  });

  it("maps two-digit years: 70-99 -> 19xx, 00-69 -> 20xx", () => {
    expect(parseCookieDate("01 Jan 70 00:00:00")).toBe(Date.UTC(1970, 0, 1));
    expect(parseCookieDate("01 Jan 99 00:00:00")).toBe(Date.UTC(1999, 0, 1));
    expect(parseCookieDate("01 Jan 00 00:00:00")).toBe(Date.UTC(2000, 0, 1));
    expect(parseCookieDate("01 Jan 69 00:00:00")).toBe(Date.UTC(2069, 0, 1));
  });

  it.each([
    ["missing time", "09 Jun 2021"],
    ["missing day", "Jun 2021 10:18:14"],
    ["missing month", "09 2021 10:18:14"],
    ["missing year", "09 Jun 10:18:14"],
    ["day 0", "00 Jun 2021 10:18:14"],
    ["day 32", "32 Jun 2021 10:18:14"],
    ["hour 24", "09 Jun 2021 24:18:14"],
    ["minute 60", "09 Jun 2021 10:60:14"],
    ["second 60", "09 Jun 2021 10:18:60"],
    ["year before 1601", "09 Jun 1600 10:18:14"],
    ["garbage", "not a date"],
    ["empty", ""],
  ])("fails on %s", (_label, input) => {
    expect(parseCookieDate(input)).toBeNull();
  });
});

describe("Secure", () => {
  it("is accepted from https", () => {
    expect(parseOk("a=b; Secure", ctx("https://example.com/")).secure).toBe(
      true,
    );
  });

  it("is rejected from plain http (leave secure cookies alone)", () => {
    expect(rejection("a=b; Secure", ctx("http://example.com/"))).toBe(
      "secure-from-insecure-origin",
    );
  });

  it("is accepted from http on localhost-like hosts, as in Chrome", () => {
    expect(parseOk("a=b; Secure", ctx("http://a.localhost:3000/")).secure).toBe(
      true,
    );
    expect(parseOk("a=b; Secure", ctx("http://localhost/")).secure).toBe(true);
  });
});

describe("Partitioned (CHIPS)", () => {
  const secure = "https://example.com/";

  it("records the partition key from the context", () => {
    const c = parseOk(
      "a=b; Secure; Partitioned",
      ctx(secure, { topLevelSite: "https://top.test" }),
    );
    expect(c).toMatchObject({
      partitioned: true,
      partitionKey: "https://top.test",
    });
  });

  it("leaves the key null when the top-level site is unknown (such a cookie never matches)", () => {
    expect(parseOk("a=b; Secure; Partitioned", ctx(secure))).toMatchObject({
      partitioned: true,
      partitionKey: null,
    });
  });

  it("does not partition ordinary cookies", () => {
    expect(
      parseOk("a=b; Secure", ctx(secure, { topLevelSite: "https://top.test" }))
        .partitionKey,
    ).toBeNull();
  });

  it("requires Secure", () => {
    expect(rejection("a=b; Partitioned", ctx(secure))).toBe(
      "partitioned-requires-secure",
    );
  });
});

describe("cookie name prefixes", () => {
  const root = "https://www.example.com/";

  it("__Secure- requires Secure", () => {
    expect(rejection("__Secure-id=1")).toBe("prefix-violation");
    expect(parseOk("__Secure-id=1; Secure").name).toBe("__Secure-id");
  });

  it("matches prefixes case-insensitively", () => {
    expect(rejection("__SECURE-id=1")).toBe("prefix-violation");
    expect(rejection("__host-id=1", ctx(root))).toBe("prefix-violation");
    expect(parseOk("__hOsT-id=1; Secure; Path=/", ctx(root)).name).toBe(
      "__hOsT-id",
    );
  });

  it("__Host- requires Secure, no Domain and Path=/", () => {
    expect(parseOk("__Host-id=1; Secure; Path=/", ctx(root))).toMatchObject({
      hostOnly: true,
      path: "/",
    });
    expect(rejection("__Host-id=1; Path=/", ctx(root))).toBe(
      "prefix-violation",
    ); // not Secure
    expect(
      rejection("__Host-id=1; Secure; Path=/; Domain=example.com", ctx(root)),
    ).toBe("prefix-violation");
    expect(
      rejection(
        "__Host-id=1; Secure; Path=/; Domain=www.example.com",
        ctx(root),
      ),
    ).toBe("prefix-violation");
    expect(rejection("__Host-id=1; Secure; Path=/app", ctx(root))).toBe(
      "prefix-violation",
    );
  });

  it('__Host- accepts the default path when it is "/"', () => {
    expect(parseOk("__Host-id=1; Secure", ctx(root)).path).toBe("/");
    expect(
      rejection("__Host-id=1; Secure", ctx("https://www.example.com/a/b")),
    ).toBe("prefix-violation");
  });

  it("applies prefixes to the value of nameless cookies", () => {
    expect(rejection("__Secure-x")).toBe("prefix-violation");
    expect(rejection("=__Host-x; Secure; Path=/app", ctx(root))).toBe(
      "prefix-violation",
    );
  });

  it("does not touch names that merely contain a prefix", () => {
    expect(parseOk("x__Secure-id=1").name).toBe("x__Secure-id");
    expect(parseOk("_Secure-id=1").name).toBe("_Secure-id");
  });
});

describe("script writes (document.cookie)", () => {
  it("rejects an HttpOnly attribute from script", () => {
    expect(
      rejection(
        "a=b; HttpOnly",
        ctx("https://example.com/", { fromScript: true }),
      ),
    ).toBe("httponly-from-script");
    expect(parseOk("a=b; HttpOnly", ctx("https://example.com/")).httpOnly).toBe(
      true,
    );
  });
});
