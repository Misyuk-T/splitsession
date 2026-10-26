import { CookieJar } from "../jar/cookie-jar";
import type { Cookie, SameSite } from "../types";
import { BEACON_URL_FILTER, type DnrRule } from "./rule-compiler";

/**
 * Cookie-heavy jars shaped like the ones of the 2026-10-26 incident (threads.com with its instagram/facebook cookies,
 * supabase, vercel, northflank and the third parties their dashboards embed), for rule-budget tests. Synthetic: names
 * and values are made up, the shape (hosts, host-only vs Domain, Secure, HttpOnly, SameSite mix, a few partitioned
 * cookies of embedded widgets) follows what those sites set.
 */

const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);
export const FIXTURE_NOW = NOW;

interface Spec {
  domain: string;
  hostOnly?: boolean;
  names: number;
  sameSite?: SameSite[];
  secure?: boolean;
  httpOnly?: boolean;
  /** Partition key (schemeful site, `siteOf`): a partitioned (CHIPS) cookie stored for that top-level site. */
  partitionKey?: string;
}

function cookies(spec: Spec, seq: { n: number }): Cookie[] {
  const sameSites = spec.sameSite ?? ["lax", "none", "unspecified", "strict"];
  const out: Cookie[] = [];
  for (let i = 0; i < spec.names; i++) {
    const n = seq.n++;
    out.push({
      name: `c${n}`,
      value: `v${n}`.padEnd(24, "x"),
      domain: spec.domain,
      hostOnly: spec.hostOnly ?? false,
      path: "/",
      secure: spec.partitionKey ? true : (spec.secure ?? i % 3 !== 2),
      httpOnly: spec.httpOnly ?? i % 2 === 0,
      sameSite: spec.partitionKey ? "none" : sameSites[i % sameSites.length]!,
      partitioned: spec.partitionKey !== undefined,
      partitionKey: spec.partitionKey ?? null,
      expires: NOW + 86_400_000,
      creationTime: NOW - 1000 * n,
    });
  }
  return out;
}

/** Domain + host-only cookies on a site, its `www.` host and a few app subdomains. */
function siteSpecs(domain: string, subs: string[] = []): Spec[] {
  return [
    { domain, names: 6 },
    { domain, hostOnly: true, names: 2 },
    { domain: `www.${domain}`, hostOnly: true, names: 3 },
    ...subs.map((s) => ({
      domain: `${s}.${domain}`,
      hostOnly: true,
      names: 2,
    })),
  ];
}

/** Analytics / widget hosts with a couple of Domain cookies each. */
const trackers = (sites: string[]): Spec[] =>
  sites.map((s) => ({ domain: s, names: 2, sameSite: ["none", "lax"] }));

/** Partitioned cookies that embedded widgets set under each top-level site the user visits. */
const partitioned = (widgets: string[], topLevelSites: string[]): Spec[] =>
  widgets.flatMap((w) =>
    topLevelSites.map((tls) => ({ domain: w, names: 1, partitionKey: tls })),
  );

export const SITES = [
  "threads.com",
  "supabase.com",
  "vercel.com",
  "northflank.com",
] as const;

/** One container's jar after a working day on the incident's sites. */
export function heavyJar(variant = 0): CookieJar {
  const seq = { n: variant * 10_000 };
  const specs: Spec[] = [
    ...siteSpecs("threads.com", ["i", "graph", "about"]),
    ...siteSpecs("instagram.com", ["i", "graph", "help", "about"]),
    ...siteSpecs("facebook.com", ["m", "web", "business", "developers"]),
    ...siteSpecs("supabase.com", ["app", "api", "status"]),
    ...siteSpecs("vercel.com", ["app", "api", "nextjs"]),
    ...siteSpecs("northflank.com", ["app", "api"]),
    ...siteSpecs("github.com", ["api", "gist"]),
    ...siteSpecs("google.com", ["accounts", "apis", "ogs"]),
    ...trackers([
      "posthog.com",
      "us.posthog.com",
      "sentry.io",
      "intercom.io",
      "widget.intercom.io",
      "stripe.com",
      "m.stripe.network",
      "segment.io",
      "doubleclick.net",
      "googletagmanager.com",
      "hotjar.com",
      "cloudflare.com",
    ]),
    ...partitioned(
      ["js.stripe.com", "widget.intercom.io", "challenges.cloudflare.com"],
      SITES.map((s) => `https://${s}`),
    ),
  ];
  return new CookieJar(specs.flatMap((s) => cookies(s, seq)));
}

/** What a rule does, for the probe's breakdown. */
export function ruleKind(rule: DnrRule): string {
  const c = rule.condition;
  if (c.urlFilter?.startsWith(BEACON_URL_FILTER))
    return c.initiatorDomains ? "beacon: per site" : "beacon: generic";
  if (rule.priority === 2) return "catch-all";
  const insecure =
    rule.priority >= 300 ||
    c.urlFilter === "|http://" ||
    c.urlFilter?.startsWith("|ws://") === true;
  const exact =
    c.regexFilter !== undefined ||
    (c.urlFilter !== undefined && c.urlFilter !== "|http://");
  const band = `${insecure ? "http" : "secure"} ${exact ? "EXACT" : "WIDE"}`;
  const split =
    c.domainType === undefined
      ? "all"
      : c.domainType === "firstParty"
        ? "firstParty"
        : c.resourceTypes.length === 1
          ? "thirdParty nav"
          : "thirdParty";
  return `${band} (${split})`;
}

export function breakdown(rules: readonly DnrRule[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of rules) {
    const k = ruleKind(r);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort());
}
