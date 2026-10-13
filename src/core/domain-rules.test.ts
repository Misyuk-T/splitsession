import { describe, expect, it } from "vitest";

import {
  ctrMarkerRef,
  decideRule,
  type DomainRule,
  findRule,
  hasCtrMarker,
  isDomainRule,
  normalizeRuleDomain,
  parseChooseParams,
  pruneRules,
  ruleKeyOf,
  upsertRule,
  validateRule,
} from "./domain-rules";

describe("ruleKeyOf", () => {
  it.each([
    ["https://www.github.com/login?x=1", "github.com"],
    ["http://gist.github.com", "github.com"],
    ["github.com", "github.com"],
    ["WWW.GitHub.com/a/b", "github.com"],
    ["accounts.google.co.uk:8443", "google.co.uk"],
    ["http://a.localhost:47321/x", "a.localhost"],
    ["http://sub.a.localhost:47321/x", "a.localhost"],
    ["http://127.0.0.1:3000/", "127.0.0.1"],
    ["https://user.github.io/", "user.github.io"],
  ])("%s -> %s", (input, expected) => {
    expect(ruleKeyOf(input)).toBe(expected);
  });

  it.each([
    "",
    "   ",
    "chrome://settings",
    "chrome-extension://abc/open.html",
    "about:blank",
    "ftp://example.com/",
    "http://",
  ])("%j is not a site", (input) => {
    expect(ruleKeyOf(input)).toBeNull();
  });
});

describe("normalizeRuleDomain", () => {
  it("reduces what the user typed to a registrable domain", () => {
    expect(normalizeRuleDomain(" https://www.Reddit.com/r/x ")).toEqual({
      ok: true,
      domain: "reddit.com",
    });
    expect(normalizeRuleDomain("threads.com")).toEqual({
      ok: true,
      domain: "threads.com",
    });
  });

  it.each([
    "",
    "   ",
    "two words.com",
    "com",
    "co.uk",
    "github.io",
    "localhost",
    "chrome://flags",
    "ex ample.com",
  ])("rejects %j", (input) => {
    const r = normalizeRuleDomain(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message.length).toBeGreaterThan(5);
  });

  it("accepts internationalised names via their punycode form", () => {
    const r = normalizeRuleDomain("münchen.de");
    expect(r).toEqual({ ok: true, domain: "xn--mnchen-3ya.de" });
  });

  it("accepts IP hosts and the e2e stand hosts", () => {
    expect(normalizeRuleDomain("127.0.0.1")).toEqual({
      ok: true,
      domain: "127.0.0.1",
    });
    expect(normalizeRuleDomain("http://sub.a.localhost")).toEqual({
      ok: true,
      domain: "a.localhost",
    });
  });
});

describe("findRule / decideRule", () => {
  const rules: DomainRule[] = [
    { domain: "github.com", action: "always", containerId: "work" },
    { domain: "reddit.com", action: "ask" },
  ];

  it("finds a rule for any host of the registrable domain", () => {
    expect(findRule(rules, "https://gist.github.com/x")?.containerId).toBe(
      "work",
    );
    expect(findRule(rules, "https://old.reddit.com/")?.action).toBe("ask");
    expect(findRule(rules, "https://example.com/")).toBeUndefined();
    expect(findRule(rules, "chrome://settings")).toBeUndefined();
    expect(findRule(rules, "https://notgithub.com/")).toBeUndefined();
  });

  it("always: moves unless the tab is already in that container", () => {
    const rule = rules[0];
    expect(decideRule(rule, null)).toEqual({
      kind: "move",
      containerId: "work",
    });
    expect(decideRule(rule, "personal")).toEqual({
      kind: "move",
      containerId: "work",
    });
    expect(decideRule(rule, "work")).toEqual({ kind: "none" });
  });

  it("ask: always asks; no rule: nothing", () => {
    expect(decideRule(rules[1], null)).toEqual({ kind: "ask" });
    expect(decideRule(rules[1], "work")).toEqual({ kind: "ask" });
    expect(decideRule(undefined, "work")).toEqual({ kind: "none" });
  });

  it("an always rule without a container cannot fire", () => {
    expect(decideRule({ domain: "x.com", action: "always" }, null)).toEqual({
      kind: "none",
    });
  });
});

