import { domainMatches, hostnameOf, isSecureUrl, type ContainerId } from '../../core';

/**
 * Finds top-level navigations that went out with outdated cookies, so they can be repeated once.
 *
 * Timestamps alone are not enough: Chrome resolves `updateSessionRules` slightly before the new rules apply to
 * requests already being set up (measured in Chrome 156: a 302 hop with `onSendHeaders` 0.6 ms AFTER the promise
 * resolved still went out with the old rules). So the decision uses the `Cookie` header the request actually carried
 * (`onSendHeaders` with `extraHeaders`), within a time window:
 *  - change window: cookies of container C changed at `from` (Set-Cookie seen, or a `document.cookie` write); rules
 *    resolved at `until`. A GET main-frame request of a tab of C, sent in `[from, until + lag)`, to a host the change
 *    applies to, whose Cookie header does not reflect the change, missed it (typical: the hop after a 302 login).
 *  - assignment window: a tab got its container at `activeAt` (inherited child tab, `#ctr=` marker). Its main-frame
 *    request sent before `activeAt`, or up to `lag` after it with a Cookie header the container would not send,
 *    went out as the real profile.
 * Each (tab, url) is re-navigated at most once per window, and a tab at most `maxPerTab` times per `dedupeMs`,
 * so a detector bug cannot loop.
 */
export interface MainFrameSend {
  requestId: string;
  tabId: number;
  url: string;
  method: string;
  /** `details.timeStamp` of `webRequest.onSendHeaders`. */
  sentAt: number;
  /** The `Cookie` header actually sent, null when none. */
  cookie: string | null;
}

/** A cookie that changed: requests to hosts it applies to must carry `name=value` (or not carry `name`, if deleted). */
export interface CookieChange {
  name: string;
  /** null = deleted. */
  value: string | null;
  domain: string;
  hostOnly: boolean;
  secure: boolean;
  /** Partitioned (CHIPS) cookies depend on the top-level site: not used as expectations. */
  partitioned?: boolean;
  /**
   * `strict` cookies are not used as expectations: a cross-site (or browser-initiated) top-level navigation
   * legitimately goes without them (the rules split cookies by SameSite).
   */
  sameSite?: 'strict' | 'lax' | 'none' | 'unspecified';
}

export interface ChangeWindow {
  containerId: ContainerId;
  from: number;
  until: number;
  changes: readonly CookieChange[];
}

export interface Renavigation {
  tabId: number;
  url: string;
  /** The stale request; re-navigate once it finished (a same-URL navigation while it is in flight can be dropped). */
  requestId: string;
  reason: 'stale-cookies' | 'pre-assignment';
}

export interface StaleDetectorOptions {
  containerOf: (tabId: number) => ContainerId | undefined;
  now?: () => number;
  /** How long sends and windows are remembered (default 10 s). */
  retentionMs?: number;
  /** How long after a rules promise resolved a request may still have used the old rules (default 1 s). */
  lagMs?: number;
  /** A tab's request sent this long before its assignment still counts as its stray first request (default 5 s). */
  assignmentLookbackMs?: number;
  dedupeMs?: number;
  maxPerTab?: number;
}

interface AssignmentWindow {
  tabId: number;
  activeAt: number;
  /** True when a header could not have come from the container's rules. */
  isForeign: (send: MainFrameSend) => boolean;
}

const RENAVIGABLE = /^https?:/i;

/** `a=1; b=2` -> [['a','1'], ['b','2']]; a pair without `=` is a nameless cookie. */
export function parseCookieHeader(header: string | null): Array<[string, string]> {
  if (!header) return [];
  return header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => {
      const eq = part.indexOf('=');
      return eq === -1 ? ['', part] : [part.slice(0, eq), part.slice(eq + 1)];
    });
}

export function violates(send: Pick<MainFrameSend, 'url' | 'cookie'>, changes: readonly CookieChange[]): boolean {
  let host: string;
  try {
    host = hostnameOf(new URL(send.url).hostname);
  } catch {
    return false;
  }
  const secureRequest = isSecureUrl(send.url);
  const pairs = parseCookieHeader(send.cookie);
  for (const change of changes) {
    const applies = change.hostOnly ? host === change.domain : domainMatches(host, change.domain);
    if (!applies || change.partitioned || change.sameSite === 'strict' || (change.secure && !secureRequest)) continue;
    if (change.value !== null) {
      if (!pairs.some(([n, v]) => n === change.name && v === change.value)) return true;
    } else if (pairs.some(([n]) => n === change.name)) {
      return true;
    }
  }
  return false;
}

export class StaleNavigationDetector {
  private readonly sends = new Map<string, MainFrameSend>();
  private windows: ChangeWindow[] = [];
  private assignments: AssignmentWindow[] = [];
  private readonly claimed = new Map<string, number>();
  private readonly perTab = new Map<number, number[]>();
  private readonly suppressedUntil = new Map<number, number>();
  private readonly containerOf: (tabId: number) => ContainerId | undefined;
  private readonly now: () => number;
  private readonly retentionMs: number;
  private readonly lagMs: number;
  private readonly lookbackMs: number;
  private readonly dedupeMs: number;
  private readonly maxPerTab: number;

