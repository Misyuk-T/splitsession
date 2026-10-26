/* eslint-disable no-console -- the probe prints the measured rule breakdown */
import { describe, expect, it } from "vitest";

import { CookieJar } from "../jar/cookie-jar";
import { simulate } from "./dnr-simulator";
import {
  breakdown,
  FIXTURE_NOW,
  heavyJar,
  SITES,
} from "./rule-budget.fixtures";
import {
  compileContainerRules,
  compileGroupRules,
  createSequentialAllocator,
  type DnrRule,
  SESSION_RULE_SOFT_LIMIT,
  type TabGroupInput,
} from "./rule-compiler";

const pageKeyOf = (site: string) => `k-${site}`;
type Tab = { id: number; site: string | null };

/** Tabs grouped by top-level site, as `ContainerRules` does while the jar holds partitioned cookies. */
function groupsOf(tabs: readonly Tab[]): TabGroupInput[] {
  const groups = new Map<string | null, number[]>();
  for (const t of tabs)
    groups.set(t.site, [...(groups.get(t.site) ?? []), t.id]);
  return [...groups].map(([site, tabIds]) => ({
    tabIds,
    topLevelSite: site,
    frameSites: site ? [new URL(site).hostname] : [],
  }));
}

/** Before 2026-10-26: one full rule set per group. */
function compileSeparately(jar: CookieJar, tabs: readonly Tab[]): DnrRule[] {
  const allocator = createSequentialAllocator();
  return groupsOf(tabs).flatMap(
    (g) =>
      compileGroupRules(
        {
          ...g,
          containerId: "ctr",
          jar,
          now: FIXTURE_NOW,
          pageKeyOf,
        },
        allocator,
      ).addRules,
  );
}

function compileMerged(
  jar: CookieJar,
  tabs: readonly Tab[],
  regexBudget?: number,
): ReturnType<typeof compileContainerRules> {
  return compileContainerRules(
    {
      containerId: "ctr",
      jar,
      now: FIXTURE_NOW,
      pageKeyOf,
      regexBudget,
      groups: groupsOf(tabs),
    },
    createSequentialAllocator(),
  );
}

const https = (site: string) => `https://${site}`;

/** The incident: 6 containers, 16 tabs, on threads / supabase / vercel / northflank, one tab per container loading. */
function incident(): Tab[][] {
  const all: Array<string | null> = [...SITES.map(https), null];
  let id = 100;
  return [4, 3, 3, 2, 2, 2].map((n, c) =>
    Array.from({ length: n }, (_, i) => ({
      id: id++,
      site: all[(c + i) % all.length]!,
    })),
  );
}

/** A rule without its ID and tabs, to compare rule sets. */
const shape = (r: DnrRule) =>
  JSON.stringify([r.priority, { ...r.condition, tabIds: undefined }, r.action]);
const forTab = (rules: readonly DnrRule[], tabId: number) =>
  rules
    .filter((r) => r.condition.tabIds?.includes(tabId))
    .map(shape)
    .sort();

describe("rule budget probe (heavy jars of the 2026-10-26 incident)", () => {
  it("breaks down one container tab's rules by kind", () => {
    const one = compileMerged(heavyJar(), [
      { id: 1, site: https("threads.com") },
    ]).addRules;
    console.log("one tab, one container:", one.length, breakdown(one));
    // Host rules dominate: per cookie host up to 3 WIDE + 3 EXACT (SameSite split), the same again for plain http.
    expect(one.length).toBeGreaterThan(300);
  });

  it("counts the incident's 16 tabs in 6 containers before and after merging", () => {
    const tabs = incident();
    const before = tabs.map((t, c) => compileSeparately(heavyJar(c), t).length);
    const after = tabs.map(
      (t, c) => compileMerged(heavyJar(c), t).addRules.length,
    );
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    console.log("16 tabs / 6 containers before:", sum(before), before);
    console.log("16 tabs / 6 containers after:", sum(after), after);
    expect(sum(before)).toBeGreaterThan(5000);
    expect(sum(after)).toBeLessThan(SESSION_RULE_SOFT_LIMIT);
  });

  it("30 tabs in 3 containers on 4 sites cost about what 3 single-tab containers cost", () => {
    const sites: Array<string | null> = [...SITES.map(https), null];
    let total = 0;
    let single = 0;
    for (let c = 0; c < 3; c++) {
      const tabs = Array.from({ length: 10 }, (_, i) => ({
        id: c * 100 + i,
        site: sites[i % sites.length]!,
      }));
      total += compileMerged(heavyJar(c), tabs).addRules.length;
      single += compileMerged(heavyJar(c), [tabs[0]!]).addRules.length;
    }
    console.log("30 tabs / 3 containers:", total, "one tab each:", single);
    expect(total).toBeLessThan(single * 1.25);
  });
});

