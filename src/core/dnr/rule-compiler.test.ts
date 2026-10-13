import { describe, expect, it } from "vitest";

import { CookieJar } from "../jar/cookie-jar";
import type { BeaconPayload } from "../types";
import { cookieHeaderFor, simulate, urlFilterToRegExp } from "./dnr-simulator";
import {
  ALL_RESOURCE_TYPES,
  BEACON_COOKIE_BYTE_LIMIT,
  BEACON_PRIORITY,
  BEACON_URL,
  BEACON_URL_FILTER,
  CATCH_ALL_PRIORITY,
  compileGroupRules,
  compileManagedBeaconRule,
  compileManagedWorkerScriptRule,
  compileNoTabRule,
  compileNoTabWorkerScriptRule,
  compileStrictGuardRule,
  compileTabRules,
  createSequentialAllocator,
  type DnrRule,
  exactHostRegex,
  exactHostRulePriority,
  hostRulePriority,
  INSECURE_PRIORITY_BASE,
  insecureExactHostRulePriority,
  insecureHostRulePriority,
  isOverSoftLimit,
  MANAGED_BEACON_PRIORITY,
  type RuleIdAllocator,
  SESSION_RULE_HARD_LIMIT,
  SESSION_RULE_SOFT_LIMIT,
  STRICT_GUARD_PRIORITY,
  TAB_ID_NONE,
  totalRuleCount,
} from "./rule-compiler";

const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);
const TAB = 42;

function jarFrom(
  entries: [url: string, ...headers: string[]][],
  topLevelSite?: string,
): CookieJar {
  const jar = new CookieJar();
  for (const [url, ...headers] of entries) {
    for (const header of headers) {
      const { parsed } = jar.setFromHeader(header, {
        url,
        now: NOW,
        topLevelSite,
      });
      if (!parsed.ok) throw new Error(`"${header}" rejected: ${parsed.reason}`);
    }
  }
  return jar;
}

/** Stand-in for the HMAC page key: visibly per (container, site), and never just the container ID. */
const keyOf = (containerId: string) => (site: string) =>
  `key(${containerId},${site})`;

function compile(
  jar: CookieJar,
  extra: {
    topLevelSite?: string | null;
    tabIds?: number[];
    containerId?: string;
    containerName?: string;
    regexBudget?: number;
    frameSites?: string[];
  } = {},
) {
  const containerId = extra.containerId ?? "alt";
  return compileGroupRules(
    {
      tabIds: extra.tabIds ?? [TAB],
      containerId,
      containerName: extra.containerName,
      jar,
      topLevelSite: extra.topLevelSite,
      now: NOW,
      regexBudget: extra.regexBudget,
      pageKeyOf: keyOf(containerId),
      frameSites: extra.frameSites,
    },
    createSequentialAllocator(),
  );
}

/**
 * Cookie header of a request from tab TAB (or `tabId`) to `url`. Same-site by default (initiated by the URL's own
 * origin); pass `initiator: null` for a browser-initiated request, or another origin for a cross-site one.
 */
const sent = (
  rules: DnrRule[],
  url: string,
  tabId = TAB,
  type = "main_frame",
  initiator: string | null = new URL(url).origin,
  method = "get",
) =>
  cookieHeaderFor(rules, {
    url,
    tabId,
    type,
    initiator: initiator ?? undefined,
    method,
  });

const beaconFor = (
  rules: DnrRule[],
  initiator?: string,
  tabId = TAB,
): BeaconPayload | null => {
  const outcome = simulate(rules, {
    url: `${BEACON_URL}?r=1`,
    tabId,
    type: "xmlhttprequest",
    initiator,
  });
  if (outcome.kind !== "redirect") return null;
  const prefix = "data:application/json,";
  expect(outcome.url.startsWith(prefix)).toBe(true);
  return JSON.parse(
    decodeURIComponent(outcome.url.slice(prefix.length)),
  ) as BeaconPayload;
};

/** Two hosts of the e2e stand: plain http on a trustworthy .localhost origin. */
const localJar = () =>
  jarFrom([
    [
      "http://a.localhost:3000/",
      "sid=aaa; HttpOnly; Path=/",
      "theme=dark; Domain=a.localhost",
    ],
    ["http://sso.localhost:3000/", "sso=zzz; Path=/"],
  ]);

describe("the DNR simulator used by these tests", () => {
  it("reads urlFilter anchors and separators like Chrome", () => {
    expect(urlFilterToRegExp("|https://a.com^").test("https://a.com/")).toBe(
      true,
    );
    expect(
      urlFilterToRegExp("|https://a.com^").test("https://a.com:8443/x"),
    ).toBe(true);
    expect(
      urlFilterToRegExp("|https://a.com^").test("https://a.com.evil.net/"),
    ).toBe(false);
    expect(urlFilterToRegExp("|https://a.com^").test("https://x.a.com/")).toBe(
      false,
    );
    expect(urlFilterToRegExp("|http://").test("https://a.com/")).toBe(false);
    expect(urlFilterToRegExp(BEACON_URL_FILTER).test(`${BEACON_URL}?x=1`)).toBe(
      true,
    );
    expect(urlFilterToRegExp(BEACON_URL_FILTER).test(`${BEACON_URL}x`)).toBe(
      false,
    );
  });
});

