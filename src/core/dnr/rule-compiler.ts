import type { BeaconPayload, ContainerId, Cookie } from '../types';
import { isExpired, serializeCookieHeader, type CookieJar } from '../jar/cookie-jar';
import { isPotentiallyTrustworthyHost, isSameOrSubdomain, labelCount, registrableDomain } from '../site';

/**
 * Compiles one container jar into declarativeNetRequest session rules for a GROUP of tabs (every tab of the
 * container, or, when the jar holds partitioned cookies, every tab of the container with the same top-level site).
 * Rules carry `tabIds: [...group]`, so the rule count grows with containers and hosts, not with tabs.
 *
 * Emitted, in this order:
 *  1. catch-all (priority 1): drop request `Cookie` and response `Set-Cookie`, so the real profile's cookies never
 *     reach the container and container cookies never leak into the real profile;
 *  2. per cookie host `h` (longer host = higher priority):
 *     - WIDE  (`requestDomains: [h]`, 10 + 2*labels): the Domain cookies that match `h`. `requestDomains` also
 *       matches subdomains, which is exactly right for Domain cookies;
 *     - EXACT (`regexFilter` anchored on the exact host, 11 + 2*labels): everything `h` gets, host-only cookies
 *       included. Only emitted when `h` holds host-only cookies, so those never reach `x.h` (RFC 6265 host-only);
 *  3. for hosts holding `Secure` cookies (and hosts below such a host, which would otherwise be shadowed) the same
 *     pair for plain `http://` (200 + 2*labels / 201 + 2*labels) carrying only the non-Secure cookies, so Secure
 *     cookies never travel in clear text. Skipped on localhost-like hosts, where Chrome sends Secure cookies over
 *     http too. The WIDE http rule cannot cover `ws://` (a `urlFilter` cannot say "http or ws"); EXACT can;
 *  4. the beacon: the content script's synchronous XHR to `ctr.localhost/whoami` is redirected to a `data:` URL.
 *     A generic rule (priority 1000) answers `{c, n}`; one rule per registrable domain with non-HttpOnly cookies
 *     (`initiatorDomains: [site]`, 1000 + labels) adds the `document.cookie` snapshot of that site only. A page can
 *     fetch the beacon URL itself, so a snapshot must never hold cookies of another site.
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

export const CATCH_ALL_PRIORITY = 1;
export const HOST_PRIORITY_BASE = 10;
export const INSECURE_PRIORITY_BASE = 200;
/** Global (no tabIds) answers: static default `{}` and the dynamic "managed origin" `{m:1}`. */
export const DEFAULT_BEACON_PRIORITY = 900;
export const MANAGED_BEACON_PRIORITY = 950;
export const BEACON_PRIORITY = 1000;
/** Hosts cannot have more than 127 labels; capping keeps the priority bands apart. */
const MAX_PRIORITY_LABELS = 63;

export const BEACON_URL = 'http://ctr.localhost/whoami';
/** `|` anchors the start, `^` accepts end-of-URL or a separator such as `?`, so cache-busting queries still match. */
export const BEACON_URL_FILTER = '|http://ctr.localhost/whoami^';
/** Above this many bytes of JSON a site's cookie snapshot is left out of the beacon (`o: 1` instead). */
export const BEACON_COOKIE_BYTE_LIMIT = 200_000;

/**
 * Without an explicit list DNR skips `main_frame`, so navigations would go out with the real profile's
 * cookies and a 302 login's `Set-Cookie` would land in the real profile.
 */
export const ALL_RESOURCE_TYPES = [
  'main_frame',
  'sub_frame',
  'xmlhttprequest',
  'websocket',
  'script',
  'stylesheet',
  'image',
  'font',
  'media',
  'ping',
  'csp_report',
  'object',
  'webtransport',
  'webbundle',
  'other',
] as const;
export type DnrResourceType = (typeof ALL_RESOURCE_TYPES)[number];

export interface DnrHeaderOperation {
  header: string;
  operation: 'set' | 'remove' | 'append';
  value?: string;
}

/** Structural subset of chrome.declarativeNetRequest.Rule that Facet emits. */
export interface DnrRule {
  id: number;
  priority: number;
  condition: {
    /** Always present on per-container rules; absent only on the global beacon answers. */
    tabIds?: number[];
    resourceTypes: DnrResourceType[];
    requestDomains?: string[];
    initiatorDomains?: string[];
    urlFilter?: string;
    regexFilter?: string;
  };
  action:
    | { type: 'modifyHeaders'; requestHeaders?: DnrHeaderOperation[]; responseHeaders?: DnrHeaderOperation[] }
    | { type: 'redirect'; redirect: { url: string } };
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
  /** Display name, echoed in the beacon so the page marker can show it. */
  containerName?: string;
  jar: CookieJar;
  /** Top-level site of the group (`siteOf`), used to include the right partitioned (CHIPS) cookies. */
  topLevelSite?: string | null;
  now?: number;
  /** How many regexFilter rules this compile may emit; EXACT rules beyond it use urlFilter rules. Default: no cap. */
  regexBudget?: number;
}

