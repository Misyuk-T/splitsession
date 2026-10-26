import {
  type CookieJar,
  isExpired,
  serializeCookieHeader,
} from "../jar/cookie-jar";
import {
  isPotentiallyTrustworthyHost,
  isSameOrSubdomain,
  labelCount,
  registrableDomain,
} from "../site";
import type { BeaconPayload, ContainerId, Cookie } from "../types";

/**
 * Compiles one container jar into declarativeNetRequest session rules for a GROUP of tabs (every tab of the
 * container, or, when the jar holds partitioned cookies, every tab of the container with the same top-level site).
 * Rules carry `tabIds: [...group]`, so the rule count grows with containers and hosts, not with tabs. A container's
 * groups compile together (`compileContainerRules`): a rule identical in several groups is emitted once for all
 * their tabs, so only what really depends on the top-level site (hosts and beacon answers with partitioned cookies)
 * is repeated per group.
 *
 * Emitted, in this order:
 *  1. catch-all (priority 2): drop request `Cookie` and response `Set-Cookie`, so the real profile's cookies never
 *     reach the container and container cookies never leak into the real profile;
 *  2. per cookie host `h` (longer host = higher priority):
 *     - WIDE  (`requestDomains: [h]`): the Domain cookies that match `h`. `requestDomains` also matches subdomains,
 *       which is exactly right for Domain cookies;
 *     - EXACT (`regexFilter` anchored on the exact host): everything `h` gets, host-only cookies included. Only
 *       emitted when `h` holds host-only cookies, so those never reach `x.h` (RFC 6265 host-only);
 *     each split by SameSite with DNR `domainType` (Chrome compares the request with its initiator; a request without
 *     initiator, i.e. typed into the address bar or started by an extension, counts as third-party):
 *     - `firstParty`: every cookie;
 *     - `thirdParty`: `SameSite=None` cookies only (cross-site fetch, XHR, images, frames, forms...);
 *     - `thirdParty` + `main_frame` + GET, one step higher: `None`, `Lax` and unspecified (Lax-by-default) cookies,
 *       the cookies of a top-level cross-site navigation. `Strict` cookies never travel cross-site.
 *     A host whose cookies are all `SameSite=None` gets one rule without `domainType` instead of the split.
 *  3. for hosts holding `Secure` cookies (and hosts below such a host, which would otherwise be shadowed) the same
 *     rules for plain `http://` (a band above) carrying only the non-Secure cookies, so Secure cookies never travel in
 *     clear text. Skipped on localhost-like hosts, where Chrome sends Secure cookies over http too. The WIDE http rule
 *     cannot cover `ws://` (a `urlFilter` cannot say "http or ws"); EXACT can;
 *  4. the beacon: the content script's synchronous XHR to `ctr.localhost/whoami` is redirected to a `data:` URL. A
 *     page can read that URL too, so it never carries the container ID: one rule per registrable domain
 *     (`initiatorDomains: [site]`) answers `{c: <page key of this site>}`, the site's `document.cookie` snapshot and
 *     (only when the user lets pages see it) the container name. The page key is opaque and differs per site (see
 *     `page-key.ts`). A generic rule answers frames of sites without their own rule with `{p: 1}` ("in a container,
 *     ask again"): the content script then asks the background to add the site and polls.
 *
 * Path matching is ignored, as planned. EXACT rules use `regexFilter` while the caller's regex budget lasts
 * (Chrome allows 1000 regex rules); beyond it they fall back to one left-anchored `urlFilter` rule per scheme.
 */

/** Chrome allows 5000 session rules with modifyHeaders/redirect actions; we start warning at 4000. */
export const SESSION_RULE_SOFT_LIMIT = 4000;
export const SESSION_RULE_HARD_LIMIT = 5000;
/** Chrome's cap on regexFilter rules; the engine keeps its budget below it. */
export const REGEX_RULE_LIMIT = 1000;
export const REGEX_RULE_BUDGET = 900;

/**
 * 2, not 1: the restore gate (`core/restore.ts`) uses priority 1 for its `block` and `allow` rules, and an `allow`
 * cancels every modifyHeaders rule of the same priority or lower (measured), so no cookie rule may sit at 1.
 */