describe("every rule", () => {
  const jars: [string, CookieJar][] = [
    ["an empty jar", new CookieJar()],
    ["a localhost jar", localJar()],
    [
      "an https jar with Secure cookies and a subdomain",
      jarFrom([
        [
          "https://example.com/",
          "sid=1; Secure; HttpOnly; Path=/",
          "wide=2; Domain=example.com",
        ],
        ["https://www.example.com/", "host=3; Secure; Path=/"],
      ]),
    ],
  ];

  it.each(jars)(
    "scopes to the group and lists every resource type including main_frame (%s)",
    (_label, jar) => {
      const { addRules } = compile(jar, { tabIds: [TAB, 7] });
      expect(addRules.length).toBeGreaterThanOrEqual(2);
      for (const rule of addRules) {
        expect(rule.condition.tabIds).toEqual([TAB, 7]);
        expect(rule.condition.resourceTypes).toContain("main_frame");
        // Only the cross-site top-level GET rules are narrower.
        if (rule.condition.requestMethods) {
          expect(rule.condition).toMatchObject({
            resourceTypes: ["main_frame"],
            requestMethods: ["get"],
            domainType: "thirdParty",
          });
        } else {
          expect(rule.condition.resourceTypes).toEqual([...ALL_RESOURCE_TYPES]);
        }
      }
    },
  );

  it("lists the resource types from the plan, nothing missing", () => {
    expect([...ALL_RESOURCE_TYPES].sort()).toEqual(
      [
        "main_frame",
        "sub_frame",
        "xmlhttprequest",
        "websocket",
        "script",
        "stylesheet",
        "image",
        "font",
        "media",
        "ping",
        "csp_report",
        "object",
        "webtransport",
        "webbundle",
        "other",
      ].sort(),
    );
  });

  it("does not share arrays between rules", () => {
    const { addRules } = compile(localJar(), { tabIds: [1, 2] });
    addRules[0]!.condition.resourceTypes.pop();
    addRules[0]!.condition.tabIds!.pop();
    expect(addRules[1]!.condition.resourceTypes).toHaveLength(
      ALL_RESOURCE_TYPES.length,
    );
    expect(addRules[1]!.condition.tabIds).toEqual([1, 2]);
  });

  it("refuses tab IDs that would match requests outside tabs, and empty groups", () => {
    expect(() => compile(localJar(), { tabIds: [-1] })).toThrow(RangeError);
    expect(() => compile(localJar(), { tabIds: [3, -1] })).toThrow(RangeError);
    expect(() => compile(localJar(), { tabIds: [1.5] })).toThrow(RangeError);
    expect(() => compile(localJar(), { tabIds: [Number.NaN] })).toThrow(
      RangeError,
    );
    expect(() => compile(localJar(), { tabIds: [] })).toThrow(RangeError);
  });

  it("compileTabRules is the one-tab case of compileGroupRules", () => {
    const one = compileTabRules(
      {
        tabId: TAB,
        containerId: "alt",
        jar: localJar(),
        now: NOW,
        pageKeyOf: keyOf("alt"),
      },
      createSequentialAllocator(),
    );
    expect(one).toEqual(compile(localJar()));
  });

  it("only affects tabs of the group", () => {
    const { addRules } = compile(localJar(), { tabIds: [1, 2] });
    expect(sent(addRules, "http://a.localhost:3000/", 1)).toBe(
      "sid=aaa; theme=dark",
    );
    expect(sent(addRules, "http://a.localhost:3000/", 2)).toBe(
      "sid=aaa; theme=dark",
    );
    expect(sent(addRules, "http://a.localhost:3000/", 3)).toBeUndefined();
  });
});

describe("catch-all rule", () => {
  it("comes first, at priority 1, and strips request cookies and response Set-Cookie", () => {
    const { addRules } = compile(localJar());
    expect(addRules[0]).toEqual({
      id: 1,
      priority: CATCH_ALL_PRIORITY,
      condition: { tabIds: [TAB], resourceTypes: [...ALL_RESOURCE_TYPES] },
      action: {
        type: "modifyHeaders",
        requestHeaders: [{ header: "cookie", operation: "remove" }],
        responseHeaders: [{ header: "set-cookie", operation: "remove" }],
      },
    });
  });

  it("removes the Cookie header on hosts the jar knows nothing about", () => {
    const { addRules } = compile(localJar());
    expect(sent(addRules, "https://unrelated.example/")).toBeNull();
    expect(
      sent(addRules, "http://b.localhost:3000/", TAB, "xmlhttprequest"),
    ).toBeNull();
  });

  it("is emitted even for an empty jar, together with the identity beacon", () => {
    const { addRules } = compile(new CookieJar());
    expect(addRules.map((r) => r.priority)).toEqual([
      CATCH_ALL_PRIORITY,
      BEACON_PRIORITY,
    ]);
  });

  it("strips Set-Cookie on every rule, so nothing reaches the real profile", () => {
    for (const rule of compile(localJar()).addRules) {
      if (rule.action.type !== "modifyHeaders") continue;
      expect(rule.action.responseHeaders).toEqual([
        { header: "set-cookie", operation: "remove" },
      ]);
    }
  });
});

