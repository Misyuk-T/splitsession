import {
  domainMatches,
  hostnameOf,
  isIpHost,
  isPublicSuffix,
  isSecureUrl,
} from "../site";
import type { Cookie, SameSite } from "../types";

/** Chrome (and RFC 6265bis section 5.5) cap cookie lifetime at 400 days. */
export const MAX_COOKIE_LIFETIME_MS = 400 * 24 * 60 * 60 * 1000;
const MAX_NAME_VALUE_LENGTH = 4096;
const MAX_ATTRIBUTE_VALUE_LENGTH = 1024;
/** Stored for cookies deleted via Max-Age <= 0 / a past Expires; any value <= now means "expired". */
const EXPIRED = 0;

export interface ParseContext {
  /** URL of the request (or document) the cookie came from. */
  url: string;
  /** Epoch milliseconds; defaults to `Date.now()`. */
  now?: number;
  /** Top-level site (`siteOf`) of the tab. Becomes the partition key of `Partitioned` cookies. */
  topLevelSite?: string | null;
  /** The string came from `document.cookie = ...` rather than a response header. */
  fromScript?: boolean;
}

export type ParseRejection =
  | "control-characters"
  | "empty"
  | "too-long"
  | "invalid-url"
  | "invalid-domain"
  | "public-suffix"
  | "secure-from-insecure-origin"
  | "samesite-none-requires-secure"
  | "partitioned-requires-secure"
  | "prefix-violation"
  | "httponly-from-script";

export type ParseResult =
  { ok: true; cookie: Cookie } | { ok: false; reason: ParseRejection };

// eslint-disable-next-line no-control-regex -- RFC 6265 forbids control characters in a cookie, so the pattern names them
const CONTROL_CHARS = /[\x00-\x08\x0A-\x1F\x7F]/;
const WSP_EDGES = /^[ \t]+|[ \t]+$/g;

const trim = (s: string): string => s.replace(WSP_EDGES, "");
const reject = (reason: ParseRejection): ParseResult => ({ ok: false, reason });

/**
 * Parses one `Set-Cookie` header value (or a `document.cookie` assignment) the way a user agent
 * stores it: RFC 6265bis section 5.6 plus the checks of section 5.7 that do not need a cookie store.
 */
export function parseSetCookie(header: string, ctx: ParseContext): ParseResult {
  if (CONTROL_CHARS.test(header)) return reject("control-characters");

  let url: URL;
  try {
    url = new URL(ctx.url);
  } catch {
    return reject("invalid-url");
  }
  const host = hostnameOf(url.hostname);
  if (host === "") return reject("invalid-url");
  const now = ctx.now ?? Date.now();

  const semi = header.indexOf(";");
  const nameValue = semi === -1 ? header : header.slice(0, semi);
  const attributeString = semi === -1 ? "" : header.slice(semi + 1);

  // Nameless cookies ("foo") are accepted, like browsers do: name '' and value 'foo'.
  const eq = nameValue.indexOf("=");
  const name = trim(eq === -1 ? "" : nameValue.slice(0, eq));
  const value = trim(eq === -1 ? nameValue : nameValue.slice(eq + 1));
  if (name === "" && value === "") return reject("empty");
  if (name.length + value.length > MAX_NAME_VALUE_LENGTH)
    return reject("too-long");

  let domainAttr: string | null = null;
  let pathAttr: string | null = null;
  let expiresAttr: number | null = null;
  let maxAgeAttr: number | null = null;
  let secure = false;
  let httpOnly = false;
  let partitioned = false;
  let sameSite: SameSite = "unspecified";

  for (const raw of attributeString.split(";")) {
    const attr = trim(raw);
    if (attr === "") continue;
    const attrEq = attr.indexOf("=");
    const attrName = trim(
      attrEq === -1 ? attr : attr.slice(0, attrEq),
    ).toLowerCase();
    const attrValue = attrEq === -1 ? "" : trim(attr.slice(attrEq + 1));
    if (attrValue.length > MAX_ATTRIBUTE_VALUE_LENGTH) continue;

    switch (attrName) {
      case "expires": {
        const parsed = parseCookieDate(attrValue);
        if (parsed !== null) expiresAttr = parsed;
        break;
      }
      case "max-age": {
        if (/^-?\d+$/.test(attrValue)) {
          const seconds = Number(attrValue);
          maxAgeAttr = seconds <= 0 ? EXPIRED : now + seconds * 1000;
        }
        break;
      }
      case "domain":
        if (attrValue !== "") domainAttr = attrValue;
        break;
      case "path":
        pathAttr = attrValue;
        break;
      case "secure":
        secure = true;
        break;
      case "httponly":
        httpOnly = true;
        break;
      case "partitioned":
        partitioned = true;
        break;
      case "samesite": {
        const v = attrValue.toLowerCase();
        sameSite =
          v === "strict" || v === "lax" || v === "none" ? v : "unspecified";
        break;
      }
    }
  }

  if (httpOnly && ctx.fromScript) return reject("httponly-from-script");
  if (secure && !isSecureUrl(ctx.url))
    return reject("secure-from-insecure-origin");
  if (sameSite === "none" && !secure)
    return reject("samesite-none-requires-secure");
  if (partitioned && !secure) return reject("partitioned-requires-secure");

  const path =
    pathAttr !== null && pathAttr.startsWith("/")
      ? pathAttr
      : defaultPath(url.pathname);

  // Cookie prefixes (RFC 6265bis 4.1.3). A nameless cookie is checked against its value.
  // `__Host-` is checked against the final path like Chrome does, so default-path "/" qualifies.
  const prefixed = (name === "" ? value : name).toLowerCase();
  if (prefixed.startsWith("__secure-") && !secure)
    return reject("prefix-violation");
  if (
    prefixed.startsWith("__host-") &&
    (!secure || domainAttr !== null || path !== "/")
  ) {
    return reject("prefix-violation");
  }

  const scope = resolveDomain(host, domainAttr);
  if (scope === null) return reject("invalid-domain");
  if (scope === "public-suffix") return reject("public-suffix");

  // Max-Age wins over Expires (RFC 6265 5.3 step 3).
  let expires = maxAgeAttr ?? expiresAttr;
  if (expires !== null)
    expires = Math.max(
      EXPIRED,
      Math.min(expires, now + MAX_COOKIE_LIFETIME_MS),
    );

  return {
    ok: true,
    cookie: {
      name,
      value,
      domain: scope.domain,
      hostOnly: scope.hostOnly,
      path,
      secure,
      httpOnly,
      sameSite,
      partitioned,
      partitionKey: partitioned ? (ctx.topLevelSite ?? null) : null,
      expires,
      creationTime: now,
    },
  };
}

