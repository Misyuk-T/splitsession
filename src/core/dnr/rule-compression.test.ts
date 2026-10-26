import { describe, expect, it } from "vitest";

import { CookieJar } from "../jar/cookie-jar";
import { isIpHost, registrableDomain } from "../site";
import * as legacy from "./legacy/rule-compiler-0.1.12";
import { simulate, type SimulatedOutcome } from "./dnr-simulator";
import { FIXTURE_NOW, heavyJar, SITES } from "./rule-budget.fixtures";
import {
  BEACON_URL,
  compileContainerRules,
  createSequentialAllocator,
  type DnrRule,
  type TabGroupInput,
} from "./rule-compiler";

/**
 * Differential proof of the 0.1.13 rule compression: for a set of jars, tab groups and regex budgets, every request
 * of a matrix (hosts of the jar, their subdomains and unrelated hosts; four schemes; navigation, XHR and WebSocket;
 * GET and POST; no, same-site and cross-site initiator; and the beacon) gets the same outcome from the new compiler
 * as from the frozen 0.1.12 one (`legacy/`): the same deciding action (Cookie header and Set-Cookie removal, or the
 * same beacon answer). Rule IDs and rule shapes may differ.
 */

const NOW = FIXTURE_NOW;
const pageKeyOf = (site: string) => `key(${site})`;

function jarFrom(
  entries: [url: string, ...headers: string[]][],
  topLevelSite?: string,
  into = new CookieJar(),
): CookieJar {
  for (const [url, ...headers] of entries)
    for (const header of headers) {
      const { parsed } = into.setFromHeader(header, {
        url,
        now: NOW,
        topLevelSite,
      });
      if (!parsed.ok) throw new Error(`"${header}" rejected: ${parsed.reason}`);
    }
  return into;
}

interface Scenario {
  name: string;
  jar: CookieJar;
  groups: TabGroupInput[];
}

