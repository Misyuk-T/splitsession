import type { Cookie } from '../types';
import { domainMatches, hostnameOf } from '../site';
import { parseSetCookie, type ParseContext, type ParseResult } from './set-cookie-parser';

export interface HostCookieOptions {
  /** The request goes over a secure scheme (https/wss or a trustworthy host): `Secure` cookies are eligible. */
  secure: boolean;
  /** Top-level site of the tab; partitioned (CHIPS) cookies are only visible when their partition key equals it. */
  topLevelSite?: string | null;
  /** Epoch milliseconds; defaults to `Date.now()`. */
  now?: number;
}

export type UpsertOutcome =
  /** New cookie stored. */
  | 'added'
  /** Existing cookie replaced with different data. */
  | 'updated'
  /** Same data as before (only the Set-Cookie arrived again): nothing to recompile. */
  | 'unchanged'
  /** An existing cookie was removed because the new one is already expired. */
  | 'deleted'
  /** Nothing happened: expired cookie with nothing to delete, or a script tried to overwrite an HttpOnly cookie. */
  | 'ignored';

export interface UpsertOptions {
  now?: number;
  /** Write comes from `document.cookie`: may not replace an HttpOnly cookie. */
  fromScript?: boolean;
}

export interface SerializedJar {
  version: 1;
  cookies: Cookie[];
}

type CookieIdentity = Pick<Cookie, 'name' | 'domain' | 'hostOnly' | 'path' | 'partitionKey'>;

/**
 * Identity of a cookie in the jar. Name, domain, path and partition key as in the plan; the host-only flag is
 * included too (RFC 6265bis 5.7), so a host-only cookie of `a.com` and a Domain=a.com cookie coexist.
 */
export function cookieKey(c: CookieIdentity): string {
  return [c.name, c.domain, c.hostOnly ? 'h' : 'd', c.path, c.partitionKey ?? ''].join('\u0000');
}

/** Value of the `Cookie` request header. A nameless cookie is sent as its bare value, as browsers do. */
export function serializeCookieHeader(cookies: readonly Pick<Cookie, 'name' | 'value'>[]): string {
  return cookies.map((c) => (c.name === '' ? c.value : `${c.name}=${c.value}`)).join('; ');
}

export const isExpired = (c: Pick<Cookie, 'expires'>, now: number): boolean => c.expires !== null && c.expires <= now;

/** In-memory cookie store of one container. Pure data structure: persistence and DNR wiring live elsewhere. */
export class CookieJar {
  private readonly store = new Map<string, Cookie>();

  constructor(initial: Iterable<Cookie> = []) {
    for (const cookie of initial) this.store.set(cookieKey(cookie), { ...cookie });
  }

  get size(): number {
    return this.store.size;
  }

  /** Snapshot of every stored cookie (including expired ones not yet purged), in insertion order. */
  all(): Cookie[] {
    return [...this.store.values()].map((c) => ({ ...c }));
  }

  clear(): void {
    this.store.clear();
  }

  /** RFC 6265bis 5.7 storage step: replace-or-add, keeping the old creation time; an expired cookie deletes. */
  upsert(cookie: Cookie, { now = Date.now(), fromScript = false }: UpsertOptions = {}): UpsertOutcome {
    const key = cookieKey(cookie);
    const existing = this.store.get(key);

    if (existing?.httpOnly && fromScript) return 'ignored';

    if (isExpired(cookie, now)) {
      if (!existing) return 'ignored';
      this.store.delete(key);
      return 'deleted';
    }

    const next: Cookie = { ...cookie, creationTime: existing?.creationTime ?? cookie.creationTime };
    if (!existing) {
      this.store.set(key, next);
      return 'added';
    }
    const outcome = sameCookieData(existing, next) ? 'unchanged' : 'updated';
    this.store.set(key, next);
    return outcome;
  }

  /** Parses a `Set-Cookie` header and stores the result. */
  setFromHeader(header: string, ctx: ParseContext): { parsed: ParseResult; outcome: UpsertOutcome } {
    const parsed = parseSetCookie(header, ctx);
    if (!parsed.ok) return { parsed, outcome: 'ignored' };
    const outcome = this.upsert(parsed.cookie, { now: ctx.now ?? parsed.cookie.creationTime, fromScript: ctx.fromScript });
    return { parsed, outcome };
  }

  remove(identity: CookieIdentity): boolean {
    return this.store.delete(cookieKey(identity));
  }

