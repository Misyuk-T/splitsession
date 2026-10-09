import type { BeaconPayload, ContainerId, Cookie } from '../types';
import { isExpired, serializeCookieHeader, type CookieJar } from '../jar/cookie-jar';
import { isPotentiallyTrustworthyHost, isSameOrSubdomain, labelCount } from '../site';

/**
 * Compiles one container jar into the declarativeNetRequest session rules of ONE tab.
 *
 * Per tab, in this order:
 *  1. catch-all (priority 1): drop request `Cookie` and response `Set-Cookie`, so the real profile's
 *     cookies never reach the container and container cookies never leak into the real profile;
 *  2. one rule per host that has cookies (priority 10 + labels, longer host wins): set `Cookie` to the
 *     container's cookies for that host, strip `Set-Cookie` (capture happens in webRequest);
 *  2b. for hosts that hold `Secure` cookies, an extra rule for plain `http://` requests (priority
 *     100 + labels) that sets only the non-Secure ones, so Secure cookies never travel in clear text.
 *     Skipped on localhost-like hosts, where Chrome sends Secure cookies over http too. `ws://` is not
 *     covered (urlFilter cannot express "http or ws"), an accepted gap;
 *  3. the beacon (priority 1000): redirects the shim's synchronous XHR to `ctr.localhost/whoami` to a
 *     `data:` URL carrying a `BeaconPayload`.
 *
 * Known approximation: `requestDomains` also matches subdomains, so host-only cookies of `a.com` are
 * offered to `x.a.com` when only the `a.com` rule applies. Path matching is ignored, as planned.
 */

/** Chrome allows 5000 session rules in total; we start evicting and warning at 4000. */
export const SESSION_RULE_SOFT_LIMIT = 4000;
export const SESSION_RULE_HARD_LIMIT = 5000;

export const CATCH_ALL_PRIORITY = 1;
export const HOST_PRIORITY_BASE = 10;
export const INSECURE_PRIORITY_BASE = 100;
export const BEACON_PRIORITY = 1000;
/** Hosts cannot have more than 127 labels; capping keeps the priority bands apart. */
const MAX_PRIORITY_LABELS = 63;

export const BEACON_URL = 'http://ctr.localhost/whoami';
/** `|` anchors the start, `^` accepts end-of-URL or a separator such as `?`, so cache-busting queries still match. */
export const BEACON_URL_FILTER = '|http://ctr.localhost/whoami^';
/** Above this many bytes of JSON the cookie snapshot is left out of the beacon (`o: 1` instead). */
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
    tabIds: number[];
    resourceTypes: DnrResourceType[];
    requestDomains?: string[];
    urlFilter?: string;
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

export interface CompileTabInput {
  tabId: number;
  containerId: ContainerId;
  jar: CookieJar;
  /** Top-level site of the tab (`siteOf`), used to include the right partitioned (CHIPS) cookies. */
  topLevelSite?: string | null;
  now?: number;
}

export interface CompiledTabRules {
  addRules: DnrRule[];
  /** IDs of `addRules`, same order; remove them with `updateSessionRules({removeRuleIds})` to retire the tab. */
  ruleIds: number[];
}

export const hostRulePriority = (host: string): number => HOST_PRIORITY_BASE + Math.min(labelCount(host), MAX_PRIORITY_LABELS);
const insecureRulePriority = (host: string): number => INSECURE_PRIORITY_BASE + Math.min(labelCount(host), MAX_PRIORITY_LABELS);