interface DomainScope {
  domain: string;
  hostOnly: boolean;
}

/** RFC 6265 5.3 steps 5-6. Returns null when the Domain attribute is unusable for this host. */
function resolveDomain(
  host: string,
  domainAttr: string | null,
): DomainScope | "public-suffix" | null {
  if (domainAttr === null) return { domain: host, hostOnly: true };

  const stripped = (
    domainAttr.startsWith(".") ? domainAttr.slice(1) : domainAttr
  ).toLowerCase();
  const domain = canonicalizeHost(stripped);
  if (domain === null) return null;

  if (isIpHost(host))
    return domain === host ? { domain: host, hostOnly: true } : null;
  if (isPublicSuffix(domain))
    return domain === host ? { domain: host, hostOnly: true } : "public-suffix";
  if (!domainMatches(host, domain)) return null;
  return { domain, hostOnly: false };
}

/** Lowercases and punycodes a domain via the URL parser; null for anything that is not a plausible host. */
function canonicalizeHost(domain: string): string | null {
  if (domain === "" || /[\s/\\?#@:]/.test(domain)) return null;
  try {
    return hostnameOf(new URL(`http://${domain}/`).hostname) || null;
  } catch {
    return null;
  }
}

/** RFC 6265 5.1.4 default-path. */
export function defaultPath(requestPath: string): string {
  if (!requestPath.startsWith("/")) return "/";
  const lastSlash = requestPath.lastIndexOf("/");
  return lastSlash === 0 ? "/" : requestPath.slice(0, lastSlash);
}

const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];
// eslint-disable-next-line no-control-regex -- RFC 6265 section 5.1.1 date delimiters include \x09
const DATE_DELIMITERS = /[\x09\x20-\x2F\x3B-\x40\x5B-\x60\x7B-\x7E]+/;
const TIME_TOKEN = /^(\d{1,2}):(\d{1,2}):(\d{1,2})(?:\D.*)?$/;
const DAY_TOKEN = /^(\d{1,2})(?:\D.*)?$/;
const YEAR_TOKEN = /^(\d{2,4})(?:\D.*)?$/;

/** RFC 6265 5.1.1 cookie-date algorithm. Returns epoch milliseconds or null when the date is invalid. */
export function parseCookieDate(input: string): number | null {
  let time: [number, number, number] | null = null;
  let day: number | null = null;
  let month: number | null = null;
  let year: number | null = null;

  for (const token of input.split(DATE_DELIMITERS)) {
    if (token === "") continue;
    let m: RegExpExecArray | null;
    if (time === null && (m = TIME_TOKEN.exec(token))) {
      time = [Number(m[1]), Number(m[2]), Number(m[3])];
    } else if (day === null && (m = DAY_TOKEN.exec(token))) {
      day = Number(m[1]);
    } else if (
      month === null &&
      MONTHS.includes(token.slice(0, 3).toLowerCase())
    ) {
      month = MONTHS.indexOf(token.slice(0, 3).toLowerCase());
    } else if (year === null && (m = YEAR_TOKEN.exec(token))) {
      year = Number(m[1]);
    }
  }

  if (time === null || day === null || month === null || year === null)
    return null;
  if (year >= 70 && year <= 99) year += 1900;
  else if (year >= 0 && year <= 69) year += 2000;

  const [hours, minutes, seconds] = time;
  if (
    day < 1 ||
    day > 31 ||
    year < 1601 ||
    hours > 23 ||
    minutes > 59 ||
    seconds > 59
  )
    return null;
  return Date.UTC(year, month, day, hours, minutes, seconds);
}
