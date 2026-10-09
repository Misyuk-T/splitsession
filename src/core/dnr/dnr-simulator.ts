import { registrableDomain } from '../site';
import type { DnrRule } from './rule-compiler';

/**
 * Test helper: a small model of declarativeNetRequest matching for the rule shapes Facet emits. Supports `tabIds`,
 * `resourceTypes`, `requestDomains`, `initiatorDomains`, `domainType` (request vs initiator site; no initiator counts as
 * third-party, as measured in Chrome 156), `requestMethods`, `urlFilter` (`||`, `|`, `^`, `*`) and `regexFilter`; picks
 * the highest-priority match (redirect beats modifyHeaders at equal priority, as in Chrome). Not a full
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
  | { kind: 'block'; rule: DnrRule };

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
  // Same priority: block, then redirect, then modifyHeaders (Chrome's action precedence).
  const rank = (r: DnrRule) => (r.action.type === 'block' ? 0 : r.action.type === 'redirect' ? 1 : 2);
  matching.sort((a, b) => b.priority - a.priority || rank(a) - rank(b));
  const top = matching[0]!;
  if (top.action.type === 'block') return { kind: 'block', rule: top };
  if (top.action.type === 'redirect') return { kind: 'redirect', url: top.action.redirect.url, rule: top };
  const op = top.action.requestHeaders?.find((h) => h.header === 'cookie');
  return { kind: 'cookie', value: op?.operation === 'set' ? (op.value ?? '') : null, rule: top };
}

/** Cookie header a request would carry under `rules` (null = header removed, undefined = no rule matched). */
export function cookieHeaderFor(rules: readonly DnrRule[], req: SimulatedRequest): string | null | undefined {
  const outcome = simulate(rules, req);
  if (outcome.kind === 'none') return undefined;
  if (outcome.kind === 'redirect' || outcome.kind === 'block') throw new Error(`unexpected ${outcome.kind} for ${req.url}`);
  return outcome.value;
}