export const CATCH_ALL_PRIORITY = 2;
export const HOST_PRIORITY_BASE = 10;
/** Above the highest secure-band priority (10 + 4*63 + 3 = 265). */
export const INSECURE_PRIORITY_BASE = 300;
/** Global (no tabIds) answers: static default `{}`, strict-mode guard `{g:1}`, "managed origin" `{m:1}`. */
export const DEFAULT_BEACON_PRIORITY = 900;
export const STRICT_GUARD_PRIORITY = 920;
export const MANAGED_BEACON_PRIORITY = 950;
/** `tabs.TAB_ID_NONE`: in a session rule's `tabIds` it matches requests that belong to no tab (service workers...). */
export const TAB_ID_NONE = -1;
export const BEACON_PRIORITY = 1000;
/** Hosts cannot have more than 127 labels; capping keeps the priority bands apart. */
const MAX_PRIORITY_LABELS = 63;

export const BEACON_URL = "http://ctr.localhost/whoami";
/** `|` anchors the start, `^` accepts end-of-URL or a separator such as `?`, so cache-busting queries still match. */
export const BEACON_URL_FILTER = "|http://ctr.localhost/whoami^";
/** Above this many bytes of JSON a site's cookie snapshot is left out of the beacon (`o: 1` instead). */
export const BEACON_COOKIE_BYTE_LIMIT = 200_000;

/**
 * Without an explicit list DNR skips `main_frame`, so navigations would go out with the real profile's
 * cookies and a 302 login's `Set-Cookie` would land in the real profile.
 */
export const ALL_RESOURCE_TYPES = [
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
] as const;
export type DnrResourceType = (typeof ALL_RESOURCE_TYPES)[number];

export interface DnrHeaderOperation {
  header: string;
  operation: "set" | "remove" | "append";
  value?: string;
}

/** Structural subset of chrome.declarativeNetRequest.Rule that SplitSession emits. */
export interface DnrRule {
  id: number;
  priority: number;
  condition: {
    /** Always present on per-container rules; absent only on the global beacon answers. */
    tabIds?: number[];
    resourceTypes: DnrResourceType[];
    /** Chrome compares the request URL with its initiator; no initiator (browser-initiated) counts as third-party. */
    domainType?: "firstParty" | "thirdParty";
    requestMethods?: string[];
    requestDomains?: string[];
    initiatorDomains?: string[];
    urlFilter?: string;
    regexFilter?: string;
  };
  action:
    | {
        type: "modifyHeaders";
        requestHeaders?: DnrHeaderOperation[];
        responseHeaders?: DnrHeaderOperation[];
      }
    | { type: "redirect"; redirect: { url: string } }
    | { type: "block" }
    /** Only the restore gate's openers (`core/restore.ts`); it cancels modifyHeaders rules of its priority and below. */
    | { type: "allow" };
}

/** Hands out rule IDs; the engine implements it on top of its ID pool. */
export interface RuleIdAllocator {
  next(): number;
}

export function createSequentialAllocator(start = 1): RuleIdAllocator {
  let current = start;
  return { next: () => current++ };
}

export interface CompileGroupInput {
  /** Tabs sharing this jar view. Must be non-empty, non-negative integers. */
  tabIds: readonly number[];
  containerId: ContainerId;
  /** Display name, echoed in the beacon (page marker, title prefix). Pass it only when pages may see it. */
  containerName?: string;
  jar: CookieJar;
  /** Top-level site of the group (`siteOf`), used to include the right partitioned (CHIPS) cookies. */
  topLevelSite?: string | null;
  now?: number;
  /** How many regexFilter rules this compile may emit; EXACT rules beyond it use urlFilter rules. Default: no cap. */
  regexBudget?: number;
  /** Opaque page-visible key of this container on `site` (registrable domain). Never the container ID. */
  pageKeyOf(site: string): string;
  /** Sites (registrable domains) whose frames get a beacon answer even without cookies: the sites the tabs are on. */
  frameSites?: Iterable<string>;
}

export interface CompiledRules {
  addRules: DnrRule[];
  /** IDs of `addRules`, same order; remove them with `updateSessionRules({removeRuleIds})` to retire the group. */
  ruleIds: number[];
  /** Number of `regexFilter` rules among `addRules`. */
  regexRuleCount: number;
}

