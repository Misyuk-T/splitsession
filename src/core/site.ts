import { parse } from "tldts";

// Private-registry suffixes (github.io, blogspot.com, ...) count as public suffixes, as in Chrome.
const TLDTS_OPTIONS = { allowPrivateDomains: true } as const;

/** Lowercased hostname of a host or URL. IPv6 literals come back without brackets. */
export function hostnameOf(hostOrUrl: string): string {
  return parse(hostOrUrl, TLDTS_OPTIONS).hostname ?? hostOrUrl.toLowerCase();
}

export function isIpHost(host: string): boolean {
  return parse(host, TLDTS_OPTIONS).isIp === true;
}

/** eTLD+1, or null for IP addresses, bare public suffixes and empty input. */
export function registrableDomain(host: string): string | null {
  return parse(host, TLDTS_OPTIONS).domain;
}

/** True for entries of the Public Suffix List (and unknown single-label hosts such as `localhost`). */
export function isPublicSuffix(host: string): boolean {
  const { hostname, publicSuffix, isIp } = parse(host, TLDTS_OPTIONS);
  return !isIp && hostname !== null && publicSuffix === hostname;
}

/** Same registrable domain; hosts without one (IPs, `localhost`) are same-site only when identical. Accepts hosts or URLs. */
export function isSameSite(a: string, b: string): boolean {
  const da = registrableDomain(a);
  const db = registrableDomain(b);
  if (da !== null && db !== null) return da === db;
  return da === db && hostnameOf(a) === hostnameOf(b);
}

/** RFC 6265 domain-match of a request host against a cookie domain. */
export function domainMatches(host: string, domain: string): boolean {
  if (host === domain) return true;
  return host.endsWith(`.${domain}`) && !isIpHost(host);
}

/** `host` equals `ancestor` or is a subdomain of it. */
export function isSameOrSubdomain(host: string, ancestor: string): boolean {
  return host === ancestor || host.endsWith(`.${ancestor}`);
}

export function labelCount(host: string): number {
  return host.split(".").length;
}

/** Hosts Chrome treats as secure contexts even over plain HTTP (so `Secure` cookies work there). */
export function isPotentiallyTrustworthyHost(host: string): boolean {
  const h = hostnameOf(host);
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(h)
  );
}

/** https/wss, or any scheme over a trustworthy host: the requests on which `Secure` cookies may be sent. */
export function isSecureUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:" || parsed.protocol === "wss:") return true;
  if (parsed.protocol === "http:" || parsed.protocol === "ws:")
    return isPotentiallyTrustworthyHost(parsed.hostname);
  return false;
}

/** Top-level site used as CHIPS partition key: scheme plus registrable domain (or the host when it has none). */
export function siteOf(url: string): string {
  const parsed = new URL(url);
  const host = hostnameOf(parsed.hostname);
  return `${parsed.protocol.slice(0, -1)}://${registrableDomain(host) ?? host}`;
}

/** An http(s) address (the only kind containers, rules and the restore gate deal with). */
export const isHttpUrl = (url: string | null | undefined): url is string =>
  !!url && /^https?:\/\//i.test(url);