describe("host-only versus Domain cookies", () => {
  it("sends host-only cookies to the exact host only, Domain cookies to subdomains too", () => {
    const { addRules } = compile(localJar());
    expect(sent(addRules, "http://a.localhost:3000/")).toBe(
      "sid=aaa; theme=dark",
    );
    expect(sent(addRules, "http://sub.a.localhost:3000/")).toBe("theme=dark");
    expect(
      sent(
        addRules,
        "http://deep.sub.a.localhost:3000/me",
        TAB,
        "xmlhttprequest",
      ),
    ).toBe("theme=dark");
    expect(sent(addRules, "http://sso.localhost:3000/")).toBe("sso=zzz");
    expect(sent(addRules, "http://x.sso.localhost:3000/")).toBeNull();
  });

  it("is not fooled by the host name appearing in the path or query of a subdomain URL", () => {
    const jar = jarFrom([
      ["https://example.com/", "sid=1; Secure", "wide=2; Domain=example.com"],
    ]);
    const { addRules } = compile(jar);
    expect(
      sent(addRules, "https://x.example.com/?next=https://example.com/"),
    ).toBe("wide=2");
    expect(sent(addRules, "https://x.example.com/https://example.com/")).toBe(
      "wide=2",
    );
    expect(sent(addRules, "https://example.com.evil.net/")).toBeNull();
  });

  it("matches the exact host on any port and on ws/wss", () => {
    const jar = jarFrom([
      ["https://example.com/", "sid=1", "wide=2; Domain=example.com"],
    ]);
    const { addRules } = compile(jar);
    for (const url of [
      "https://example.com/",
      "https://example.com:8443/a",
      "http://example.com:8080/",
      "wss://example.com/s",
      "ws://example.com/s",
    ]) {
      expect(sent(addRules, url, TAB, "websocket"), url).toBe("sid=1; wide=2");
    }
    expect(sent(addRules, "wss://www.example.com/s", TAB, "websocket")).toBe(
      "wide=2",
    );
  });

  it("emits a WIDE rule (requestDomains) for Domain cookies and an EXACT rule (regexFilter) for host-only ones", () => {
    const { addRules } = compile(localJar());
    const forHost = (host: string) =>
      addRules.filter((r) => r.condition.requestDomains?.[0] === host);
    const rules = forHost("a.localhost");
    const wide = rules.find((r) => r.condition.regexFilter === undefined)!;
    const exact = rules.find((r) => r.condition.regexFilter !== undefined)!;
    expect(wide.condition).toEqual({
      tabIds: [TAB],
      resourceTypes: [...ALL_RESOURCE_TYPES],
      requestDomains: ["a.localhost"],
      domainType: "firstParty",
    });
    expect(wide.priority).toBe(hostRulePriority("a.localhost"));
    expect(exact.condition.regexFilter).toBe(exactHostRegex("a.localhost"));
    expect(exact.priority).toBe(exactHostRulePriority("a.localhost"));
    // sso.localhost has only a host-only cookie: no WIDE rule at all
    expect(
      forHost("sso.localhost").every(
        (r) => r.condition.regexFilter !== undefined,
      ),
    ).toBe(true);
  });

  it("emits only a WIDE rule when a host holds Domain cookies only", () => {
    const { addRules, regexRuleCount } = compile(
      jarFrom([["https://example.com/", "a=1; Domain=example.com"]]),
    );
    expect(regexRuleCount).toBe(0);
    const hostRules = addRules.filter((r) => r.condition.requestDomains);
    expect(
      hostRules.every((r) => r.priority - hostRulePriority("example.com") <= 1),
    ).toBe(true);
    expect(sent(addRules, "https://www.example.com/")).toBe("a=1");
  });

  it("gives a subdomain with its own host-only cookies both, and its children only the Domain ones", () => {
    const jar = jarFrom([
      ["https://example.com/", "wide=1; Domain=example.com", "apex=0"],
      ["https://www.example.com/", "host=2"],
    ]);
    const { addRules } = compile(jar);
    expect(sent(addRules, "https://example.com/")).toBe("wide=1; apex=0");
    expect(sent(addRules, "https://www.example.com/")).toBe("wide=1; host=2");
    expect(sent(addRules, "https://cdn.www.example.com/")).toBe("wide=1");
    expect(sent(addRules, "https://api.example.com/")).toBe("wide=1");
  });

  it("a Domain cookie on a subdomain reaches that subdomain and below, not the parent", () => {
    const jar = jarFrom([
      ["https://example.com/", "top=1; Domain=example.com"],
      ["https://www.example.com/", "mid=2; Domain=www.example.com"],
    ]);
    const { addRules } = compile(jar);
    expect(sent(addRules, "https://example.com/")).toBe("top=1");
    expect(sent(addRules, "https://www.example.com/")).toBe("top=1; mid=2");
    expect(sent(addRules, "https://a.www.example.com/")).toBe("top=1; mid=2");
  });

  it("priorities: EXACT above WIDE of the same host, deeper hosts above shallower ones", () => {
    expect(hostRulePriority("example.com")).toBe(18);
    expect(exactHostRulePriority("example.com")).toBe(20);
    expect(hostRulePriority("www.example.com")).toBe(22);
    expect(hostRulePriority("localhost")).toBe(14);
    // The cross-site navigation rule sits one step above its host rule, below the next kind of rule.
    expect(hostRulePriority("www.example.com")).toBeGreaterThan(
      exactHostRulePriority("example.com") + 1,
    );
    expect(exactHostRulePriority("example.com")).toBeGreaterThan(
      hostRulePriority("example.com") + 1,
    );
    expect(insecureHostRulePriority("example.com")).toBe(308);
    expect(insecureExactHostRulePriority("example.com")).toBe(310);
    const deepest = "a".concat(".x".repeat(200));
    expect(insecureHostRulePriority("example.com")).toBeGreaterThan(
      exactHostRulePriority(deepest) + 1,
    );
    expect(insecureExactHostRulePriority(deepest) + 1).toBeLessThan(
      STRICT_GUARD_PRIORITY,
    );
  });

  it("keeps jars of different containers apart (no cookies from another jar)", () => {
    const alt = compile(jarFrom([["http://a.localhost/", "who=alt"]]), {
      containerId: "alt",
    });
    const work = compile(jarFrom([["http://a.localhost/", "who=work"]]), {
      containerId: "work",
      tabIds: [7],
    });
    const both = [
      ...alt.addRules,
      ...work.addRules.map((r) => ({ ...r, id: r.id + 1000 })),
    ];
    expect(sent(both, "http://a.localhost/", TAB)).toBe("who=alt");
    expect(sent(both, "http://a.localhost/", 7)).toBe("who=work");
    expect(sent(both, "http://a.localhost/", 8)).toBeUndefined();
  });

  it("skips hosts whose cookies are all expired and never emits an empty Cookie value", () => {
    const jar = new CookieJar();
    jar.setFromHeader("old=1; Max-Age=60", {
      url: "http://a.localhost/",
      now: NOW - 3600_000,
    });
    jar.setFromHeader("live=1", { url: "http://sso.localhost/", now: NOW });
    const { addRules } = compile(jar);
    expect(sent(addRules, "http://a.localhost/")).toBeNull();
    expect(sent(addRules, "http://sso.localhost/")).toBe("live=1");
    for (const rule of addRules) {
      if (rule.action.type !== "modifyHeaders") continue;
      const op = rule.action.requestHeaders?.find((h) => h.header === "cookie");
      expect(op?.value).not.toBe("");
    }
  });

  it("only includes partitioned cookies of the group’s top-level site", () => {
    const jar = jarFrom(
      [
        [
          "https://widget.test/",
          "plain=1; Secure",
          "chips=2; Secure; Partitioned",
        ],
      ],
      "https://news.example",
    );
    const value = (site: string | null) =>
      sent(
        compile(jar, { topLevelSite: site }).addRules,
        "https://widget.test/",
      );
    expect(value("https://news.example")).toBe("plain=1; chips=2");
    expect(value("https://other.example")).toBe("plain=1");
    expect(value(null)).toBe("plain=1");
  });

  it("drops a host entirely when only foreign-partition cookies remain", () => {
    const jar = jarFrom(
      [["https://widget.test/", "chips=2; Secure; Partitioned"]],
      "https://news.example",
    );
    const { addRules } = compile(jar, {
      topLevelSite: "https://other.example",
    });
    expect(addRules.filter((r) => r.condition.requestDomains)).toHaveLength(0);
    expect(sent(addRules, "https://widget.test/")).toBeNull();
  });
});