export interface CompileTabInput extends Omit<CompileGroupInput, "tabIds"> {
  tabId: number;
}

/** @deprecated name kept for Stage A callers; same shape as `CompiledRules`. */
export type CompiledTabRules = CompiledRules;

const labels = (host: string): number =>
  Math.min(labelCount(host), MAX_PRIORITY_LABELS);
/**
 * Four steps per label: WIDE, WIDE cross-site navigation, EXACT, EXACT cross-site navigation. A deeper host's lowest
 * rule still beats every rule of its parent.
 */
export const hostRulePriority = (host: string): number =>
  HOST_PRIORITY_BASE + 4 * labels(host);
export const exactHostRulePriority = (host: string): number =>
  HOST_PRIORITY_BASE + 4 * labels(host) + 2;
export const insecureHostRulePriority = (host: string): number =>
  INSECURE_PRIORITY_BASE + 4 * labels(host);
export const insecureExactHostRulePriority = (host: string): number =>
  INSECURE_PRIORITY_BASE + 4 * labels(host) + 2;
/** Offset of the `thirdParty` + `main_frame` + GET rule above its host rule. */
export const CROSS_SITE_NAVIGATION_STEP = 1;
export const beaconSitePriority = (site: string): number =>
  BEACON_PRIORITY + labels(site);

/** Key used to group cookies into beacon snapshots: the registrable domain, or the host itself when it has none. */
export function beaconSiteOf(host: string): string {
  return registrableDomain(host) ?? host;
}

const urlHost = (host: string): string =>
  host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
const escapeRegex = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type SchemeSet = "any" | "insecure";
const SCHEMES: Record<SchemeSet, readonly string[]> = {
  any: ["http", "https", "ws", "wss"],
  insecure: ["http", "ws"],
};

/** Regex that matches URLs whose host is exactly `host` (any port), for the given schemes. */
export function exactHostRegex(
  host: string,
  schemes: SchemeSet = "any",
): string {
  const scheme = schemes === "any" ? "(?:https?|wss?)" : "(?:http|ws)";
  return `^${scheme}://${escapeRegex(urlHost(host))}(?::[0-9]+)?/`;
}

/** Fallback when the regex budget is spent: `|scheme://host^` per scheme (`^` = `/`, `:` or `?`, never `.`). */
export function exactHostUrlFilters(
  host: string,
  schemes: SchemeSet = "any",
): string[] {
  return SCHEMES[schemes].map((scheme) => `|${scheme}://${urlHost(host)}^`);
}

export function compileTabRules(
  input: CompileTabInput,
  allocator: RuleIdAllocator,
): CompiledRules {
  const { tabId, ...rest } = input;
  return compileGroupRules({ ...rest, tabIds: [tabId] }, allocator);
}

export function compileGroupRules(
  input: CompileGroupInput,
  allocator: RuleIdAllocator,
): CompiledRules {
  const { tabIds, topLevelSite = null, frameSites, ...rest } = input;
  return compileContainerRules(
    { ...rest, groups: [{ tabIds, topLevelSite, frameSites }] },
    allocator,
  );
}

/** Tabs of one container that see the same jar view: the same top-level site while the jar holds partitioned cookies. */
export interface TabGroupInput {
  /** Must be non-empty, non-negative integers. */
  tabIds: readonly number[];
  /** Top-level site of the group (`siteOf`), used to include the right partitioned (CHIPS) cookies. */
  topLevelSite?: string | null;
  /** Sites (registrable domains) whose frames get a beacon answer even without cookies: the sites the tabs are on. */
  frameSites?: Iterable<string>;
}

export interface CompileContainerInput extends Omit<
  CompileGroupInput,
  "tabIds" | "topLevelSite" | "frameSites"
> {
  /** Non-empty. */
  groups: readonly TabGroupInput[];
}

type RuleSpec = Omit<DnrRule, "id">;

/** Identity of a rule apart from its tabs: two rules with the same key differ only in which tabs they cover. */
const specKey = (rule: RuleSpec): string =>
  JSON.stringify([
    rule.priority,
    { ...rule.condition, tabIds: undefined },
    rule.action,
  ]);