describe("validateRule", () => {
  const known = new Set(["work", "home"]);
  it("accepts always and ask", () => {
    expect(
      validateRule(
        {
          domain: "https://www.github.com/",
          action: "always",
          containerId: "work",
        },
        known,
      ),
    ).toEqual({
      ok: true,
      rule: { domain: "github.com", action: "always", containerId: "work" },
    });
    expect(
      validateRule(
        { domain: "reddit.com", action: "ask", containerId: "ignored" },
        known,
      ),
    ).toEqual({
      ok: true,
      rule: { domain: "reddit.com", action: "ask" },
    });
  });
  it.each([
    [null],
    ["x"],
    [{ action: "ask" }],
    [{ domain: "com", action: "ask" }],
    [{ domain: "a.com", action: "sometimes" }],
    [{ domain: "a.com", action: "always" }],
    [{ domain: "a.com", action: "always", containerId: "ghost" }],
    [{ domain: "a.com", action: "always", containerId: "" }],
  ])("rejects %j", (raw) => {
    expect(validateRule(raw, known).ok).toBe(false);
  });
});

describe("rule list helpers", () => {
  it("upsertRule replaces by domain and keeps the list sorted", () => {
    let list: DomainRule[] = [];
    list = upsertRule(list, { domain: "b.com", action: "ask" });
    list = upsertRule(list, {
      domain: "a.com",
      action: "always",
      containerId: "x",
    });
    list = upsertRule(list, {
      domain: "b.com",
      action: "always",
      containerId: "y",
    });
    expect(list).toEqual([
      { domain: "a.com", action: "always", containerId: "x" },
      { domain: "b.com", action: "always", containerId: "y" },
    ]);
  });
  it("pruneRules drops always-rules of deleted containers and keeps ask-rules", () => {
    const list: DomainRule[] = [
      { domain: "a.com", action: "always", containerId: "gone" },
      { domain: "b.com", action: "always", containerId: "here" },
      { domain: "c.com", action: "ask" },
    ];
    expect(pruneRules(list, new Set(["here"])).map((r) => r.domain)).toEqual([
      "b.com",
      "c.com",
    ]);
  });
  it("isDomainRule is a strict guard for stored data", () => {
    expect(isDomainRule({ domain: "a.com", action: "ask" })).toBe(true);
    expect(
      isDomainRule({ domain: "a.com", action: "ask", containerId: "x" }),
    ).toBe(false);
    expect(
      isDomainRule({ domain: "a.com", action: "always", containerId: "x" }),
    ).toBe(true);
    expect(isDomainRule({ domain: "a.com", action: "always" })).toBe(false);
    expect(isDomainRule({ domain: "", action: "ask" })).toBe(false);
    expect(isDomainRule(null)).toBe(false);
  });
});

describe("address helpers", () => {
  it("ctrMarkerRef decodes the reference", () => {
    expect(ctrMarkerRef("https://x.com/#ctr=my%20work")).toBe("my work");
    expect(ctrMarkerRef("https://x.com/#a=1&ctr=work&b=2")).toBe("work");
    expect(ctrMarkerRef("https://x.com/#ctr=%E0%A4%A")).toBeNull();
    expect(ctrMarkerRef("https://x.com/")).toBeNull();
  });

  it("hasCtrMarker finds the marker in the fragment only", () => {
    expect(hasCtrMarker("https://x.com/#ctr=work")).toBe(true);
    expect(hasCtrMarker("https://x.com/#a=1&ctr=work")).toBe(true);
    expect(hasCtrMarker("https://x.com/?ctr=work")).toBe(false);
    expect(hasCtrMarker("https://x.com/#section")).toBe(false);
  });

  it("parseChooseParams accepts http(s) targets and a numeric tab id", () => {
    expect(
      parseChooseParams("?url=https%3A%2F%2Fa.com%2Fx%3Fy%3D1&tab=12"),
    ).toEqual({ url: "https://a.com/x?y=1", tab: 12 });
    expect(parseChooseParams("?url=javascript%3Aalert(1)&tab=x")).toEqual({
      url: null,
      tab: null,
    });
    expect(parseChooseParams("?url=chrome%3A%2F%2Fsettings")).toEqual({
      url: null,
      tab: null,
    });
    expect(parseChooseParams("")).toEqual({ url: null, tab: null });
    expect(parseChooseParams("?tab=-3")).toEqual({ url: null, tab: null });
  });
});