describe("regex budget", () => {
  const jar = () =>
    jarFrom([
      ["https://example.com/", "sid=1; Secure", "wide=2; Domain=example.com"],
      ["https://www.example.com/", "host=3"],
      ["http://a.localhost/", "x=1"],
    ]);

  it("counts regexFilter rules", () => {
    const { regexRuleCount, addRules } = compile(jar());
    expect(regexRuleCount).toBe(
      addRules.filter((r) => r.condition.regexFilter !== undefined).length,
    );
    expect(regexRuleCount).toBeGreaterThanOrEqual(3);
  });

  it("falls back to anchored urlFilter rules with the same effect once the budget is spent", () => {
    const regex = compile(jar());
    for (const budget of [0, 1, 2]) {
      const limited = compile(jar(), { regexBudget: budget });
      expect(limited.regexRuleCount).toBeLessThanOrEqual(budget);
      for (const url of [
        "https://example.com/",
        "http://example.com/",
        "wss://example.com/",
        "ws://example.com/",
        "https://www.example.com/",
        "http://www.example.com:81/",
        "https://api.www.example.com/",
        "http://a.localhost:3000/",
        "http://b.a.localhost:3000/",
        "https://x.example.com/?u=https://example.com/",
      ]) {
        expect(
          sent(limited.addRules, url, TAB, "websocket"),
          `${url} @${budget}`,
        ).toEqual(sent(regex.addRules, url, TAB, "websocket"));
      }
    }
  });
});

describe("Secure cookies on plain http", () => {
  const secureJar = () =>
    jarFrom([
      [
        "https://example.com/",
        "sid=1; Secure; HttpOnly",
        "pref=2; Domain=example.com",
      ],
      ["https://www.example.com/", "host=3"],
    ]);

  it("never sends Secure cookies over http or ws, on the host or below", () => {
    const { addRules } = compile(secureJar());
    expect(sent(addRules, "https://example.com/")).toBe("sid=1; pref=2");
    expect(sent(addRules, "http://example.com/")).toBe("pref=2");
    expect(sent(addRules, "ws://example.com/", TAB, "websocket")).toBe(
      "pref=2",
    );
    expect(sent(addRules, "wss://example.com/", TAB, "websocket")).toBe(
      "sid=1; pref=2",
    );
    expect(sent(addRules, "http://www.example.com/")).toBe("pref=2; host=3");
    expect(sent(addRules, "https://www.example.com/")).toBe("pref=2; host=3");
    expect(sent(addRules, "http://cdn.example.com/")).toBe("pref=2");
  });

  it("removes the Cookie header on http when nothing but Secure cookies apply", () => {
    const { addRules } = compile(
      jarFrom([["https://example.com/", "sid=1; Secure"]]),
    );
    expect(sent(addRules, "http://example.com/")).toBeNull();
    expect(sent(addRules, "https://example.com/")).toBe("sid=1");
  });

  it("removes Secure Domain cookies on http subdomains too", () => {
    const { addRules } = compile(
      jarFrom([["https://example.com/", "sid=1; Secure; Domain=example.com"]]),
    );
    expect(sent(addRules, "http://www.example.com/")).toBeNull();
    expect(sent(addRules, "https://www.example.com/")).toBe("sid=1");
    const http = addRules.find((r) => r.condition.urlFilter === "|http://")!;
    expect(http.priority).toBe(insecureHostRulePriority("example.com"));
  });

  it("adds no http rules when no Secure cookie applies, nor on trustworthy localhost hosts", () => {
    const plain = compile(jarFrom([["https://example.com/", "a=1"]]));
    expect(
      plain.addRules.filter(
        (r) =>
          r.priority >= INSECURE_PRIORITY_BASE && r.priority < BEACON_PRIORITY,
      ),
    ).toHaveLength(0);

    const local = compile(jarFrom([["http://a.localhost/", "sec=1; Secure"]]));
    expect(
      local.addRules.filter(
        (r) =>
          r.priority >= INSECURE_PRIORITY_BASE && r.priority < BEACON_PRIORITY,
      ),
    ).toHaveLength(0);
    expect(sent(local.addRules, "http://a.localhost/")).toBe("sec=1");
  });
});