describe("compileContainerRules: one rule for every tab it applies to", () => {
  it("two tabs on one site share every rule", () => {
    const jar = heavyJar();
    const one = compileMerged(jar, [{ id: 1, site: https("threads.com") }]);
    const two = compileMerged(jar, [
      { id: 1, site: https("threads.com") },
      { id: 2, site: https("threads.com") },
    ]);
    expect(two.addRules.length).toBe(one.addRules.length);
    for (const r of two.addRules) expect(r.condition.tabIds).toEqual([1, 2]);
  });

  it("tabs on different sites share every rule while the jar has no partitioned cookies", () => {
    const jar = new CookieJar(
      heavyJar()
        .all()
        .filter((c) => !c.partitioned),
    );
    const rules = compileMerged(jar, [
      { id: 1, site: https("threads.com") },
      { id: 2, site: https("supabase.com") },
      { id: 3, site: null },
    ]).addRules;
    // Only the beacon answers of the tabs' own sites (frame sites without cookies) are per group.
    const perGroup = rules.filter((r) => r.condition.tabIds?.length !== 3);
    expect(perGroup.every((r) => r.condition.initiatorDomains)).toBe(true);
    expect(rules.length - perGroup.length).toBe(
      compileMerged(jar, [{ id: 1, site: null }]).addRules.length,
    );
  });

  it("repeats only what depends on the top-level site (hosts and beacons with partitioned cookies)", () => {
    const rules = compileMerged(heavyJar(), [
      { id: 1, site: https("threads.com") },
      { id: 2, site: https("supabase.com") },
    ]).addRules;
    for (const r of rules) {
      if (r.condition.tabIds!.length === 2) continue;
      const domain =
        r.condition.requestDomains?.[0] ?? r.condition.initiatorDomains![0]!;
      expect(domain).toMatch(
        /stripe|intercom|cloudflare|threads\.com|supabase\.com/,
      );
    }
  });

  it("gives every tab exactly the rules its group would get on its own (same shapes, same priorities)", () => {
    const jar = heavyJar();
    const tabs: Tab[] = [
      { id: 1, site: https("threads.com") },
      { id: 2, site: https("threads.com") },
      { id: 3, site: https("supabase.com") },
      { id: 4, site: null },
      { id: 5, site: https("vercel.com") },
    ];
    const merged = compileMerged(jar, tabs).addRules;
    const separate = compileSeparately(jar, tabs);
    for (const { id } of tabs)
      expect(forTab(merged, id)).toEqual(forTab(separate, id));
  });

  it("sends each tab the same Cookie header as before merging", () => {
    const jar = heavyJar();
    const tabs: Tab[] = [
      { id: 1, site: https("threads.com") },
      { id: 2, site: https("supabase.com") },
      { id: 3, site: null },
    ];
    const merged = compileMerged(jar, tabs).addRules;
    const separate = compileSeparately(jar, tabs);
    const urls = [
      "https://www.threads.com/",
      "http://www.threads.com/",
      "https://js.stripe.com/v3",
      "https://widget.intercom.io/x",
      "https://app.supabase.com/",
      "https://unknown.example/",
    ];
    for (const { id } of tabs)
      for (const url of urls)
        for (const initiator of [
          undefined,
          "https://www.threads.com",
          "https://app.supabase.com",
        ])
          for (const type of ["main_frame", "xmlhttprequest"]) {
            const req = { url, tabId: id, initiator, type };
            const a = simulate(merged, req);
            const b = simulate(separate, req);
            expect(a.kind).toBe(b.kind);
            if (a.kind === "cookie" && b.kind === "cookie")
              expect(a.value).toBe(b.value);
          }
  });

  it("never lists a tab twice and keeps tab IDs as given", () => {
    const rules = compileMerged(heavyJar(), [
      { id: 9, site: https("threads.com") },
      { id: 3, site: https("supabase.com") },
      { id: 9, site: https("threads.com") },
    ]).addRules;
    for (const r of rules)
      expect(new Set(r.condition.tabIds).size).toBe(r.condition.tabIds!.length);
  });

  it("spends the regex budget once for a rule several groups share", () => {
    const jar = heavyJar();
    const one = compileMerged(jar, [{ id: 1, site: https("threads.com") }]);
    const four = compileMerged(
      jar,
      SITES.map((s, i) => ({ id: i + 1, site: https(s) })),
    );
    expect(four.regexRuleCount).toBeLessThan(one.regexRuleCount * 1.3);
    // With a budget, the count respects it and the rest falls back to urlFilter rules.
    const capped = compileMerged(
      jar,
      SITES.map((s, i) => ({ id: i + 1, site: https(s) })),
      40,
    );
    expect(capped.regexRuleCount).toBeLessThanOrEqual(40);
  });

  it("keeps different containers apart: a compile only ever names its own tabs", () => {
    const a = compileMerged(heavyJar(0), [{ id: 1, site: null }]).addRules;
    const b = compileMerged(heavyJar(1), [{ id: 2, site: null }]).addRules;
    expect(a.every((r) => r.condition.tabIds!.every((t) => t === 1))).toBe(
      true,
    );
    expect(b.every((r) => r.condition.tabIds!.every((t) => t === 2))).toBe(
      true,
    );
  });

  it("refuses an empty group list, an empty group and negative tab IDs", () => {
    const jar = new CookieJar();
    const compile = (groups: TabGroupInput[]) =>
      compileContainerRules(
        { containerId: "c", jar, pageKeyOf, groups },
        createSequentialAllocator(),
      );
    expect(() => compile([])).toThrow(RangeError);
    expect(() => compile([{ tabIds: [] }])).toThrow(RangeError);
    expect(() => compile([{ tabIds: [1] }, { tabIds: [-1] }])).toThrow(
      RangeError,
    );
  });
});
