import { describe, expect, it } from "vitest";

import type { Cookie } from "../types";
import { CookieJar, cookieKey, serializeCookieHeader } from "./cookie-jar";

const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

function cookie(overrides: Partial<Cookie> = {}): Cookie {
  return {
    name: "sid",
    value: "1",
    domain: "example.com",
    hostOnly: true,
    path: "/",
    secure: false,
    httpOnly: false,
    sameSite: "unspecified",
    partitioned: false,
    partitionKey: null,
    expires: null,
    creationTime: NOW,
    ...overrides,
  };
}

/** Feeds Set-Cookie headers through the real parser, the way the engine will. */
function jarFrom(url: string, ...headers: string[]): CookieJar {
  const jar = new CookieJar();
  for (const header of headers) {
    const { parsed } = jar.setFromHeader(header, { url, now: NOW });
    if (!parsed.ok) throw new Error(`"${header}" rejected: ${parsed.reason}`);
  }
  return jar;
}

const names = (cookies: Cookie[]) => cookies.map((c) => c.name);

describe("upsert", () => {
  it("adds, then reports an identical re-send as unchanged", () => {
    const jar = new CookieJar();
    expect(jar.upsert(cookie(), { now: NOW })).toBe("added");
    expect(jar.upsert(cookie(), { now: NOW })).toBe("unchanged");
    expect(jar.size).toBe(1);
  });

  it("replaces by identity and keeps the original creation time", () => {
    const jar = new CookieJar();
    jar.upsert(cookie({ value: "old", creationTime: 100 }), { now: NOW });
    expect(
      jar.upsert(cookie({ value: "new", creationTime: 999 }), { now: NOW }),
    ).toBe("updated");
    expect(jar.all()).toMatchObject([{ value: "new", creationTime: 100 }]);
  });

  it("treats name, domain, path, host-only flag and partition key as identity", () => {
    const base = cookie();
    const variants: Partial<Cookie>[] = [
      { name: "other" },
      { domain: "other.com" },
      { path: "/x" },
      { hostOnly: false },
      { partitioned: true, secure: true, partitionKey: "https://top.test" },
    ];
    const keys = new Set([
      cookieKey(base),
      ...variants.map((v) => cookieKey(cookie(v))),
    ]);
    expect(keys.size).toBe(variants.length + 1);

    const jar = new CookieJar([base, ...variants.map((v) => cookie(v))]);
    expect(jar.size).toBe(variants.length + 1);
  });

  it("deletes the stored cookie when an expired one arrives (Max-Age <= 0)", () => {
    const jar = jarFrom("https://example.com/", "sid=1", "other=2");
    const result = jar.setFromHeader("sid=gone; Max-Age=0", {
      url: "https://example.com/",
      now: NOW,
    });
    expect(result.outcome).toBe("deleted");
    expect(names(jar.all())).toEqual(["other"]);
  });

  it("deletes via a past Expires and ignores deleting what does not exist", () => {
    const jar = jarFrom("https://example.com/", "sid=1");
    const past = "Expires=Thu, 01 Jan 1970 00:00:00 GMT";
    expect(
      jar.setFromHeader(`sid=x; ${past}`, {
        url: "https://example.com/",
        now: NOW,
      }).outcome,
    ).toBe("deleted");
    expect(
      jar.setFromHeader(`sid=x; ${past}`, {
        url: "https://example.com/",
        now: NOW,
      }).outcome,
    ).toBe("ignored");
    expect(jar.size).toBe(0);
  });

  it("does not delete a cookie of a different path or host-only flag", () => {
    const jar = jarFrom("https://example.com/a/b", "sid=1; Path=/a");
    jar.setFromHeader("sid=; Path=/other; Max-Age=0", {
      url: "https://example.com/a/b",
      now: NOW,
    });
    jar.setFromHeader("sid=; Path=/a; Domain=example.com; Max-Age=0", {
      url: "https://example.com/a/b",
      now: NOW,
    });
    expect(jar.size).toBe(1);
  });

  it("ignores rejected headers without touching the jar", () => {
    const jar = new CookieJar();
    const result = jar.setFromHeader("a=b; Domain=other.com", {
      url: "https://example.com/",
      now: NOW,
    });
    expect(result).toMatchObject({
      parsed: { ok: false, reason: "invalid-domain" },
      outcome: "ignored",
    });
    expect(jar.size).toBe(0);
  });

  it("returns copies, never live references", () => {
    const jar = new CookieJar();
    const original = cookie();
    jar.upsert(original, { now: NOW });
    original.value = "mutated";
    jar.all()[0]!.value = "mutated too";
    expect(jar.all()[0]!.value).toBe("1");
  });
});