describe("beacon rules", () => {
  it('never carry the container ID; the generic answer says "in a container, ask again"', () => {
    const { addRules } = compile(localJar(), { containerName: "Alt" });
    expect(beaconFor(addRules, "https://unrelated.example")).toEqual({
      p: 1,
      n: "Alt",
    });
    expect(beaconFor(addRules)).toEqual({ p: 1, n: "Alt" });
    expect(beaconFor(addRules, "https://unrelated.example", 99)).toBeNull();
    for (const rule of addRules) {
      if (rule.action.type !== "redirect") continue;
      const payload = JSON.parse(
        decodeURIComponent(
          rule.action.redirect.url.slice("data:application/json,".length),
        ),
      );
      expect(payload.c).not.toBe("alt");
    }
  });

  it("give each site its own page key and cookie snapshot, never another site’s cookies", () => {
    const { addRules } = compile(localJar());
    const a = beaconFor(addRules, "http://a.localhost:3000")!;
    expect(a.c).toBe("key(alt,a.localhost)");
    expect(a.n).toBeUndefined(); // no name unless the caller passes one
    expect(a.k?.map((c) => `${c.domain}:${c.name}=${c.value}`)).toEqual([
      "a.localhost:theme=dark",
    ]);
    const sub = beaconFor(addRules, "http://sub.a.localhost:3000")!;
    expect(sub.c).toBe("key(alt,a.localhost)");
    expect(sub.k?.map((c) => c.name)).toEqual(["theme"]);
    const sso = beaconFor(addRules, "http://sso.localhost:3000")!;
    expect(sso.c).toBe("key(alt,sso.localhost)");
    expect(sso.k?.map((c) => c.name)).toEqual(["sso"]);
  });

  it("answer the sites the tabs are on even without cookies, with an empty snapshot", () => {
    const { addRules } = compile(new CookieJar(), {
      frameSites: ["b.localhost", "cdn.localhost"],
      containerName: "Alt",
    });
    expect(beaconFor(addRules, "http://b.localhost:3000")).toEqual({
      c: "key(alt,b.localhost)",
      n: "Alt",
      k: [],
      s: null,
    });
    expect(beaconFor(addRules, "http://cdn.localhost:3000")?.c).toBe(
      "key(alt,cdn.localhost)",
    );
    expect(beaconFor(addRules, "http://other.localhost:3000")).toEqual({
      p: 1,
      n: "Alt",
    });
  });

  it("carry no HttpOnly values anywhere", () => {
    for (const rule of compile(localJar()).addRules) {
      if (rule.action.type === "redirect")
        expect(decodeURIComponent(rule.action.redirect.url)).not.toContain(
          "aaa",
        );
    }
  });

  it("sit above every cookie rule, the per-site ones above the generic one", () => {
    const { addRules } = compile(localJar());
    const redirects = addRules.filter((r) => r.action.type === "redirect");
    const others = addRules.filter((r) => r.action.type !== "redirect");
    expect(Math.min(...redirects.map((r) => r.priority))).toBe(BEACON_PRIORITY);
    expect(Math.min(...redirects.map((r) => r.priority))).toBeGreaterThan(
      Math.max(...others.map((r) => r.priority)),
    );
    for (const r of redirects)
      expect(r.condition.urlFilter).toBe(BEACON_URL_FILTER);
    expect(
      redirects
        .filter((r) => r.condition.initiatorDomains)
        .map((r) => r.condition.initiatorDomains),
    ).toEqual([["a.localhost"], ["sso.localhost"]]);
  });

  it("are per site, not per host or per tab", () => {
    const many = jarFrom(
      Array.from({ length: 12 }, (_, i): [string, string] => [
        `http://h${i}.a.localhost/`,
        `c${i}=1; Domain=h${i}.a.localhost`,
      ]),
    );
    expect(
      compile(many, { tabIds: [1, 2, 3] }).addRules.filter(
        (r) => r.action.type === "redirect",
      ),
    ).toHaveLength(2);
  });

  it("survive awkward names through URL encoding", () => {
    const name = 'a b"c%d,é#';
    expect(
      beaconFor(compile(new CookieJar(), { containerName: name }).addRules)?.n,
    ).toBe(name);
  });

  it("let the shim rebuild document.cookie from the payload with the core jar", () => {
    const payload = beaconFor(
      compile(localJar()).addRules,
      "http://a.localhost:3000",
    )!;
    const shimJar = new CookieJar(payload.k);
    expect(
      shimJar.documentCookieString("a.localhost", { secure: true, now: NOW }),
    ).toBe("theme=dark");
  });

  it("snapshot only partitioned cookies of the group’s top-level site and record that site", () => {
    const jar = jarFrom(
      [
        [
          "https://widget.test/",
          "plain=1; Secure",
          "chips=2; Secure; Partitioned",
        ],
      ],
      "https://news.example",
    );
    const mine = beaconFor(
      compile(jar, { topLevelSite: "https://news.example" }).addRules,
      "https://widget.test",
    )!;
    expect(mine.s).toBe("https://news.example");
    expect(mine.k?.map((c) => c.name).sort()).toEqual(["chips", "plain"]);
    const other = beaconFor(
      compile(jar, { topLevelSite: "https://other.example" }).addRules,
      "https://widget.test",
    )!;
    expect(other.k?.map((c) => c.name)).toEqual(["plain"]);
  });

  it("drop the snapshot and flag overflow beyond the size cap, per site", () => {
    const jar = new CookieJar();
    const filler = "x".repeat(3000);
    const copies = Math.ceil(BEACON_COOKIE_BYTE_LIMIT / 3000) + 5;
    for (let i = 0; i < copies; i++)
      jar.setFromHeader(`c${i}=${filler}`, {
        url: "http://a.localhost/",
        now: NOW,
      });
    jar.setFromHeader("small=1", { url: "http://sso.localhost/", now: NOW });
    const { addRules } = compile(jar);
    expect(beaconFor(addRules, "http://a.localhost")).toEqual({
      c: "key(alt,a.localhost)",
      o: 1,
    });
    expect(
      beaconFor(addRules, "http://sso.localhost")?.k?.map((c) => c.name),
    ).toEqual(["small"]);
  });
});

