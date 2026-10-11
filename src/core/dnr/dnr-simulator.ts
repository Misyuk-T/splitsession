import { registrableDomain } from '../site';
import type { DnrRule } from './rule-compiler';

/**
 * Test helper: a small model of declarativeNetRequest matching for the rule shapes Facet emits. Supports `tabIds`,
 * `resourceTypes`, `requestDomains`, `initiatorDomains`, `domainType` (request vs initiator site; no initiator counts as
 * third-party, as measured in Chrome 156), `requestMethods`, `urlFilter` (`||`, `|`, `^`, `*`) and `regexFilter`; picks
 * the deciding allow/block/redirect rule by priority and Chrome's precedence, then the modifyHeaders rules an allow does not cancel. Not a full
 * implementation: good enough to assert which `Cookie` header a request ends up with.
 */
export interface SimulatedRequest {
  url: string;
  tabId: number;
  type?: string;
  /** Origin of the initiator, e.g. `http://a.localhost:3000`. Absent: browser-initiated. */
  initiator?: string;
  /** Lowercase HTTP method, default `get`. */
  method?: string;
}

export type SimulatedOutcome =
  | { kind: 'none' }
  | { kind: 'cookie'; value: string | null; rule: DnrRule }
  | { kind: 'redirect'; url: string; rule: DnrRule }
  | { kind: 'block'; rule: DnrRule }
  /** An allow rule decided and no modifyHeaders rule above it: the request goes out untouched. */
  | { kind: 'allow'; rule: DnrRule };

const hostOf = (url: string): string => new URL(url).hostname.replace(/^\[|\]$/g, '');
const domainListMatches = (host: string, domains: readonly string[]): boolean =>
  domains.some((d) => host === d || host.endsWith(`.${d}`));

export function urlFilterToRegExp(filter: string): RegExp {
  let source = '';
  let rest = filter;
  if (rest.startsWith('||')) {
    source += '^[a-z][a-z0-9+.-]*://(?:[^/?#]*\\.)?';
    rest = rest.slice(2);
  } else if (rest.startsWith('|')) {
    source += '^';
    rest = rest.slice(1);
  }
  let tail = '';
  if (rest.endsWith('|')) {
    tail = '$';
    rest = rest.slice(0, -1);
  }
  for (const ch of rest) {
    if (ch === '*') source += '.*';
    else if (ch === '^') source += '(?:[^A-Za-z0-9_\\-.%]|$)';
    else source += ch.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
  return new RegExp(source + tail, 'i');
}

export function ruleMatches(rule: DnrRule, req: SimulatedRequest): boolean {
  const c = rule.condition;
  const type = req.type ?? 'main_frame';
  if (c.tabIds && !c.tabIds.includes(req.tabId)) return false;
  if (!c.resourceTypes.includes(type as never)) return false;
  const host = hostOf(req.url);
  if (c.requestDomains && !domainListMatches(host, c.requestDomains)) return false;
  if (c.initiatorDomains) {
    if (!req.initiator) return false;
    if (!domainListMatches(hostOf(req.initiator), c.initiatorDomains)) return false;
  }
  if (c.domainType) {
    const siteOfHost = (h: string) => registrableDomain(h) ?? h;
    const third = !req.initiator || siteOfHost(hostOf(req.initiator)) !== siteOfHost(host);
    if ((c.domainType === 'thirdParty') !== third) return false;
  }
  if (c.requestMethods && !c.requestMethods.includes(req.method ?? 'get')) return false;
  if (c.urlFilter !== undefined && !urlFilterToRegExp(c.urlFilter).test(req.url)) return false;
  if (c.regexFilter !== undefined && !new RegExp(c.regexFilter).test(req.url)) return false;
  return true;
}

export function simulate(rules: readonly DnrRule[], req: SimulatedRequest): SimulatedOutcome {
  const matching = rules.filter((r) => ruleMatches(r, req));
  if (matching.length === 0) return { kind: 'none' };
  // The deciding action: highest priority among allow/block/redirect; at equal priority allow, then block, then
  // redirect (Chrome's precedence). Block and redirect end the request; allow cancels modifyHeaders rules of its
  // priority or below.
  const rank = (r: DnrRule) => (r.action.type === 'allow' ? 0 : r.action.type === 'block' ? 1 : 2);
  const deciding = matching.filter((r) => r.action.type !== 'modifyHeaders').sort((a, b) => b.priority - a.priority || rank(a) - rank(b))[0];
  if (deciding?.action.type === 'block') return { kind: 'block', rule: deciding };
  if (deciding?.action.type === 'redirect') return { kind: 'redirect', url: deciding.action.redirect.url, rule: deciding };
  const floor = deciding?.action.type === 'allow' ? deciding.priority : -Infinity;
  const top = matching.filter((r) => r.action.type === 'modifyHeaders' && r.priority > floor).sort((a, b) => b.priority - a.priority)[0];
  if (!top || top.action.type !== 'modifyHeaders') return deciding ? { kind: 'allow', rule: deciding } : { kind: 'none' };
  const op = top.action.requestHeaders?.find((h) => h.header === 'cookie');
  return { kind: 'cookie', value: op?.operation === 'set' ? (op.value ?? '') : null, rule: top };
}

/** Cookie header a request would carry under `rules` (null = header removed, undefined = no rule matched). */
export function cookieHeaderFor(rules: readonly DnrRule[], req: SimulatedRequest): string | null | undefined {
  const outcome = simulate(rules, req);
  if (outcome.kind === 'none' || outcome.kind === 'allow') return undefined;
  if (outcome.kind === 'redirect' || outcome.kind === 'block') throw new Error(`unexpected ${outcome.kind} for ${req.url}`);
  return outcome.value;
}