const SCENARIOS: Scenario[] = [
  {
    name: "heavy jar, tabs on the four sites and a blank tab",
    jar: heavyJar(),
    groups: [
      ...SITES.map((s, i) => ({
        tabIds: [i + 1, i + 11],
        topLevelSite: `https://${s}`,
        frameSites: [s],
      })),
      { tabIds: [9], topLevelSite: null, frameSites: [] },
    ],
  },
  {
    name: "host-only vs Domain cookies along a subdomain chain",
    jar: jarFrom([
      ["https://a.com/", "d=1; Domain=a.com; Secure", "h=1; SameSite=Lax"],
      ["https://www.a.com/", "w=1; SameSite=Strict", "w2=1; Secure"],
      ["https://x.www.a.com/", "xd=1; Domain=x.www.a.com"],
      ["https://deep.x.www.a.com/", "deep=1"],
      ["https://b.a.com/", "bd=1; Domain=b.a.com; Secure; SameSite=None"],
      ["https://other.net/", "o=1; Domain=other.net"],
    ]),
    groups: [{ tabIds: [1, 2], topLevelSite: null, frameSites: ["a.com"] }],
  },
  {
    name: "Secure cookies on plain-http hosts, and trustworthy localhost",
    jar: jarFrom([
      [
        "https://s.com/",
        "sec=1; Secure",
        "pl=1",
        "dsec=1; Domain=s.com; Secure",
      ],
      ["https://app.s.com/", "a=1; Secure; SameSite=None", "b=2"],
      [
        "https://only.secure.org/",
        "x=1; Secure",
        "y=1; Domain=secure.org; Secure",
      ],
      ["http://plain.org/", "p=1", "pd=1; Domain=plain.org"],
      ["http://a.localhost:3000/", "loc=1; Secure", "ld=1; Domain=a.localhost"],
      ["http://127.0.0.1:8080/", "ip=1"],
    ]),
    groups: [{ tabIds: [3], topLevelSite: null, frameSites: [] }],
  },
  {
    name: "SameSite Lax / Strict / None / unspecified, host-only and Domain",
    jar: jarFrom([
      [
        "https://ss.com/",
        "lax=1; SameSite=Lax",
        "str=1; SameSite=Strict",
        "non=1; SameSite=None; Secure",
        "uns=1",
        "dlax=1; Domain=ss.com; SameSite=Lax",
        "dstr=1; Domain=ss.com; SameSite=Strict",
        "dnon=1; Domain=ss.com; SameSite=None; Secure",
      ],
      ["https://m.ss.com/", "mstr=1; SameSite=Strict"],
      ["https://n.ss.com/", "nn=1; SameSite=None; Secure"],
      [
        "https://allnone.io/",
        "a=1; SameSite=None; Secure",
        "b=1; Domain=allnone.io; SameSite=None; Secure",
      ],
      ["https://strict.io/", "s=1; SameSite=Strict; Domain=strict.io"],
    ]),
    groups: [{ tabIds: [4, 5, 6], topLevelSite: null, frameSites: ["ss.com"] }],
  },
  {
    name: "partitioned cookies on two top-level sites",
    jar: (() => {
      const jar = jarFrom(
        [
          [
            "https://widget.io/",
            "chip=a; Secure; Partitioned; SameSite=None",
            "wa=1; Domain=widget.io; Secure; Partitioned; SameSite=None",
          ],
          [
            "https://js.widget.io/",
            "jsa=1; Secure; Partitioned; SameSite=None",
          ],
        ],
        "https://one.com",
      );
      jarFrom(
        [
          ["https://widget.io/", "chip=b; Secure; Partitioned; SameSite=None"],
          [
            "https://cdn.widget.io/",
            "cb=1; Secure; Partitioned; SameSite=None",
          ],
        ],
        "https://two.com",
        jar,
      );
      return jarFrom(
        [
          ["https://widget.io/", "plainw=1; Domain=widget.io"],
          ["https://one.com/", "one=1"],
          ["https://two.com/", "two=1; Secure"],
        ],
        undefined,
        jar,
      );
    })(),
    groups: [
      { tabIds: [7], topLevelSite: "https://one.com", frameSites: ["one.com"] },
      {
        tabIds: [8, 9],
        topLevelSite: "https://two.com",
        frameSites: ["two.com"],
      },
      { tabIds: [10], topLevelSite: null, frameSites: [] },
    ],
  },
  {
    name: "path cookies, identical cookies on sibling hosts (coalescing)",
    jar: jarFrom([
      [
        "https://p.com/app/x",
        "app=1; Path=/app",
        "root=1; Path=/",
        "dp=1; Domain=p.com; Path=/api",
      ],
      ["https://s1.p.com/", "same=1; Domain=s1.p.com"],
      ["https://s2.p.com/", "same=1; Domain=s2.p.com"],
      ["https://t1.org/", "t=1; Domain=t1.org; Secure; SameSite=None"],
      ["https://t2.org/", "t=1; Domain=t2.org; Secure; SameSite=None"],
      ["https://h1.org/", "h=1"],
      ["https://h2.org/", "h=1"],
    ]),
    groups: [{ tabIds: [11], topLevelSite: null, frameSites: ["p.com"] }],
  },
];

const BUDGETS = [0, 1, 5, 40, 300, 900];

function compileBoth(s: Scenario, regexBudget: number) {
  const input = {
    containerId: "ctr",
    jar: s.jar,
    now: NOW,
    regexBudget,
    pageKeyOf,
    groups: s.groups,
  };
  return {
    before: legacy.compileContainerRules(input, createSequentialAllocator())
      .addRules as DnrRule[],
    after: compileContainerRules(input, createSequentialAllocator()),
  };
}

/** What a request ends up with, without rule IDs. */
function outcome(o: SimulatedOutcome): string {
  if (o.kind === "none") return "none";
  return JSON.stringify([o.kind, o.rule.action]);
}

const domainMatch = (host: string, d: string) =>
  host === d || host.endsWith(`.${d}`);