describe("SameSite", () => {
  const sameSiteJar = () =>
    jarFrom([
      [
        "https://example.com/",
        "none=1; SameSite=None; Secure",
        "lax=2; SameSite=Lax",
        "unspec=3",
        "strict=4; SameSite=Strict",
        "wide=5; Domain=example.com; SameSite=Lax",
      ],
    ]);
  const url = "https://example.com/me";
  const evil = "https://evil.test";

  it("same-site requests carry every cookie", () => {
    const { addRules } = compile(sameSiteJar());
    expect(sent(addRules, url, TAB, "xmlhttprequest")).toBe(
      "none=1; lax=2; unspec=3; strict=4; wide=5",
    );
    expect(
      sent(addRules, url, TAB, "main_frame", "https://www.example.com", "post"),
    ).toBe("none=1; lax=2; unspec=3; strict=4; wide=5");
  });

  it("cross-site subresources, frames and POST navigations carry SameSite=None cookies only", () => {
    const { addRules } = compile(sameSiteJar());
    for (const type of [
      "xmlhttprequest",
      "image",
      "script",
      "sub_frame",
      "websocket",
    ])
      expect(sent(addRules, url, TAB, type, evil), type).toBe("none=1");
    expect(sent(addRules, url, TAB, "main_frame", evil, "post")).toBe("none=1");
    expect(
      sent(addRules, "https://www.example.com/", TAB, "xmlhttprequest", evil),
    ).toBeNull();
  });

  it("cross-site top-level GET navigations add Lax and unspecified cookies, never Strict ones", () => {
    const { addRules } = compile(sameSiteJar());
    expect(sent(addRules, url, TAB, "main_frame", evil)).toBe(
      "none=1; lax=2; unspec=3; wide=5",
    );
    expect(
      sent(addRules, "https://www.example.com/", TAB, "main_frame", evil),
    ).toBe("wide=5");
    // Typed into the address bar / started by an extension: Chrome reports no initiator, DNR calls it third-party.
    expect(sent(addRules, url, TAB, "main_frame", null)).toBe(
      "none=1; lax=2; unspec=3; wide=5",
    );
  });

  it("a host whose cookies are all SameSite=None gets one rule without domainType", () => {
    const { addRules } = compile(
      jarFrom([
        [
          "https://tracker.test/",
          "id=1; SameSite=None; Secure",
          "w=2; SameSite=None; Secure; Domain=tracker.test",
        ],
      ]),
    );
    const hostRules = addRules.filter((r) => r.condition.requestDomains);
    expect(hostRules.every((r) => r.condition.domainType === undefined)).toBe(
      true,
    );
    expect(hostRules).toHaveLength(4); // WIDE + EXACT, and both again for plain http (Secure cookies)
    expect(
      sent(addRules, "https://tracker.test/", TAB, "xmlhttprequest", evil),
    ).toBe("id=1; w=2");
  });

  it("no cross-site navigation rule when it would say the same as the cross-site rule", () => {
    const { addRules } = compile(
      jarFrom([
        [
          "https://example.com/",
          "strict=1; SameSite=Strict",
          "none=2; SameSite=None; Secure",
        ],
      ]),
    );
    expect(addRules.filter((r) => r.condition.requestMethods)).toHaveLength(0);
    expect(sent(addRules, url, TAB, "main_frame", evil)).toBe("none=2");
  });

  it("plain http keeps Secure cookies out in every category", () => {
    const jar = jarFrom([
      [
        "https://example.com/",
        "sec=1; SameSite=None; Secure",
        "lax=2; SameSite=Lax",
        "strict=3; SameSite=Strict; Secure",
      ],
    ]);
    const { addRules } = compile(jar);
    expect(sent(addRules, "http://example.com/", TAB, "main_frame", evil)).toBe(
      "lax=2",
    );
    expect(
      sent(addRules, "http://example.com/", TAB, "xmlhttprequest", evil),
    ).toBeNull();
    expect(
      sent(
        addRules,
        "http://example.com/",
        TAB,
        "xmlhttprequest",
        "http://example.com",
      ),
    ).toBe("lax=2");
    expect(
      sent(addRules, "https://example.com/", TAB, "xmlhttprequest", evil),
    ).toBe("sec=1");
  });

  it("a deeper host answers for itself in every category", () => {
    const jar = jarFrom([
      ["https://example.com/", "wide=1; Domain=example.com; SameSite=Lax"],
      ["https://app.example.com/", "appnone=2; SameSite=None; Secure"],
    ]);
    const { addRules } = compile(jar);
    expect(
      sent(addRules, "https://app.example.com/", TAB, "main_frame", evil),
    ).toBe("wide=1; appnone=2");
    expect(
      sent(addRules, "https://app.example.com/", TAB, "xmlhttprequest", evil),
    ).toBe("appnone=2");
    expect(
      sent(
        addRules,
        "https://app.example.com/",
        TAB,
        "xmlhttprequest",
        "https://example.com",
      ),
    ).toBe("wide=1; appnone=2");
  });

  it("rule count for a typical jar stays well inside the budget", () => {
    // 40 sites with a Lax session (host-only) and a Domain analytics cookie, 40 trackers with SameSite=None only.
    const entries: [string, ...string[]][] = [];
    for (let i = 0; i < 40; i++)
      entries.push([
        `https://site${i}.example/`,
        "sid=1; SameSite=Lax; HttpOnly",
        `ga=2; Domain=site${i}.example`,
      ]);
    for (let i = 0; i < 40; i++)
      entries.push([`https://t${i}.tracker/`, "id=1; SameSite=None; Secure"]);
    const { addRules } = compile(jarFrom(entries));
    // catch-all + 40 * (WIDE 3 + EXACT 3) + 40 * (EXACT 1 + its http twin 1) + generic beacon + 80 site beacons
    expect(addRules).toHaveLength(1 + 240 + 80 + 1 + 80);
  });
});