  constructor(options: StaleDetectorOptions) {
    this.containerOf = options.containerOf;
    this.now = options.now ?? Date.now;
    this.retentionMs = options.retentionMs ?? 10_000;
    this.lagMs = options.lagMs ?? 1_000;
    this.lookbackMs = options.assignmentLookbackMs ?? 5_000;
    this.dedupeMs = options.dedupeMs ?? 10_000;
    this.maxPerTab = options.maxPerTab ?? 3;
  }

  /** Records a main-frame send (latest hop wins for a requestId) and checks it against the known windows. */
  noteSend(send: MainFrameSend): Renavigation[] {
    this.prune();
    this.sends.set(send.requestId, { ...send });
    const assignment = this.assignments.find((a) => a.tabId === send.tabId && this.inAssignment(send, a));
    if (assignment) return this.claim(send, 'pre-assignment', `a${assignment.activeAt}`);
    const containerId = this.containerOf(send.tabId);
    if (!containerId) return [];
    const hit = this.windows.find((w) => w.containerId === containerId && this.inWindow(send, w));
    return hit ? this.claim(send, 'stale-cookies', `w${hit.from}`) : [];
  }

  noteChange(window: ChangeWindow): Renavigation[] {
    this.prune();
    if (window.changes.length === 0) return [];
    this.windows.push({ ...window, changes: [...window.changes] });
    const out: Renavigation[] = [];
    for (const send of this.sends.values()) {
      if (this.containerOf(send.tabId) !== window.containerId) continue;
      if (this.inWindow(send, window)) out.push(...this.claim(send, 'stale-cookies', `w${window.from}`));
    }
    return out;
  }

  /** The tab's rules became active at `activeAt`; its main-frame requests before (or racing) that were not isolated. */
  noteAssignment(tabId: number, activeAt: number, isForeign: (send: MainFrameSend) => boolean): Renavigation[] {
    this.prune();
    const window: AssignmentWindow = { tabId, activeAt, isForeign };
    this.assignments = this.assignments.filter((a) => a.tabId !== tabId);
    this.assignments.push(window);
    let latest: MainFrameSend | undefined;
    for (const send of this.sends.values()) {
      if (send.tabId !== tabId || !this.inAssignment(send, window)) continue;
      if (!latest || send.sentAt > latest.sentAt) latest = send;
    }
    return latest ? this.claim(latest, 'pre-assignment', `a${activeAt}`) : [];
  }

  /** The caller navigates this tab itself (e.g. `#ctr=` handling): do not re-navigate it for a while. */
  suppress(tabId: number, forMs = 3_000): void {
    this.suppressedUntil.set(tabId, this.now() + forMs);
  }

  /** Most recent main-frame send of a tab, if still remembered. */
  latestSend(tabId: number): MainFrameSend | undefined {
    let latest: MainFrameSend | undefined;
    for (const send of this.sends.values()) if (send.tabId === tabId && (!latest || send.sentAt >= latest.sentAt)) latest = send;
    return latest;
  }

  forgetTab(tabId: number): void {
    for (const [id, send] of this.sends) if (send.tabId === tabId) this.sends.delete(id);
    this.assignments = this.assignments.filter((a) => a.tabId !== tabId);
  }

  private inWindow(send: MainFrameSend, w: ChangeWindow): boolean {
    return send.sentAt >= w.from && send.sentAt < w.until + this.lagMs && violates(send, w.changes);
  }

  private inAssignment(send: MainFrameSend, a: AssignmentWindow): boolean {
    if (send.sentAt < a.activeAt - this.lookbackMs || send.sentAt >= a.activeAt + this.lagMs) return false;
    return send.sentAt < a.activeAt || a.isForeign(send);
  }

  private claim(send: MainFrameSend, reason: Renavigation['reason'], windowKey: string): Renavigation[] {
    if (send.method.toUpperCase() !== 'GET' || !RENAVIGABLE.test(send.url)) return [];
    const now = this.now();
    if ((this.suppressedUntil.get(send.tabId) ?? 0) > now) return [];
    const key = `${send.tabId} ${send.url} ${windowKey}`;
    if (this.claimed.has(key)) return [];
    const recent = (this.perTab.get(send.tabId) ?? []).filter((at) => now - at < this.dedupeMs);
    if (recent.length >= this.maxPerTab) return [];
    this.claimed.set(key, now);
    this.perTab.set(send.tabId, [...recent, now]);
    return [{ tabId: send.tabId, url: send.url, requestId: send.requestId, reason }];
  }

  private prune(): void {
    const now = this.now();
    const cutoff = now - this.retentionMs;
    for (const [id, send] of this.sends) if (send.sentAt < cutoff) this.sends.delete(id);
    this.windows = this.windows.filter((w) => w.until + this.lagMs >= cutoff);
    this.assignments = this.assignments.filter((a) => a.activeAt + this.lagMs >= cutoff);
    for (const [key, at] of this.claimed) if (now - at >= this.retentionMs) this.claimed.delete(key);
    for (const [tabId, list] of this.perTab) if (list.every((at) => now - at >= this.dedupeMs)) this.perTab.delete(tabId);
    for (const [tabId, until] of this.suppressedUntil) if (until < now) this.suppressedUntil.delete(tabId);
  }
}
