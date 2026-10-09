import { hostnameOf, isIpHost, isPublicSuffix, registrableDomain } from './site';
import type { ContainerId } from './types';

/** `chrome.storage.local` key holding the rule list. */
export const DOMAIN_RULES_KEY = 'domainRules';

export type RuleAction = 'always' | 'ask';

/** One rule per registrable domain (eTLD+1). `containerId` is set exactly for `always`. */
export interface DomainRule {
  domain: string;
  action: RuleAction;
  containerId?: ContainerId;
}

export type DomainCheck = { ok: true; domain: string } | { ok: false; message: string };

/**
 * What a rule is keyed by: the registrable domain of a host or URL, or the bare host for hosts without one
 * (IP addresses, `localhost`). Null for anything that is not an http(s) site.
 */
export function ruleKeyOf(hostOrUrl: string): string | null {
  const trimmed = hostOrUrl.trim();
  if (trimmed === '') return null;
  let host: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    host = hostnameOf(url.hostname);
  } else {
    // "github.com", "github.com/login", "www.github.com:8080": take what a browser would call the host.
    let url: URL;
    try {
      url = new URL(`http://${trimmed}`);
    } catch {
      return null;
    }
    host = hostnameOf(url.hostname);
  }
  if (host === '' || /[\s/]/.test(host)) return null;
  return registrableDomain(host) ?? host;
}

/** Validates what the user typed into the "domain" field of a rule and reduces it to its registrable domain. */
export function normalizeRuleDomain(input: string): DomainCheck {
  const raw = input.trim();
  if (raw === '') return { ok: false, message: 'Enter a site, for example github.com.' };
  if (/\s/.test(raw)) return { ok: false, message: 'A site cannot contain spaces.' };
  if (raw.length > 253) return { ok: false, message: 'That address is too long.' };
  const key = ruleKeyOf(raw);
  if (key === null) return { ok: false, message: 'That does not look like a site address.' };
  const host = key.replace(/^\[|\]$/g, '');
  if (!isIpHost(host) && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(key.replace(/\.$/, ''))) {
    // Punycode is fine; raw non-ASCII labels arrive here already converted by the URL parser.
    return { ok: false, message: 'Use letters, digits, dots and dashes only.' };
  }
  if (isPublicSuffix(host)) return { ok: false, message: `“${key}” is a public suffix, not a single site.` };
  return { ok: true, domain: key };
}

/** The rule that applies to a URL, if any. */
export function findRule(rules: readonly DomainRule[], url: string): DomainRule | undefined {
  const key = ruleKeyOf(url);
  return key === null ? undefined : rules.find((r) => r.domain === key);
}

export type RuleCheck = { ok: true; rule: DomainRule } | { ok: false; message: string };

/** Validates a rule (from the options form, the API or an imported file). `known` are the existing container IDs. */
export function validateRule(raw: unknown, known: ReadonlySet<ContainerId>): RuleCheck {
  if (typeof raw !== 'object' || raw === null) return { ok: false, message: 'A rule must be an object.' };
  const r = raw as Record<string, unknown>;
  if (typeof r.domain !== 'string') return { ok: false, message: 'A rule needs a "domain".' };
  const domain = normalizeRuleDomain(r.domain);
  if (!domain.ok) return { ok: false, message: domain.message };
  if (r.action === 'ask') return { ok: true, rule: { domain: domain.domain, action: 'ask' } };
  if (r.action !== 'always') return { ok: false, message: 'A rule\'s action must be "always" or "ask".' };
  if (typeof r.containerId !== 'string' || r.containerId === '') return { ok: false, message: 'Choose the container for “always open in”.' };
  if (!known.has(r.containerId)) return { ok: false, message: 'That container does not exist.' };
  return { ok: true, rule: { domain: domain.domain, action: 'always', containerId: r.containerId } };
}

export type RuleDecision = { kind: 'none' } | { kind: 'move'; containerId: ContainerId } | { kind: 'ask' };

/**
 * What a rule asks for when a tab currently in `current` (null: no container) navigates to the rule's site.
 * Whether the navigation is exempt (explicitly placed tab) is the caller's business.
 */
export function decideRule(rule: DomainRule | undefined, current: ContainerId | null): RuleDecision {
  if (!rule) return { kind: 'none' };
  if (rule.action === 'ask') return { kind: 'ask' };
  if (rule.containerId === undefined || rule.containerId === current) return { kind: 'none' };
  return { kind: 'move', containerId: rule.containerId };
}

/** Rules without their container (after a container was deleted) can never fire: drop them. */
export function pruneRules(rules: readonly DomainRule[], known: ReadonlySet<ContainerId>): DomainRule[] {
  return rules.filter((r) => r.action === 'ask' || (r.containerId !== undefined && known.has(r.containerId)));
}

/** Insert or replace by domain; the list stays sorted by domain. */
export function upsertRule(rules: readonly DomainRule[], rule: DomainRule): DomainRule[] {
  return [...rules.filter((r) => r.domain !== rule.domain), rule].sort((a, b) => a.domain.localeCompare(b.domain));
}

export function isDomainRule(x: unknown): x is DomainRule {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  if (typeof r.domain !== 'string' || r.domain === '') return false;
  if (r.action === 'ask') return r.containerId === undefined;
  return r.action === 'always' && typeof r.containerId === 'string' && r.containerId !== '';
}

// ---- Navigation URL helpers for the choose page and the rule engine ----

/**
 * The container reference in a `#ctr=<name or id>` marker (see Facet.handleCtrMarker), or null when the address has
 * none. Same grammar as the engine's: `ctr` is one `&`-separated parameter of the fragment.
 */
export function ctrMarkerRef(url: string): string | null {
  const hashAt = url.indexOf('#');
  if (hashAt === -1) return null;
  const match = /(?:^|&)ctr=([^&]*)/.exec(url.slice(hashAt + 1));
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
}

export const hasCtrMarker = (url: string): boolean => ctrMarkerRef(url) !== null;

/** The address the choose page was opened for. Only http(s) addresses are acceptable. */
export function parseChooseParams(search: string): { url: string | null; tab: number | null } {
  const params = new URLSearchParams(search);
  const raw = params.get('url');
  let url: string | null = null;
  if (raw) {
    try {
      const parsed = new URL(raw);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') url = parsed.href;
    } catch {
      url = null;
    }
  }
  const tabRaw = params.get('tab');
  const tab = tabRaw !== null && /^\d{1,10}$/.test(tabRaw) ? Number(tabRaw) : null;
  return { url, tab };
}