/**
 * Compiles a container's tab groups into one rule set. Each group compiles as it would on its own; rules that two
 * groups emit identically apart from `tabIds` (the catch-all, the rules of every host whose cookies do not depend on
 * the top-level site, beacon answers without partitioned cookies) become ONE rule with the union of their tabs.
 * `tabIds` is an "any of" condition, so the merged rule matches exactly the requests the separate rules matched, at the
 * same priority: the rule count grows with containers, hosts and partitioned-cookie variants, not with tabs or the
 * sites they are on.
 */
export function compileContainerRules(
  input: CompileContainerInput,
  allocator: RuleIdAllocator,
): CompiledRules {
  const { containerName, jar, now = Date.now(), pageKeyOf } = input;
  if (input.groups.length === 0)
    throw new RangeError("compileContainerRules: no tab group");
  for (const { tabIds } of input.groups) {
    if (tabIds.length === 0)
      throw new RangeError("compileGroupRules: empty tab group");
    for (const tabId of tabIds) {
      if (!Number.isInteger(tabId) || tabId < 0) {
        // tabId -1 would match every request that does not belong to a tab (service workers, other extensions).
        throw new RangeError(`compileGroupRules: invalid tabId ${tabId}`);
      }
    }
  }
  const regex = { left: input.regexBudget ?? Number.POSITIVE_INFINITY };

  /** Rules in first-emission order; a rule emitted again by another group only adds its tabs. */
  const specs = new Map<string, { spec: RuleSpec; tabs: Set<number> }>();
  const isNew = (rule: RuleSpec): boolean => !specs.has(specKey(rule));
  const add = (rule: RuleSpec): void => {
    const key = specKey(rule);
    const known = specs.get(key);
    if (known) for (const t of rule.condition.tabIds ?? []) known.tabs.add(t);
    else specs.set(key, { spec: rule, tabs: new Set(rule.condition.tabIds) });
  };

  for (const group of input.groups) {
    const { tabIds, topLevelSite = null } = group;
    const base = () => ({
      tabIds: [...tabIds],
      resourceTypes: [...ALL_RESOURCE_TYPES],
    });
    const stripSetCookie = (): DnrHeaderOperation[] => [
      { header: "set-cookie", operation: "remove" },
    ];
    const cookieAction = (cookies: Cookie[]): DnrRule["action"] => ({
      type: "modifyHeaders",
      requestHeaders:
        cookies.length > 0
          ? [
              {
                header: "cookie",
                operation: "set",
                value: serializeCookieHeader(cookies),
              },
            ]
          : [{ header: "cookie", operation: "remove" }],
      responseHeaders: stripSetCookie(),
    });

    type Fragment = Partial<DnrRule["condition"]>;
    /** Cookie rules for one matcher fragment, split by SameSite (see the file comment). */
    const cookieRules = (
      fragment: Fragment,
      priority: number,
      cookies: Cookie[],
    ): RuleSpec[] => {
      const none = cookies.filter((c) => c.sameSite === "none");
      if (none.length === cookies.length) {
        return [
          {
            priority,
            condition: { ...base(), ...fragment },
            action: cookieAction(cookies),
          },
        ];
      }
      const out: RuleSpec[] = [
        {
          priority,
          condition: { ...base(), ...fragment, domainType: "firstParty" },
          action: cookieAction(cookies),
        },
        {
          priority,
          condition: { ...base(), ...fragment, domainType: "thirdParty" },
          action: cookieAction(none),
        },
      ];
      const lax = cookies.filter((c) => c.sameSite !== "strict");
      if (lax.length === none.length) return out; // the thirdParty rule already says it
      out.push({
        priority: priority + CROSS_SITE_NAVIGATION_STEP,
        condition: {
          ...base(),
          ...fragment,
          domainType: "thirdParty",
          resourceTypes: ["main_frame"],
          requestMethods: ["get"],
        },
        action: cookieAction(lax),
      });
      return out;
    };
    const emitCookieRules = (
      fragment: Fragment,
      priority: number,
      cookies: Cookie[],
    ): void => cookieRules(fragment, priority, cookies).forEach(add);
    const emitExact = (
      host: string,
      schemes: SchemeSet,
      priority: number,
      cookies: Cookie[],
    ): void => {
      const regexRules = cookieRules(
        { requestDomains: [host], regexFilter: exactHostRegex(host, schemes) },
        priority,
        cookies,
      );
      // Rules another group already emitted merge into those and cost no budget.
      const needed = regexRules.filter(isNew).length;
      if (regex.left >= needed) {
        regex.left -= needed;
        regexRules.forEach(add);
        return;
      }
      regex.left = 0; // keep the fallback decision stable for the rest of this compile
      for (const urlFilter of exactHostUrlFilters(host, schemes))
        emitCookieRules(
          { requestDomains: [host], urlFilter },
          priority,
          cookies,
        );
    };

    add({
      priority: CATCH_ALL_PRIORITY,
      condition: base(),
      action: {
        type: "modifyHeaders",
        requestHeaders: [{ header: "cookie", operation: "remove" }],
        responseHeaders: stripSetCookie(),
      },
    });

    interface HostPlan {
      host: string;
      /** Everything a secure request to exactly `host` carries. */
      full: Cookie[];
      /** Same, over plain http. */
      plain: Cookie[];
      /** Domain cookies only: what unknown subdomains of `host` inherit. */
      wide: Cookie[];
      widePlain: Cookie[];
      hasHostOnly: boolean;
    }
    const plans: HostPlan[] = [];
    for (const host of jar.hosts(now)) {
      const full = jar.cookiesForHost(host, {
        secure: true,
        topLevelSite,
        now,
      });
      if (full.length === 0) continue; // e.g. only partitioned cookies of another site
      const plain = jar.cookiesForHost(host, {
        secure: false,
        topLevelSite,
        now,
      });
      plans.push({
        host,
        full,
        plain,
        wide: full.filter((c) => !c.hostOnly),
        widePlain: plain.filter((c) => !c.hostOnly),
        hasHostOnly: full.some((c) => c.hostOnly),
      });
    }

    for (const { host, full, wide, hasHostOnly } of plans) {
      // With no Domain cookie matching `host`, no ancestor has one either, so subdomains correctly fall through to
      // the catch-all (or to an ancestor rule that is equally empty of matching cookies).
      if (wide.length > 0)
        emitCookieRules(
          { requestDomains: [host] },
          hostRulePriority(host),
          wide,
        );
      if (hasHostOnly)
        emitExact(host, "any", exactHostRulePriority(host), full);
    }

    // A host needs its own http rules if it holds Secure cookies, or if an ancestor does (the ancestor's higher-band
    // http rule would otherwise also win for this host and hide this host's own cookies).
    const insecureHosts: string[] = [];
    const byDepth = [...plans].sort(
      (a, b) =>
        labelCount(a.host) - labelCount(b.host) || (a.host < b.host ? -1 : 1),
    );
    for (const { host, full, plain } of byDepth) {
      if (isPotentiallyTrustworthyHost(host)) continue;
      const differs = plain.length !== full.length;
      if (
        differs ||
        insecureHosts.some((parent) => isSameOrSubdomain(host, parent))
      )
        insecureHosts.push(host);
    }
    for (const host of insecureHosts) {
      const plan = plans.find((p) => p.host === host)!;
      // `emitCookieRules` covers every request category (one rule without domainType, or the split), also with an
      // empty list: a missing http rule would let the secure-band rule (Secure cookies included) answer plain http.
      if (plan.wide.length > 0)
        emitCookieRules(
          { requestDomains: [host], urlFilter: "|http://" },
          insecureHostRulePriority(host),
          plan.widePlain,
        );
      if (plan.hasHostOnly)
        emitExact(
          host,
          "insecure",
          insecureExactHostRulePriority(host),
          plan.plain,
        );
    }

    // Beacon: a generic "ask again" answer, and one answer per site with that site's page key and cookie snapshot.
    const named = containerName === undefined ? {} : { n: containerName };
    add({
      priority: BEACON_PRIORITY,
      condition: { ...base(), urlFilter: BEACON_URL_FILTER },
      action: {
        type: "redirect",
        redirect: { url: beaconDataUrl({ p: 1, ...named }) },
      },
    });
    for (const [site, payload] of buildSiteBeaconPayloads(
      jar,
      topLevelSite,
      now,
      { pageKeyOf, containerName, frameSites: group.frameSites },
    )) {
      add({
        priority: beaconSitePriority(site),
        condition: {
          ...base(),
          urlFilter: BEACON_URL_FILTER,
          initiatorDomains: [site],
        },
        action: { type: "redirect", redirect: { url: beaconDataUrl(payload) } },
      });
    }
  }

  const addRules: DnrRule[] = [];
  let regexRuleCount = 0;
  for (const { spec, tabs } of specs.values()) {
    if (spec.condition.regexFilter !== undefined) regexRuleCount++;
    addRules.push({
      id: allocator.next(),
      ...spec,
      condition: { ...spec.condition, tabIds: [...tabs] },
    });
  }
  return { addRules, ruleIds: addRules.map((rule) => rule.id), regexRuleCount };
}