  /** Drops expired cookies; returns how many were removed. */
  purgeExpired(now: number = Date.now()): number {
    let removed = 0;
    for (const [key, cookie] of this.store) {
      if (isExpired(cookie, now)) {
        this.store.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /** Distinct cookie domains that currently hold at least one unexpired cookie, sorted. */
  hosts(now: number = Date.now()): string[] {
    const hosts = new Set<string>();
    for (const cookie of this.store.values()) if (!isExpired(cookie, now)) hosts.add(cookie.domain);
    return [...hosts].sort();
  }

  /**
   * Cookies a request to `host` would carry: domain-match or host-only, `Secure`, expiry, partition.
   * Paths are deliberately not matched (accepted limitation: header rules cannot express them), but the
   * result is ordered like RFC 6265 5.4: longer path first, then older creation time first.
   */
  cookiesForHost(host: string, { secure, topLevelSite = null, now = Date.now() }: HostCookieOptions): Cookie[] {
    const target = hostnameOf(host);
    const matches: Cookie[] = [];
    for (const cookie of this.store.values()) {
      if (isExpired(cookie, now)) continue;
      if (cookie.secure && !secure) continue;
      if (cookie.partitioned && (topLevelSite === null || cookie.partitionKey !== topLevelSite)) continue;
      const hostMatches = cookie.hostOnly ? cookie.domain === target : domainMatches(target, cookie.domain);
      if (hostMatches) matches.push({ ...cookie });
    }
    // Array#sort is stable, so equal path length and creation time keep insertion order.
    return matches.sort((a, b) => b.path.length - a.path.length || a.creationTime - b.creationTime);
  }

  /** What `document.cookie` returns on `host`: the same cookies minus HttpOnly ones. */
  documentCookieString(host: string, options: HostCookieOptions): string {
    return serializeCookieHeader(this.cookiesForHost(host, options).filter((c) => !c.httpOnly));
  }

  /**
   * Applies `document.cookie = value` made by a page on `host`.
   * Script writes never create HttpOnly cookies: a string carrying the HttpOnly attribute is rejected
   * (Chrome and RFC 6265bis behaviour), and a script cannot overwrite an existing HttpOnly cookie.
   */
  applyDocumentCookieWrite(
    host: string,
    value: string,
    { secure, path = '/', topLevelSite = null, now = Date.now() }: HostCookieOptions & { path?: string },
  ): { parsed: ParseResult; outcome: UpsertOutcome } {
    const url = `${secure ? 'https' : 'http'}://${hostnameForUrl(host)}${path.startsWith('/') ? path : `/${path}`}`;
    return this.setFromHeader(value, { url, now, topLevelSite, fromScript: true });
  }

  toJSON(): SerializedJar {
    return { version: 1, cookies: this.all() };
  }

  /** Tolerant loader for data read from storage: malformed entries are skipped, unknown versions yield an empty jar. */
  static fromJSON(data: unknown): CookieJar {
    if (typeof data !== 'object' || data === null) return new CookieJar();
    const { version, cookies } = data as Partial<SerializedJar>;
    if (version !== 1 || !Array.isArray(cookies)) return new CookieJar();
    return new CookieJar(cookies.filter(isCookie));
  }
}

function hostnameForUrl(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function sameCookieData(a: Cookie, b: Cookie): boolean {
  return (
    a.value === b.value &&
    a.secure === b.secure &&
    a.httpOnly === b.httpOnly &&
    a.sameSite === b.sameSite &&
    a.partitioned === b.partitioned &&
    a.expires === b.expires
  );
}

const SAME_SITE_VALUES = new Set(['strict', 'lax', 'none', 'unspecified']);

function isCookie(x: unknown): x is Cookie {
  if (typeof x !== 'object' || x === null) return false;
  const c = x as Record<string, unknown>;
  return (
    typeof c.name === 'string' &&
    typeof c.value === 'string' &&
    typeof c.domain === 'string' &&
    typeof c.hostOnly === 'boolean' &&
    typeof c.path === 'string' &&
    typeof c.secure === 'boolean' &&
    typeof c.httpOnly === 'boolean' &&
    typeof c.sameSite === 'string' &&
    SAME_SITE_VALUES.has(c.sameSite) &&
    typeof c.partitioned === 'boolean' &&
    (c.partitionKey === null || typeof c.partitionKey === 'string') &&
    (c.expires === null || typeof c.expires === 'number') &&
    typeof c.creationTime === 'number'
  );
}