describe("strict-mode rules", () => {
  it("the guard answers {g:1} to every frame, between the static default and managed answers", () => {
    const rule = compileStrictGuardRule(2);
    expect(rule.condition.tabIds).toBeUndefined();
    expect(rule.priority).toBeGreaterThan(900);
    expect(rule.priority).toBeLessThan(MANAGED_BEACON_PRIORITY);
    expect(beaconFor([rule], "https://any.example", 5)).toEqual({ g: 1 });
    const managed = compileManagedBeaconRule(1, ["a.localhost"])!;
    expect(beaconFor([rule, managed], "http://a.localhost", 5)).toEqual({
      m: 1,
    });
  });

  it("strips Cookie and Set-Cookie of requests outside tabs to managed sites, and only that", () => {
    const rule = compileNoTabRule(9, ["a.localhost", "example.com"])!;
    expect(rule.condition.tabIds).toEqual([TAB_ID_NONE]);
    expect(rule.action).toEqual({
      type: "modifyHeaders",
      requestHeaders: [{ header: "cookie", operation: "remove" }],
      responseHeaders: [{ header: "set-cookie", operation: "remove" }],
    });
    expect(compileNoTabRule(9, [])).toBeNull();
  });

  it("the no-tab rule needs an initiator on a managed site: browser-initiated requests (no initiator) keep their cookies", () => {
    const rule = compileNoTabRule(9, ["a.localhost", "example.com"])!;
    expect(rule.condition.requestDomains).toEqual([
      "a.localhost",
      "example.com",
    ]);
    expect(rule.condition.initiatorDomains).toEqual([
      "a.localhost",
      "example.com",
    ]);
    const cookie = (req: { url: string; initiator?: string; tabId?: number }) =>
      cookieHeaderFor([rule], {
        tabId: TAB_ID_NONE,
        type: "xmlhttprequest",
        ...req,
      });
    // A service worker of the site fetching the site: stripped.
    expect(
      cookie({ url: "http://a.localhost/x", initiator: "http://a.localhost" }),
    ).toBeNull();
    expect(
      cookie({
        url: "https://www.example.com/x",
        initiator: "https://sub.example.com",
      }),
    ).toBeNull();
    // Chrome's own request (a background session refresh): no initiator, untouched.
    expect(
      cookie({ url: "https://accounts.example.com/refresh" }),
    ).toBeUndefined();
    expect(cookie({ url: "http://a.localhost/x" })).toBeUndefined();
    // An extension's fetch, or a page of an unmanaged site: not this rule's business either.
    expect(
      cookie({
        url: "http://a.localhost/x",
        initiator: "chrome-extension://abc",
      }),
    ).toBeUndefined();
    expect(
      cookie({
        url: "http://a.localhost/x",
        initiator: "https://unmanaged.test",
      }),
    ).toBeUndefined();
    // And never a request of a tab.
    expect(
      cookie({
        url: "http://a.localhost/x",
        initiator: "http://a.localhost",
        tabId: 5,
      }),
    ).toBeUndefined();
  });

  it("strict mode blocks script requests outside tabs (worker scripts), on every site, and nothing in tabs", () => {
    const rule = compileNoTabWorkerScriptRule(11);
    expect(rule).toMatchObject({
      id: 11,
      condition: { tabIds: [TAB_ID_NONE], resourceTypes: ["script"] },
      action: { type: "block" },
    });
    expect(rule.condition.requestDomains).toBeUndefined();
    expect(rule.condition.initiatorDomains).toBeUndefined(); // touches no cookies; must hold for sites not seen yet
  });
});