describe("purgeExpired and hosts", () => {
  it("purges only expired cookies", () => {
    const jar = new CookieJar([
      cookie({ name: "session" }),
      cookie({ name: "live", expires: NOW + HOUR }),
      cookie({ name: "dead", expires: NOW - HOUR }),
      cookie({ name: "edge", expires: NOW }),
    ]);
    expect(jar.purgeExpired(NOW)).toBe(2);
    expect(names(jar.all()).sort()).toEqual(["live", "session"]);
  });

  it("hosts() lists distinct, sorted domains with unexpired cookies", () => {
    const jar = new CookieJar([
      cookie({ name: "a", domain: "www.example.com" }),
      cookie({ name: "b", domain: "www.example.com", path: "/x" }),
      cookie({ name: "c", domain: "example.com", hostOnly: false }),
      cookie({ name: "d", domain: "gone.com", expires: NOW - 1 }),
    ]);
    expect(jar.hosts(NOW)).toEqual(["example.com", "www.example.com"]);
  });
});

describe("cookiesForHost", () => {
  const opts = { secure: true, now: NOW };

  it("sends host-only cookies to exactly that host", () => {
    const jar = jarFrom("https://www.example.com/", "hostonly=1");
    expect(names(jar.cookiesForHost("www.example.com", opts))).toEqual([
      "hostonly",
    ]);
    expect(jar.cookiesForHost("example.com", opts)).toEqual([]);
    expect(jar.cookiesForHost("api.www.example.com", opts)).toEqual([]);
    expect(jar.cookiesForHost("other.example.com", opts)).toEqual([]);
  });

  it("sends domain cookies to the domain and its subdomains", () => {
    const jar = jarFrom(
      "https://www.example.com/",
      "wide=1; Domain=example.com",
    );
    for (const host of [
      "example.com",
      "www.example.com",
      "deep.sub.example.com",
    ]) {
      expect(names(jar.cookiesForHost(host, opts))).toEqual(["wide"]);
    }
    expect(jar.cookiesForHost("badexample.com", opts)).toEqual([]);
    expect(jar.cookiesForHost("example.org", opts)).toEqual([]);
  });

  it("matches hosts case-insensitively", () => {
    const jar = jarFrom("https://www.example.com/", "a=1");
    expect(names(jar.cookiesForHost("WWW.Example.COM", opts))).toEqual(["a"]);
  });

  it("holds Secure cookies back on insecure requests", () => {
    const jar = jarFrom("https://example.com/", "plain=1", "locked=2; Secure");
    expect(
      names(jar.cookiesForHost("example.com", { secure: false, now: NOW })),
    ).toEqual(["plain"]);
    expect(
      names(
        jar.cookiesForHost("example.com", { secure: true, now: NOW }),
      ).sort(),
    ).toEqual(["locked", "plain"]);
  });

  it("skips expired cookies", () => {
    const jar = new CookieJar([
      cookie({ name: "ok", expires: NOW + HOUR }),
      cookie({ name: "old", expires: NOW - HOUR }),
    ]);
    expect(names(jar.cookiesForHost("example.com", opts))).toEqual(["ok"]);
  });

  it("works for localhost-style test hosts", () => {
    const jar = jarFrom(
      "http://a.localhost:3000/",
      "sid=1; HttpOnly",
      "tok=2; Secure",
    );
    expect(
      names(jar.cookiesForHost("a.localhost", { secure: true, now: NOW })),
    ).toEqual(["sid", "tok"]);
    expect(jar.cookiesForHost("sso.localhost", opts)).toEqual([]);
  });

  it("only includes partitioned cookies for their own top-level site", () => {
    const jar = new CookieJar([
      cookie({ name: "plain" }),
      cookie({
        name: "chips",
        secure: true,
        partitioned: true,
        partitionKey: "https://top.test",
      }),
    ]);
    expect(names(jar.cookiesForHost("example.com", opts))).toEqual(["plain"]);
    expect(
      names(
        jar.cookiesForHost("example.com", {
          ...opts,
          topLevelSite: "https://other.test",
        }),
      ),
    ).toEqual(["plain"]);
    expect(
      names(
        jar.cookiesForHost("example.com", {
          ...opts,
          topLevelSite: "https://top.test",
        }),
      ),
    ).toEqual(["plain", "chips"]);
  });

  it("keeps same-named partitioned and unpartitioned cookies apart", () => {
    const jar = new CookieJar([
      cookie({ value: "free" }),
      cookie({
        value: "a",
        secure: true,
        partitioned: true,
        partitionKey: "https://a.test",
      }),
      cookie({
        value: "b",
        secure: true,
        partitioned: true,
        partitionKey: "https://b.test",
      }),
    ]);
    expect(jar.size).toBe(3);
    expect(
      jar
        .cookiesForHost("example.com", {
          ...opts,
          topLevelSite: "https://b.test",
        })
        .map((c) => c.value),
    ).toEqual(["free", "b"]);
  });

  it("orders by longer path first, then earlier creation (RFC 6265 5.4)", () => {
    const jar = new CookieJar([
      cookie({ name: "newer-root", path: "/", creationTime: 300 }),
      cookie({ name: "deep", path: "/a/b/c", creationTime: 400 }),
      cookie({ name: "older-root", path: "/", creationTime: 100 }),
      cookie({ name: "mid", path: "/a", creationTime: 500 }),
    ]);
    expect(names(jar.cookiesForHost("example.com", opts))).toEqual([
      "deep",
      "mid",
      "older-root",
      "newer-root",
    ]);
  });

  it("lets two cookies with the same name coexist for one host (host-only vs domain), longer path first", () => {
    const jar = jarFrom(
      "https://www.example.com/app/page",
      "dup=host-only; Path=/app",
      "dup=domain; Domain=example.com; Path=/",
    );
    expect(
      jar.cookiesForHost("www.example.com", opts).map((c) => c.value),
    ).toEqual(["host-only", "domain"]);
    expect(
      jar.cookiesForHost("api.example.com", opts).map((c) => c.value),
    ).toEqual(["domain"]);
  });
});