/** Non-HttpOnly, unexpired cookies a page of this group could see through `document.cookie` (on some host). */
export function scriptVisibleCookies(
  jar: CookieJar,
  topLevelSite: string | null,
  now: number,
): Cookie[] {
  return jar
    .all()
    .filter(
      (c) =>
        !c.httpOnly &&
        !isExpired(c, now) &&
        (!c.partitioned ||
          (topLevelSite !== null && c.partitionKey === topLevelSite)),
    );
}

/** Script-visible cookies grouped by `beaconSiteOf(cookie.domain)`, sorted by site. */
export function groupCookiesBySite(
  cookies: readonly Cookie[],
): Map<string, Cookie[]> {
  const bySite = new Map<string, Cookie[]>();
  for (const cookie of cookies) {
    const site = beaconSiteOf(cookie.domain);
    const list = bySite.get(site);
    if (list) list.push(cookie);
    else bySite.set(site, [cookie]);
  }
  return new Map([...bySite].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * One payload per site: the site's page key, the container name when pages may see it, and that site's
 * script-visible cookies (the content script answers `document.cookie` for its own host from them with the core jar).
 * Sites in `frameSites` without cookies get an empty snapshot. Oversized snapshots become `o: 1`.
 */
export function buildSiteBeaconPayloads(
  jar: CookieJar,
  topLevelSite: string | null,
  now: number,
  options: {
    pageKeyOf(site: string): string;
    containerName?: string;
    frameSites?: Iterable<string>;
  },
): Map<string, BeaconPayload> {
  const bySite = groupCookiesBySite(
    scriptVisibleCookies(jar, topLevelSite, now),
  );
  for (const site of options.frameSites ?? [])
    if (!bySite.has(site)) bySite.set(site, []);
  const result = new Map<string, BeaconPayload>();
  for (const site of [...bySite.keys()].sort()) {
    const cookies = bySite.get(site)!;
    const identity: BeaconPayload =
      options.containerName === undefined
        ? { c: options.pageKeyOf(site) }
        : { c: options.pageKeyOf(site), n: options.containerName };
    const tooBig = JSON.stringify(cookies).length > BEACON_COOKIE_BYTE_LIMIT;
    // The group's site only when the snapshot depends on it (partitioned cookies in `k`); otherwise the shim's own
    // estimate stands in (as for every container without partitioned cookies), and the answer is the same for all
    // groups, so their beacon rules merge (`compileContainerRules`).
    const s = cookies.some((c) => c.partitioned) ? topLevelSite : null;
    result.set(
      site,
      tooBig ? { ...identity, o: 1 } : { ...identity, k: cookies, s },
    );
  }
  return result;
}

export function beaconDataUrl(payload: object): string {
  return `data:application/json,${encodeURIComponent(JSON.stringify(payload))}`;
}

/**
 * Global answer for frames on origins SplitSession has seen inside containers, in tabs WITHOUT a container: tells the
 * shim to keep service workers away and to hide container-namespaced storage. Not tab-scoped; dynamic rule.
 */
export function compileManagedBeaconRule(
  id: number,
  managedSites: readonly string[],
): DnrRule | null {
  if (managedSites.length === 0) return null;
  return {
    id,
    priority: MANAGED_BEACON_PRIORITY,
    condition: {
      resourceTypes: ["xmlhttprequest"],
      urlFilter: BEACON_URL_FILTER,
      initiatorDomains: [...managedSites],
    },
    action: { type: "redirect", redirect: { url: beaconDataUrl({ m: 1 }) } },
  };
}

/** Strict mode, after the user agreed: every frame of every tab is told to refuse service-worker registration. */
export function compileStrictGuardRule(id: number): DnrRule {
  return {
    id,
    priority: STRICT_GUARD_PRIORITY,
    condition: {
      resourceTypes: ["xmlhttprequest"],
      urlFilter: BEACON_URL_FILTER,
    },
    action: { type: "redirect", redirect: { url: beaconDataUrl({ g: 1 }) } },
  };
}

/**
 * Session rule for requests that belong to NO tab (`tabIds: [TAB_ID_NONE]`: service workers, shared workers, other
 * extensions, browser-initiated requests) to sites containers use AND that a page of such a site started
 * (`initiatorDomains`): both their `Cookie` and their `Set-Cookie` are dropped. A worker of the real profile that
 * answers a container tab's navigation with its own fetch has the worker's site as initiator, so it can neither carry
 * the real profile's session into the container (the request goes without cookies) nor write into the real
 * profile's cookie store. Requests with NO initiator (the browser's own: a background session refresh such as Google's
 * device-bound session credentials, favicon and update fetches, a navigation typed in the omnibox) do not match
 * `initiatorDomains`, so they keep the real profile's cookies: stripping them could sign the real profile out.
 * Cost: requests of the real profile that a managed site's worker or shared worker starts go without cookies too.
 * Strict mode only.
 */
export function compileNoTabRule(
  id: number,
  managedSites: readonly string[],
): DnrRule | null {
  if (managedSites.length === 0) return null;
  return {
    id,
    priority: CATCH_ALL_PRIORITY,
    condition: {
      tabIds: [TAB_ID_NONE],
      requestDomains: [...managedSites],
      initiatorDomains: [...managedSites],
      resourceTypes: [...ALL_RESOURCE_TYPES],
    },
    action: {
      type: "modifyHeaders",
      requestHeaders: [{ header: "cookie", operation: "remove" }],
      responseHeaders: [{ header: "set-cookie", operation: "remove" }],
    },
  };
}

/**
 * Strict mode, after the user agreed: a session rule that blocks every script request belonging to no tab. A service
 * worker's script (and its update checks and `importScripts`) is fetched like that (measured, Chromium 156: type
 * `script`, tab ID -1; a shared worker's main script is `xmlhttprequest`), so no service worker can be installed in the
 * profile even by a realm the shim never patched. Cost: `importScripts` and static module imports of shared workers.
 * Deliberately NOT limited by `initiatorDomains` (unlike the cookie rule above): it touches no cookies, so a
 * browser-initiated request cannot lose a session to it, and a service worker must be refused on sites no container
 * has visited yet as well.
 */
export function compileNoTabWorkerScriptRule(id: number): DnrRule {
  return {
    id,
    priority: CATCH_ALL_PRIORITY,
    condition: { tabIds: [TAB_ID_NONE], resourceTypes: ["script"] },
    action: { type: "block" },
  };
}

/**
 * Without strict mode: a session rule that blocks script requests belonging to no tab (`tabIds: [-1]`) to managed sites
 * (sites containers have used) that a page of such a site started. That is how a service worker's script, its update
 * checks and `importScripts` are fetched (measured: type `script`, tab ID -1, the registering page's site as initiator),
 * so no realm on such a site can install a service worker, in any tab, whether SplitSession's scripts run there or not
 * (they are registered only while containers are in use). `initiatorDomains` keeps workers of other sites free to
 * import scripts from a managed site (a CDN). Cost: shared workers of managed sites cannot `importScripts` or
 * statically import modules from their own site. Strict mode replaces it with the global block above.
 */
export function compileManagedWorkerScriptRule(
  id: number,
  managedSites: readonly string[],
): DnrRule | null {
  if (managedSites.length === 0) return null;
  return {
    id,
    priority: CATCH_ALL_PRIORITY,
    condition: {
      tabIds: [TAB_ID_NONE],
      resourceTypes: ["script"],
      requestDomains: [...managedSites],
      initiatorDomains: [...managedSites],
    },
    action: { type: "block" },
  };
}

export function totalRuleCount(
  compiled: Iterable<Pick<CompiledRules, "ruleIds">>,
): number {
  let total = 0;
  for (const { ruleIds } of compiled) total += ruleIds.length;
  return total;
}

export function isOverSoftLimit(total: number): boolean {
  return total > SESSION_RULE_SOFT_LIMIT;
}