export interface CompiledRules {
  addRules: DnrRule[];
  /** IDs of `addRules`, same order; remove them with `updateSessionRules({removeRuleIds})` to retire the group. */
  ruleIds: number[];
  /** Number of `regexFilter` rules among `addRules`. */
  regexRuleCount: number;
}

export interface CompileTabInput {
  tabId: number;
  containerId: ContainerId;
  containerName?: string;
  jar: CookieJar;
  topLevelSite?: string | null;
  now?: number;
  regexBudget?: number;
}

/** @deprecated name kept for Stage A callers; same shape as `CompiledRules`. */
export type CompiledTabRules = CompiledRules;

const labels = (host: string): number => Math.min(labelCount(host), MAX_PRIORITY_LABELS);
export const hostRulePriority = (host: string): number => HOST_PRIORITY_BASE + 2 * labels(host);
export const exactHostRulePriority = (host: string): number => HOST_PRIORITY_BASE + 2 * labels(host) + 1;
export const insecureHostRulePriority = (host: string): number => INSECURE_PRIORITY_BASE + 2 * labels(host);
export const insecureExactHostRulePriority = (host: string): number => INSECURE_PRIORITY_BASE + 2 * labels(host) + 1;
export const beaconSitePriority = (site: string): number => BEACON_PRIORITY + labels(site);

/** Key used to group cookies into beacon snapshots: the registrable domain, or the host itself when it has none. */
export function beaconSiteOf(host: string): string {
  return registrableDomain(host) ?? host;
}

const urlHost = (host: string): string => (host.includes(':') && !host.startsWith('[') ? `[${host}]` : host);
const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

type SchemeSet = 'any' | 'insecure';
const SCHEMES: Record<SchemeSet, readonly string[]> = {
  any: ['http', 'https', 'ws', 'wss'],
  insecure: ['http', 'ws'],
};

/** Regex that matches URLs whose host is exactly `host` (any port), for the given schemes. */
export function exactHostRegex(host: string, schemes: SchemeSet = 'any'): string {
  const scheme = schemes === 'any' ? '(?:https?|wss?)' : '(?:http|ws)';
  return `^${scheme}://${escapeRegex(urlHost(host))}(?::[0-9]+)?/`;
}

/** Fallback when the regex budget is spent: `|scheme://host^` per scheme (`^` = `/`, `:` or `?`, never `.`). */
export function exactHostUrlFilters(host: string, schemes: SchemeSet = 'any'): string[] {
  return SCHEMES[schemes].map((scheme) => `|${scheme}://${urlHost(host)}^`);
}

export function compileTabRules(input: CompileTabInput, allocator: RuleIdAllocator): CompiledRules {
  const { tabId, ...rest } = input;
  return compileGroupRules({ ...rest, tabIds: [tabId] }, allocator);
}