describe("serializeCookieHeader", () => {
  it('joins name=value pairs with "; "', () => {
    expect(
      serializeCookieHeader([
        cookie({ name: "a", value: "1" }),
        cookie({ name: "b", value: "x=y" }),
      ]),
    ).toBe("a=1; b=x=y");
  });

  it('sends nameless cookies as the bare value and empty values as "name="', () => {
    expect(
      serializeCookieHeader([
        cookie({ name: "", value: "foo" }),
        cookie({ name: "e", value: "" }),
      ]),
    ).toBe("foo; e=");
  });

  it("is empty for no cookies", () => {
    expect(serializeCookieHeader([])).toBe("");
  });
});

describe("document.cookie", () => {
  const opts = { secure: true, now: NOW };

  it("hides HttpOnly cookies from the read view but not from the network view", () => {
    const jar = jarFrom(
      "https://example.com/",
      "visible=1",
      "secret=2; HttpOnly",
      "also=3",
    );
    expect(jar.documentCookieString("example.com", opts)).toBe(
      "visible=1; also=3",
    );
    expect(serializeCookieHeader(jar.cookiesForHost("example.com", opts))).toBe(
      "visible=1; secret=2; also=3",
    );
  });

  it("applies the same host, Secure and expiry filters", () => {
    const jar = jarFrom(
      "https://www.example.com/",
      "host=1",
      "tls=2; Secure",
      "wide=3; Domain=example.com",
    );
    expect(
      jar.documentCookieString("www.example.com", { secure: false, now: NOW }),
    ).toBe("host=1; wide=3");
    expect(jar.documentCookieString("api.example.com", opts)).toBe("wide=3");
  });

  describe("applyDocumentCookieWrite", () => {
    it("stores a cookie that the page then reads back", () => {
      const jar = new CookieJar();
      const { outcome } = jar.applyDocumentCookieWrite(
        "example.com",
        "theme=dark; Path=/",
        { secure: true, now: NOW },
      );
      expect(outcome).toBe("added");
      expect(jar.documentCookieString("example.com", opts)).toBe("theme=dark");
    });

    it("uses the document path for the default path", () => {
      const jar = new CookieJar();
      jar.applyDocumentCookieWrite("example.com", "a=1", {
        secure: true,
        path: "/docs/page",
        now: NOW,
      });
      expect(jar.all()[0]).toMatchObject({
        path: "/docs",
        hostOnly: true,
        httpOnly: false,
      });
    });

    it("honours Domain, Max-Age and expiry deletion", () => {
      const jar = new CookieJar();
      jar.applyDocumentCookieWrite(
        "www.example.com",
        "a=1; Domain=example.com; Max-Age=3600",
        { secure: true, now: NOW },
      );
      expect(jar.all()[0]).toMatchObject({
        domain: "example.com",
        hostOnly: false,
        expires: NOW + 3600_000,
      });
      const { outcome } = jar.applyDocumentCookieWrite(
        "www.example.com",
        "a=; Domain=example.com; Max-Age=0",
        {
          secure: true,
          now: NOW,
        },
      );
      expect(outcome).toBe("deleted");
      expect(jar.size).toBe(0);
    });

    it("rejects strings carrying HttpOnly instead of creating an HttpOnly cookie", () => {
      const jar = new CookieJar();
      const { parsed, outcome } = jar.applyDocumentCookieWrite(
        "example.com",
        "a=1; HttpOnly",
        { secure: true, now: NOW },
      );
      expect(parsed).toEqual({ ok: false, reason: "httponly-from-script" });
      expect(outcome).toBe("ignored");
      expect(jar.size).toBe(0);
    });

    it("cannot overwrite or delete an HttpOnly cookie set by the server", () => {
      const jar = jarFrom("https://example.com/", "sid=server; HttpOnly");
      expect(
        jar.applyDocumentCookieWrite("example.com", "sid=hijacked", {
          secure: true,
          now: NOW,
        }).outcome,
      ).toBe("ignored");
      expect(
        jar.applyDocumentCookieWrite("example.com", "sid=; Max-Age=0", {
          secure: true,
          now: NOW,
        }).outcome,
      ).toBe("ignored");
      expect(jar.all()).toMatchObject([{ value: "server", httpOnly: true }]);
    });

    it("applies the parser rules: public suffix, foreign domain, Secure over http", () => {
      const jar = new CookieJar();
      const write = (value: string, secure = true) =>
        jar.applyDocumentCookieWrite("www.example.com", value, {
          secure,
          now: NOW,
        }).parsed;
      expect(write("a=1; Domain=com")).toEqual({
        ok: false,
        reason: "public-suffix",
      });
      expect(write("a=1; Domain=other.com")).toEqual({
        ok: false,
        reason: "invalid-domain",
      });
      expect(write("a=1; Secure", false)).toEqual({
        ok: false,
        reason: "secure-from-insecure-origin",
      });
      expect(jar.size).toBe(0);
    });

    it("wraps IPv6 hosts correctly", () => {
      const jar = new CookieJar();
      const { outcome } = jar.applyDocumentCookieWrite("::1", "a=1", {
        secure: false,
        now: NOW,
      });
      expect(outcome).toBe("added");
      expect(jar.hosts(NOW)).toEqual(["::1"]);
    });
  });
});

