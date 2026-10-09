/**
 * Build-time stand-in for `tldts` in the beacon content script only (aliased in wxt.config.ts). The full Public
 * Suffix List would add ~250 KB to a script that runs in every frame of every tab. The beacon only keeps an
 * optimistic local `document.cookie` view; the background (full PSL) is authoritative and corrects the view in
 * its reply, so the approximation here can at worst show a rejected Domain cookie for a few milliseconds.
 */
const MULTI_LABEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp', 'ne.jp', 'or.jp',
  'co.kr', 'co.in', 'com.br', 'com.cn', 'com.mx', 'com.tr', 'com.ua', 'com.pl', 'co.za', 'github.io', 'gitlab.io',
  'vercel.app', 'netlify.app', 'pages.dev', 'web.app', 'firebaseapp.com', 'herokuapp.com', 'blogspot.com',
]);

export interface LiteParseResult {
  hostname: string | null;
  domain: string | null;
  publicSuffix: string | null;
  isIp: boolean | null;
}

export function parse(input: string, _options?: unknown): LiteParseResult {
  let hostname = input.trim().toLowerCase();
  if (hostname.includes('://')) {
    try {
      hostname = new URL(hostname).hostname;
    } catch {
      return { hostname: null, domain: null, publicSuffix: null, isIp: null };
    }
  }
  hostname = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (hostname === '') return { hostname: null, domain: null, publicSuffix: null, isIp: null };
  const isIp = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':');
  if (isIp) return { hostname, domain: null, publicSuffix: null, isIp: true };
  const labels = hostname.split('.');
  const lastTwo = labels.slice(-2).join('.');
  const publicSuffix = labels.length >= 2 && MULTI_LABEL_SUFFIXES.has(lastTwo) ? lastTwo : labels[labels.length - 1]!;
  const suffixLabels = publicSuffix.split('.').length;
  const domain = labels.length > suffixLabels ? labels.slice(-(suffixLabels + 1)).join('.') : null;
  return { hostname, domain, publicSuffix, isIp: false };
}