function requestHosts(jar: CookieJar): string[] {
  const hosts = new Set<string>(["unrelated.example", "localhost"]);
  for (const h of jar.hosts(NOW)) {
    hosts.add(h);
    if (isIpHost(h)) continue;
    hosts.add(`zz.${h}`);
    hosts.add(`zz.yy.${h}`);
  }
  return [...hosts];
}

const urlHost = (h: string) => (h.includes(":") ? `[${h}]` : h);

/** The request matrix, per host. */
function* requests(hosts: readonly string[]) {
  for (const host of hosts) yield { host, requests: [...hostRequests(host)] };
  yield {
    host: "ctr.localhost",
    requests: [...hosts, "cross.example"].map((site) => ({
      url: `${BEACON_URL}?r=1`,
      type: "xmlhttprequest",
      method: "get",
      initiator: `https://${site}`,
    })),
  };
}

/** Every scheme, type, method and initiator kind; the second URL has a port and the host's name in its query. */
function* hostRequests(host: string) {
  const site = registrableDomain(host) ?? host;
  const initiators = [undefined, `https://${site}`, "https://cross.example"];
  for (const scheme of ["https", "http", "wss", "ws"]) {
    const ws = scheme.startsWith("ws");
    const types = ws
      ? ["websocket", "xmlhttprequest"]
      : ["main_frame", "xmlhttprequest"];
    for (const type of types)
      for (const method of ["get", "post"])
        for (const initiator of initiators)
          for (const url of [
            `${scheme}://${urlHost(host)}/`,
            `${scheme}://${urlHost(host)}:8443/p?u=https://${host}/`,
          ])
            yield { url, type, method, initiator };
  }
}

/** The rules that could match a host (a cheap prefilter; the simulator decides). */
const candidates = (rules: readonly DnrRule[], host: string) =>
  rules.filter(
    (r) =>
      !r.condition.requestDomains ||
      r.condition.requestDomains.some((d) => domainMatch(host, d)),
  );
const ofTab = (rules: readonly DnrRule[], tabId: number) =>
  rules.filter((r) => r.condition.tabIds!.includes(tabId));

describe("rule compression changes no request's outcome (differential, against 0.1.12)", () => {
  for (const scenario of SCENARIOS)
    for (const budget of BUDGETS)
      it(`${scenario.name}, regex budget ${budget}`, () => {
        const { before, after } = compileBoth(scenario, budget);
        const allTabs = scenario.groups.flatMap((g) => g.tabIds);
        // No rule names a tab outside this container's groups.
        for (const r of after.addRules)
          for (const t of r.condition.tabIds!) expect(allTabs).toContain(t);
        expect(after.regexRuleCount).toBeLessThanOrEqual(budget);
        expect(after.regexRuleCount).toBe(
          after.addRules.filter((r) => r.condition.regexFilter).length,
        );
        expect(after.addRules.length).toBeLessThanOrEqual(before.length);

        const hosts = requestHosts(scenario.jar);
        let checked = 0;
        const mismatches: string[] = [];
        for (const tabId of [...allTabs, 999]) {
          const oldRules = ofTab(before, tabId);
          const newRules = ofTab(after.addRules, tabId);
          for (const { host, requests: list } of requests(hosts)) {
            const oldCandidates = candidates(oldRules, host);
            const newCandidates = candidates(newRules, host);
            for (const req of list) {
              const a = simulate(oldCandidates, { ...req, tabId });
              const b = simulate(newCandidates, { ...req, tabId });
              checked++;
              if (outcome(a) !== outcome(b) && mismatches.length < 5)
                mismatches.push(
                  `tab ${tabId} ${req.method} ${req.type} ${req.url} from ${req.initiator}: ${outcome(a)} -> ${outcome(b)}`,
                );
            }
          }
        }
        expect(mismatches).toEqual([]);
        expect(checked).toBeGreaterThan(1000);
      }, 120_000);
});
