import { type ContainerId, type Cookie, cookieKey } from "../../core";
import { type CookieChange, missesChange } from "./stale-detector";

/**
 * Keeps a stale navigation's answer from overwriting the cookie it missed.
 *
 * A login answers with a redirect and `Set-Cookie: SESS=new`; Chrome follows it at once, before the container's rules
 * carry the new cookie, so the next hop goes out without it (or with the old value). A Drupal 10 site answers such a
 * request with a NEW anonymous session (`Set-Cookie: SESS=anon`) and the "your browser must accept cookies" error. In
 * a plain browser that request would have carried `SESS=new` and the overwrite never happens; in a container, importing
 * it replaced the fresh login session in the jar, so the stale-hop re-navigation had nothing left to repeat with.
 *
 * Rule: for a top-level GET sent after a change of cookie C (in `[from, rules + lag)`) whose `Cookie` header does not
 * reflect C although C applies to the request (host, path, Secure, not Strict, not partitioned), a `Set-Cookie` with
 * C's identity (name, domain, host-only, path, partition) is not imported. Its other cookies are. The request itself is
 * repeated by the stale-hop detector, and that answer is imported as usual.
 */
export interface RecentChangeOptions {
  now?: () => number;
  /** How long after the rules resolved a request may still have used the old rules (default 1 s). */
  lagMs?: number;
  /** How long a change is remembered (default 10 s). */
  retentionMs?: number;
}

export interface StaleRequest {
  url: string;
  method: string;
  /** `onSendHeaders` time of the hop the response answers. */
  sentAt: number;
  /** The `Cookie` header that hop actually carried. */
  cookie: string | null;
}

interface Entry {
  containerId: ContainerId;
  from: number;
  /** When the rules carrying the change resolved; null while they are still being installed. */
  until: number | null;
  changes: readonly CookieChange[];
}

/** RFC 6265 5.1.4 path-match. */
export function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}

/** Same jar identity (name, domain, host-only, path, partition key). */
export function sameCookie(change: CookieChange, cookie: Cookie): boolean {
  if (change.path === undefined) return false;
  return (
    cookieKey({
      name: change.name,
      domain: change.domain,
      hostOnly: change.hostOnly,
      path: change.path,
      partitionKey: change.partitionKey ?? null,
    }) === cookieKey(cookie)
  );
}

export class RecentCookieChanges {
  private entries: Entry[] = [];
  private readonly now: () => number;
  private readonly lagMs: number;
  private readonly retentionMs: number;

  constructor(options: RecentChangeOptions = {}) {
    this.now = options.now ?? Date.now;
    this.lagMs = options.lagMs ?? 1_000;
    this.retentionMs = options.retentionMs ?? 10_000;
  }

  /** A change of the container's jar at `from`; call `settle` on the handle once its rules resolved. */
  open(
    containerId: ContainerId,
    from: number,
    changes: readonly CookieChange[],
  ): { settle: (until: number) => void } {
    this.prune();
    const entry: Entry = {
      containerId,
      from,
      until: null,
      changes: [...changes],
    };
    this.entries.push(entry);
    return {
      settle: (until) => {
        entry.until = until;
      },
    };
  }

  /** The container's changes a top-level GET missed: sent after them, before their rules applied, without them. */
  missedBy(containerId: ContainerId, req: StaleRequest): CookieChange[] {
    this.prune();
    if (req.method.toUpperCase() !== "GET") return [];
    let path: string;
    try {
      path = new URL(req.url).pathname || "/";
    } catch {
      return [];
    }
    const out: CookieChange[] = [];
    for (const entry of this.entries) {
      if (
        entry.containerId !== containerId ||
        req.sentAt < entry.from ||
        (entry.until !== null && req.sentAt >= entry.until + this.lagMs)
      )
        continue;
      for (const change of entry.changes)
        if (
          change.path !== undefined &&
          pathMatches(path, change.path) &&
          missesChange(req, change)
        )
          out.push(change);
    }
    return out;
  }

  private prune(): void {
    const cutoff = this.now() - this.retentionMs;
    this.entries = this.entries.filter(
      (e) => (e.until ?? e.from) + this.lagMs >= cutoff,
    );
  }
}