export function compileTabRules(input: CompileTabInput, allocator: RuleIdAllocator): CompiledTabRules {
  const { tabId, containerId, jar, topLevelSite = null, now = Date.now() } = input;
  if (!Number.isInteger(tabId) || tabId < 0) {
    // tabId -1 would match every request that does not belong to a tab (service workers, other extensions).
    throw new RangeError(`compileTabRules: invalid tabId ${tabId}`);
  }

  const addRules: DnrRule[] = [];
  const emit = (rule: Omit<DnrRule, 'id'>): void => {
    addRules.push({ id: allocator.next(), ...rule });
  };
  // Fresh arrays per rule: the engine may mutate or serialise rules independently.
  const base = () => ({ tabIds: [tabId], resourceTypes: [...ALL_RESOURCE_TYPES] });
  const stripSetCookie = (): DnrHeaderOperation[] => [{ header: 'set-cookie', operation: 'remove' }];

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
    full: Cookie[];
    plain: Cookie[];
  }
  const plans: HostPlan[] = [];
  for (const host of jar.hosts(now)) {
    const full = jar.cookiesForHost(host, { secure: true, topLevelSite, now });
    if (full.length === 0) continue; // e.g. only partitioned cookies of another site
    plans.push({ host, full, plain: jar.cookiesForHost(host, { secure: false, topLevelSite, now }) });
  }

  for (const { host, full } of plans) {
    emit({
      priority: hostRulePriority(host),
      condition: { ...base(), requestDomains: [host] },
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'cookie', operation: 'set', value: serializeCookieHeader(full) }],
        responseHeaders: stripSetCookie(),
      },
    });
  }

  // A host needs its own http rule if it holds Secure cookies, or if a parent host does (the parent's
  // higher-priority http rule would otherwise also win for this host and hide its own cookies).
  const insecureHosts: string[] = [];
  const byDepth = [...plans].sort((a, b) => labelCount(a.host) - labelCount(b.host) || (a.host < b.host ? -1 : 1));
  for (const { host, full, plain } of byDepth) {
    if (isPotentiallyTrustworthyHost(host)) continue;
    const differs = plain.length !== full.length;
    if (differs || insecureHosts.some((parent) => isSameOrSubdomain(host, parent))) insecureHosts.push(host);
  }
  for (const host of insecureHosts) {
    const plain = plans.find((p) => p.host === host)?.plain ?? [];
    emit({
      priority: insecureRulePriority(host),
      condition: { ...base(), requestDomains: [host], urlFilter: '|http://' },
      action: {
        type: 'modifyHeaders',
        requestHeaders:
          plain.length > 0
            ? [{ header: 'cookie', operation: 'set', value: serializeCookieHeader(plain) }]
            : [{ header: 'cookie', operation: 'remove' }],
        responseHeaders: stripSetCookie(),
      },
    });
  }

  emit({
    priority: BEACON_PRIORITY,
    condition: { ...base(), urlFilter: BEACON_URL_FILTER },
    action: { type: 'redirect', redirect: { url: beaconDataUrl(buildBeaconPayload(containerId, jar, topLevelSite, now)) } },
  });

  return { addRules, ruleIds: addRules.map((rule) => rule.id) };
}

/**
 * The beacon is per tab, not per host: one rule answers every frame of the tab. Besides the container ID it carries
 * a snapshot of the tab's non-HttpOnly cookies. The ISOLATED content script rebuilds a `CookieJar` from `k` and
 * answers `document.cookie` for its own host locally, which avoids one beacon rule per host.
 */
export function buildBeaconPayload(
  containerId: ContainerId,
  jar: CookieJar,
  topLevelSite: string | null,
  now: number,
): BeaconPayload {
  const visible = jar
    .all()
    .filter((c) => !c.httpOnly && !isExpired(c, now) && (!c.partitioned || (topLevelSite !== null && c.partitionKey === topLevelSite)));
  if (JSON.stringify(visible).length > BEACON_COOKIE_BYTE_LIMIT) return { c: containerId, o: 1 };
  return { c: containerId, k: visible, s: topLevelSite };
}

export function beaconDataUrl(payload: BeaconPayload): string {
  return `data:application/json,${encodeURIComponent(JSON.stringify(payload))}`;
}

export function totalRuleCount(compiled: Iterable<Pick<CompiledTabRules, 'ruleIds'>>): number {
  let total = 0;
  for (const { ruleIds } of compiled) total += ruleIds.length;
  return total;
}

export function isOverSoftLimit(total: number): boolean {
  return total > SESSION_RULE_SOFT_LIMIT;
}