describe("managed-site worker-script rule (no strict mode)", () => {
  it("blocks scripts outside tabs to and from managed sites only; nothing without managed sites", () => {
    expect(compileManagedWorkerScriptRule(3, [])).toBeNull();
    const rule = compileManagedWorkerScriptRule(3, [
      "a.localhost",
      "example.com",
    ])!;
    expect(rule).toEqual({
      id: 3,
      priority: CATCH_ALL_PRIORITY,
      condition: {
        tabIds: [TAB_ID_NONE],
        resourceTypes: ["script"],
        requestDomains: ["a.localhost", "example.com"],
        initiatorDomains: ["a.localhost", "example.com"],
      },
      action: { type: "block" },
    });
  });
});

describe("managed-origin beacon rule", () => {
  it("answers {m:1} to frames of managed sites in any tab, below per-tab beacons", () => {
    const rule = compileManagedBeaconRule(7, ["a.localhost", "example.com"])!;
    expect(rule.id).toBe(7);
    expect(rule.priority).toBe(MANAGED_BEACON_PRIORITY);
    expect(rule.priority).toBeLessThan(BEACON_PRIORITY);
    expect(rule.condition.tabIds).toBeUndefined();
    expect(beaconFor([rule], "http://sub.a.localhost", 5)).toEqual({ m: 1 });
    expect(beaconFor([rule], "https://www.example.com", 5)).toEqual({ m: 1 });
    expect(beaconFor([rule], "https://other.example", 5)).toBeNull();
    const tabRules = compile(new CookieJar(), {
      tabIds: [5],
      frameSites: ["a.localhost"],
    }).addRules;
    const both = [rule, ...tabRules.map((r) => ({ ...r, id: r.id + 100 }))];
    expect(beaconFor(both, "http://a.localhost", 5)?.c).toBe(
      "key(alt,a.localhost)",
    );
    expect(beaconFor(both, "http://sub.b.localhost", 5)).toEqual({ p: 1 });
  });

  it("is omitted when nothing is managed", () => {
    expect(compileManagedBeaconRule(1, [])).toBeNull();
  });
});

describe("rule IDs and limits", () => {
  it("draws IDs from the injected allocator, in rule order, and reports them", () => {
    const issued: number[] = [];
    let next = 500;
    const allocator: RuleIdAllocator = {
      next: () => {
        issued.push(next);
        return next++;
      },
    };
    const result = compileGroupRules(
      {
        tabIds: [TAB],
        containerId: "alt",
        jar: localJar(),
        now: NOW,
        pageKeyOf: keyOf("alt"),
      },
      allocator,
    );
    expect(result.ruleIds).toEqual(issued);
    expect(result.addRules.map((r) => r.id)).toEqual(issued);
    expect(result.ruleIds[0]).toBe(500);
    expect(new Set(result.ruleIds).size).toBe(result.ruleIds.length);
  });

  it("never reuses IDs across groups sharing one allocator", () => {
    const allocator = createSequentialAllocator(10);
    const jar = localJar();
    const a = compileGroupRules(
      {
        tabIds: [1],
        containerId: "alt",
        jar,
        now: NOW,
        pageKeyOf: keyOf("alt"),
      },
      allocator,
    );
    const b = compileGroupRules(
      {
        tabIds: [2],
        containerId: "alt",
        jar,
        now: NOW,
        pageKeyOf: keyOf("alt"),
      },
      allocator,
    );
    const all = [...a.ruleIds, ...b.ruleIds];
    expect(new Set(all).size).toBe(all.length);
  });

  it("rule count does not grow with the number of tabs in a group", () => {
    const one = compile(localJar(), { tabIds: [1] }).addRules.length;
    const many = compile(localJar(), {
      tabIds: Array.from({ length: 50 }, (_, i) => i),
    }).addRules.length;
    expect(many).toBe(one);
  });

  it("totalRuleCount sums groups; the soft limit sits below Chrome’s 5000", () => {
    const allocator = createSequentialAllocator();
    const groups = [1, 2, 3].map((tabId) =>
      compileGroupRules(
        {
          tabIds: [tabId],
          containerId: "alt",
          jar: localJar(),
          now: NOW,
          pageKeyOf: keyOf("alt"),
        },
        allocator,
      ),
    );
    // catch-all + a.localhost (WIDE + EXACT, 3 SameSite rules each) + sso.localhost (EXACT, 3) + generic beacon + 2 site beacons
    expect(totalRuleCount(groups)).toBe(3 * 13);
    expect(totalRuleCount([])).toBe(0);

    expect(SESSION_RULE_SOFT_LIMIT).toBe(4000);
    expect(SESSION_RULE_SOFT_LIMIT).toBeLessThan(SESSION_RULE_HARD_LIMIT);
    expect(isOverSoftLimit(SESSION_RULE_SOFT_LIMIT)).toBe(false);
    expect(isOverSoftLimit(SESSION_RULE_SOFT_LIMIT + 1)).toBe(true);
  });
});