export function compileGroupRules(input: CompileGroupInput, allocator: RuleIdAllocator): CompiledRules {
  const { tabIds, containerId, containerName, jar, topLevelSite = null, now = Date.now() } = input;
  if (tabIds.length === 0) throw new RangeError('compileGroupRules: empty tab group');
  for (const tabId of tabIds) {
    if (!Number.isInteger(tabId) || tabId < 0) {
      // tabId -1 would match every request that does not belong to a tab (service workers, other extensions).
      throw new RangeError(`compileGroupRules: invalid tabId ${tabId}`);
    }
  }
  let regexLeft = input.regexBudget ?? Number.POSITIVE_INFINITY;
  let regexRuleCount = 0;

  const addRules: DnrRule[] = [];
  const emit = (rule: Omit<DnrRule, 'id'>): void => {
    if (rule.condition.regexFilter !== undefined) regexRuleCount++;
    addRules.push({ id: allocator.next(), ...rule });
  };
  // Fresh arrays per rule: the engine may mutate or serialise rules independently.
  const base = () => ({ tabIds: [...tabIds], resourceTypes: [...ALL_RESOURCE_TYPES] });
  const stripSetCookie = (): DnrHeaderOperation[] => [{ header: 'set-cookie', operation: 'remove' }];
  const cookieAction = (cookies: Cookie[]): DnrRule['action'] => ({
    type: 'modifyHeaders',
    requestHeaders:
      cookies.length > 0
        ? [{ header: 'cookie', operation: 'set', value: serializeCookieHeader(cookies) }]
        : [{ header: 'cookie', operation: 'remove' }],
    responseHeaders: stripSetCookie(),
  });
  const emitExact = (host: string, schemes: SchemeSet, priority: number, cookies: Cookie[]): void => {
    if (regexLeft > 0) {
      regexLeft--;
      emit({
        priority,
        condition: { ...base(), requestDomains: [host], regexFilter: exactHostRegex(host, schemes) },
        action: cookieAction(cookies),
      });
      return;
    }
    for (const urlFilter of exactHostUrlFilters(host, schemes)) {
      emit({ priority, condition: { ...base(), requestDomains: [host], urlFilter }, action: cookieAction(cookies) });
    }
  };

  emit({
    priority: CATCH_ALL_PRIORITY,
    condition: base(),
    action: {
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'cookie', operation: 'remove' }],
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
    const full = jar.cookiesForHost(host, { secure: true, topLevelSite, now });
    if (full.length === 0) continue; // e.g. only partitioned cookies of another site
    const plain = jar.cookiesForHost(host, { secure: false, topLevelSite, now });
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
    if (wide.length > 0) {
      emit({ priority: hostRulePriority(host), condition: { ...base(), requestDomains: [host] }, action: cookieAction(wide) });
    }
    if (hasHostOnly) emitExact(host, 'any', exactHostRulePriority(host), full);
  }

  // A host needs its own http rules if it holds Secure cookies, or if an ancestor does (the ancestor's higher-band
  // http rule would otherwise also win for this host and hide this host's own cookies).
  const insecureHosts: string[] = [];
  const byDepth = [...plans].sort((a, b) => labelCount(a.host) - labelCount(b.host) || (a.host < b.host ? -1 : 1));
  for (const { host, full, plain } of byDepth) {
    if (isPotentiallyTrustworthyHost(host)) continue;
    const differs = plain.length !== full.length;
    if (differs || insecureHosts.some((parent) => isSameOrSubdomain(host, parent))) insecureHosts.push(host);
  }
  for (const host of insecureHosts) {
    const plan = plans.find((p) => p.host === host)!;
    if (plan.wide.length > 0) {
      emit({
        priority: insecureHostRulePriority(host),
        condition: { ...base(), requestDomains: [host], urlFilter: '|http://' },
        action: cookieAction(plan.widePlain),
      });
    }
    if (plan.hasHostOnly) emitExact(host, 'insecure', insecureExactHostRulePriority(host), plan.plain);
  }

  // Beacon: identity for every frame of the group, cookie snapshots per site.
  const identity: BeaconPayload = containerName === undefined ? { c: containerId } : { c: containerId, n: containerName };
  emit({
    priority: BEACON_PRIORITY,
    condition: { ...base(), urlFilter: BEACON_URL_FILTER },
    action: { type: 'redirect', redirect: { url: beaconDataUrl(identity) } },
  });
  for (const [site, payload] of buildSiteBeaconPayloads(identity, jar, topLevelSite, now)) {
    emit({
      priority: beaconSitePriority(site),
      condition: { ...base(), urlFilter: BEACON_URL_FILTER, initiatorDomains: [site] },
      action: { type: 'redirect', redirect: { url: beaconDataUrl(payload) } },
    });
  }

  return { addRules, ruleIds: addRules.map((rule) => rule.id), regexRuleCount };
}

/** Non-HttpOnly, unexpired cookies a page of this group could see through `document.cookie` (on some host). */
export function scriptVisibleCookies(jar: CookieJar, topLevelSite: string | null, now: number): Cookie[] {
  return jar
    .all()
    .filter((c) => !c.httpOnly && !isExpired(c, now) && (!c.partitioned || (topLevelSite !== null && c.partitionKey === topLevelSite)));
}

/** Script-visible cookies grouped by `beaconSiteOf(cookie.domain)`, sorted by site. */
export function groupCookiesBySite(cookies: readonly Cookie[]): Map<string, Cookie[]> {
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
 * One payload per site: identity plus that site's script-visible cookies. The content script answers
 * `document.cookie` for its own host from it with the core jar. Oversized snapshots become `o: 1`.
 */
export function buildSiteBeaconPayloads(
  identity: BeaconPayload,
  jar: CookieJar,
  topLevelSite: string | null,
  now: number,
): Map<string, BeaconPayload> {
  const result = new Map<string, BeaconPayload>();
  for (const [site, cookies] of groupCookiesBySite(scriptVisibleCookies(jar, topLevelSite, now))) {
    const tooBig = JSON.stringify(cookies).length > BEACON_COOKIE_BYTE_LIMIT;
    result.set(site, tooBig ? { ...identity, o: 1 } : { ...identity, k: cookies, s: topLevelSite });
  }
  return result;
}

export function beaconDataUrl(payload: object): string {
  return `data:application/json,${encodeURIComponent(JSON.stringify(payload))}`;
}

/**
 * Global answer for frames on origins Facet has seen inside containers, in tabs WITHOUT a container: tells the
 * shim to keep service workers away and to hide container-namespaced storage. Not tab-scoped; dynamic rule.
 */
export function compileManagedBeaconRule(id: number, managedSites: readonly string[]): DnrRule | null {
  if (managedSites.length === 0) return null;
  return {
    id,
    priority: MANAGED_BEACON_PRIORITY,
    condition: { resourceTypes: ['xmlhttprequest'], urlFilter: BEACON_URL_FILTER, initiatorDomains: [...managedSites] },
    action: { type: 'redirect', redirect: { url: beaconDataUrl({ m: 1 }) } },
  };
}

export function totalRuleCount(compiled: Iterable<Pick<CompiledRules, 'ruleIds'>>): number {
  let total = 0;
  for (const { ruleIds } of compiled) total += ruleIds.length;
  return total;
}

export function isOverSoftLimit(total: number): boolean {
  return total > SESSION_RULE_SOFT_LIMIT;
}