describe("JSON round trip", () => {
  it("serialises and restores every cookie field", () => {
    const jar = new CookieJar([
      cookie({
        name: "a",
        httpOnly: true,
        sameSite: "lax",
        expires: NOW + HOUR,
      }),
      cookie({
        name: "b",
        secure: true,
        partitioned: true,
        partitionKey: "https://top.test",
      }),
    ]);
    const restored = CookieJar.fromJSON(JSON.parse(JSON.stringify(jar)));
    expect(restored.all()).toEqual(jar.all());
    expect(restored.toJSON().version).toBe(1);
  });

  it("survives garbage from storage", () => {
    for (const bad of [
      null,
      undefined,
      42,
      "x",
      [],
      {},
      { version: 2, cookies: [] },
      { version: 1, cookies: "no" },
    ]) {
      expect(CookieJar.fromJSON(bad).size).toBe(0);
    }
  });

  it("skips malformed entries but keeps valid ones", () => {
    const good = cookie({ name: "good" });
    const restored = CookieJar.fromJSON({
      version: 1,
      cookies: [
        good,
        { ...good, sameSite: "sideways" },
        { ...good, name: 5 },
        null,
        "cookie",
        { ...good, expires: "soon" },
      ],
    });
    expect(names(restored.all())).toEqual(["good"]);
  });
});
