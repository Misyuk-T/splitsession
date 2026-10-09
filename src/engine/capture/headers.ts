/** `webRequest.HttpHeaders` entry. With `extraHeaders`, `Set-Cookie` arrives as one entry per header line. */
export interface HttpHeaderLike {
  name: string;
  value?: string;
  binaryValue?: ArrayLike<number>;
}

/** All `Set-Cookie` values of a response (non-UTF-8 values come as `binaryValue` bytes: decoded as Latin-1). */
export function setCookieHeaders(headers: readonly HttpHeaderLike[] | undefined): string[] {
  if (!headers) return [];
  const out: string[] = [];
  for (const header of headers) {
    if (header.name.toLowerCase() !== 'set-cookie') continue;
    if (header.value !== undefined) out.push(...splitFolded(header.value));
    else if (header.binaryValue) out.push(...splitFolded(String.fromCharCode(...Array.from(header.binaryValue))));
  }
  return out.filter((v) => v.trim() !== '');
}

/** Some stacks fold several Set-Cookie lines into one value separated by newlines. Never split on commas. */
function splitFolded(value: string): string[] {
  return value.includes('\n') ? value.split(/\r?\n/) : [value];
}

/** Scheme + host + port of a URL, or null for opaque / non-network URLs. */
export function networkOrigin(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}
