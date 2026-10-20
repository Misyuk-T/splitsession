import type { Browser } from "wxt/browser";

import {
  beaconSiteOf,
  type ContainerId,
  type Cookie,
  cookieKey,
  type CookieSnapshotReply,
  deleteWhere,
  hostnameOf,
  isSecureUrl,
  parseSetCookie,
  scriptVisibleCookies,
  sleep,
  type UpsertOutcome,
} from "../../core";
import { setCookieHeaders } from "../../engine/capture/headers";
import {
  type CookieChange,
  type MainFrameSend,
  parseCookieHeader,
  type Renavigation,
  type StaleNavigationDetector,
} from "../../engine/capture/stale-detector";
import {
  RecentCookieChanges,
  sameCookie,
} from "../../engine/capture/stale-response";
import type { SessionRuleManager } from "../../engine/dnr/session-rules";
import type { EngineCore, WebRequestDetails } from "./types";
import { senderOrigin, siteOfHttp } from "./urls";

type MessageSender = Browser.runtime.MessageSender;

/** How long after `updateSessionRules` resolved a request may still have been set up with the previous rules. */
const ASSIGNMENT_LAG_MS = 1_000;
const SETTLE_WAIT_MS = 60;
/** A re-navigation waits this long at most for its stale request to finish. */
const RENAVIGATE_WAIT_MS = 3_000;

interface SendRecord {
  tabId: number;
  sentAt: number;
  /** Cookie header actually sent (after DNR), null when none. */
  cookie: string | null;
}

const CHANGED: ReadonlySet<UpsertOutcome> = new Set([
  "added",
  "updated",
  "deleted",
]);
const toChange = (
  cookie: Cookie,
  outcome: UpsertOutcome,
  previous: Cookie | undefined,
): CookieChange => ({
  name: cookie.name,
  value: outcome === "deleted" ? null : cookie.value,
  previousValue: outcome === "deleted" ? previous?.value : undefined,
  domain: cookie.domain,
  hostOnly: cookie.hostOnly,
  secure: cookie.secure,
  partitioned: cookie.partitioned,
  sameSite: cookie.sameSite,
  path: cookie.path,
  partitionKey: cookie.partitionKey,
});
const cookieHeaderOf = (
  headers: WebRequestDetails["requestHeaders"],
): string | null =>
  headers?.find((h) => h.name.toLowerCase() === "cookie")?.value ?? null;

export interface CookieCaptureDeps extends EngineCore {
  rules: SessionRuleManager;
  detector: StaleNavigationDetector;
}

/**
 * Cookie capture of container tabs: Set-Cookie of their responses and `document.cookie` writes of their pages go into
 * the container jar, the rules follow, navigations that raced the rules are repeated, and the pages' script-visible
 * cookies are refreshed. Also the fetch barrier the shim waits on (`settle`).
 */
export class CookieCapture {
  /** Main/sub-frame requests: last hop's send time, for trusting Set-Cookie. */
  private readonly sends = new Map<string, SendRecord>();
  /** Responses already harvested (onHeadersReceived and onBeforeRedirect both see a 302). */
  private readonly harvested = new Map<string, number>();
  /** Per tab: URLs of responses seen in the last seconds (fetch barrier). */
  private readonly recentResponses = new Map<
    number,
    Array<{ url: string; at: number }>
  >();

  /** Per container: Set-Cookie / document.cookie work still being applied. */
  private readonly pendingWork = new Map<ContainerId, Set<Promise<void>>>();
  /** Re-navigations waiting for their stale request to finish, by requestId. */
  private readonly deferredRenavs = new Map<
    string,
    { renav: Renavigation; timer: ReturnType<typeof setTimeout> }
  >();

  /** Jar changes whose rules may not have reached requests yet: a stale hop's answer must not overwrite them. */
  private readonly recentChanges = new RecentCookieChanges({
    lagMs: ASSIGNMENT_LAG_MS,
  });

  constructor(private readonly d: CookieCaptureDeps) {}

  // ---------------------------------------------------------------- webRequest

  /** `webRequest.onSendHeaders` (frames). */
  noteSend(details: WebRequestDetails): void {
    if (details.tabId < 0) return;
    const cookie = cookieHeaderOf(details.requestHeaders);
    this.sends.set(details.requestId, {
      tabId: details.tabId,
      sentAt: details.timeStamp,
      cookie,
    });
    if (this.sends.size > 5_000) {
      // Requests that never reported completion: forget the old ones.
      const cutoff = details.timeStamp - 120_000;
      deleteWhere(this.sends, (rec) => rec.sentAt < cutoff);
    }
    if (details.type !== "main_frame") return;
    const send: MainFrameSend = {
      requestId: details.requestId,
      tabId: details.tabId,
      url: details.url,
      method: details.method,
      sentAt: details.timeStamp,
      cookie,
    };
    void this.d.ready().then(() => {
      for (const r of this.d.detector.noteSend(send)) this.renavigate(r);
    });
  }

  /** The request completed or failed: its send record goes. */
  forgetSend(requestId: string): void {
    this.sends.delete(requestId);
  }

  /** The request completed or failed: a re-navigation that waited for it goes now. */
  runDeferred(requestId: string): void {
    const deferred = this.deferredRenavs.get(requestId);
    if (!deferred) return;
    this.deferredRenavs.delete(requestId);
    clearTimeout(deferred.timer);
    void this.navigateAgain(deferred.renav);
  }

  /** onHeadersReceived and onBeforeRedirect: harvest Set-Cookie of container tabs into their jar. */
  noteResponse(details: WebRequestDetails): void {
    if (details.tabId < 0) return;
    const key = `${details.requestId}|${details.url}|${details.statusCode ?? ""}`;
    const now = Date.now();
    if (this.harvested.has(key)) return;
    this.harvested.set(key, now);
    if (this.harvested.size > 2000)
      deleteWhere(this.harvested, (at) => now - at > 60_000);
    const headers = setCookieHeaders(details.responseHeaders);
    // Capture the trust decision inputs now: the send record is gone once the request completes.
    const send = this.sends.get(details.requestId);
    void this.d.ready().then(() => this.harvest(details, headers, send));
  }

  forgetTab(tabId: number): void {
    this.recentResponses.delete(tabId);
  }

  /** True when every cookie in a sent header exists in the container jar: the request went out under its rules. */
  headerFromJar(containerId: ContainerId, header: string | null): boolean {
    const pairs = parseCookieHeader(header);
    if (pairs.length === 0) return true;
    const jar = this.d.containers.jar(containerId).all();
    return pairs.every(([name, value]) =>
      jar.some((c) => c.name === name && c.value === value),
    );
  }

  private harvest(
    details: WebRequestDetails,
    headers: string[],
    send: SendRecord | undefined,
  ): void {
    const rec = this.d.tabs.get(details.tabId);
    if (!rec) return;
    this.recordResponse(details.tabId, details.url);
    if (headers.length === 0) return;
    const containerId = rec.containerId;
    // A request that went out before the tab's rules applied carried the real profile's cookies: never import its
    // answer. Shortly after the assignment Chrome may still apply the old (no) rules, so frames whose sent Cookie
    // header is known must also carry nothing but container cookies. (Later on, a header with an already rotated
    // value is normal and must not cost the response its Set-Cookie.)
    const sentAt = send?.sentAt ?? details.timeStamp;
    const foreign =
      rec.activeSince === null ||
      sentAt < rec.activeSince ||
      (send !== undefined &&
        sentAt < rec.activeSince + ASSIGNMENT_LAG_MS &&
        !this.headerFromJar(containerId, send.cookie));
    if (foreign) {
      this.d.log(
        "warn",
        `ignored ${headers.length} Set-Cookie of a request sent outside the container's rules`,
        details.url,
      );
      return;
    }
    const jar = this.d.containers.jar(containerId);
    const topLevelSite =
      details.type === "main_frame"
        ? siteOfHttp(details.url)
        : rec.topLevelSite;
    const now = Date.now();
    // A top-level GET that raced the rules of a cookie it should have carried (the hop after a login redirect): its
    // answer must not overwrite that cookie (Drupal answers it with a fresh anonymous session). See stale-response.ts.
    const missed =
      details.type === "main_frame" && send !== undefined
        ? this.recentChanges.missedBy(containerId, {
            url: details.url,
            method: details.method,
            sentAt,
            cookie: send.cookie,
          })
        : [];
    const changes: CookieChange[] = [];
    let skipped = 0;
    for (const header of headers) {
      const parsed = parseSetCookie(header, {
        url: details.url,
        now,
        topLevelSite,
      });
      if (!parsed.ok) continue;
      if (missed.some((change) => sameCookie(change, parsed.cookie))) {
        skipped++;
        continue;
      }
      const previous = jar.get(parsed.cookie);
      const outcome = jar.upsert(parsed.cookie, { now });
      if (CHANGED.has(outcome))
        changes.push(toChange(parsed.cookie, outcome, previous));
    }
    if (skipped > 0)
      this.d.log(
        "info",
        `ignored ${skipped} Set-Cookie of a request that went out before the rules carried them`,
        details.url,
      );
    if (changes.length === 0) return;
    this.d.containers.touchJar(containerId);
    this.track(
      containerId,
      this.afterJarChange(containerId, details.timeStamp, changes),
    );
  }

  private recordResponse(tabId: number, url: string): void {
    const now = Date.now();
    const list = (this.recentResponses.get(tabId) ?? []).filter(
      (r) => now - r.at < 3_000,
    );
    list.push({ url, at: now });
    this.recentResponses.set(tabId, list.slice(-50));
  }

  // ---------------------------------------------------------------- after a jar change

  /** Install the new rules, then repair navigations that raced them and refresh the pages' document.cookie view. */
  private async afterJarChange(
    containerId: ContainerId,
    from: number,
    changes: CookieChange[],
  ): Promise<void> {
    const recent = this.recentChanges.open(containerId, from, changes);
    try {
      await this.d.rules.invalidate(containerId);
    } finally {
      recent.settle(Date.now());
    }
    const until = Date.now();
    for (const r of this.d.detector.noteChange({
      containerId,
      from,
      until,
      changes,
    }))
      this.renavigate(r);
    this.pushCookies(
      containerId,
      new Set(changes.map((c) => beaconSiteOf(c.domain))),
    );
  }

  private track(containerId: ContainerId, work: Promise<void>): void {
    let set = this.pendingWork.get(containerId);
    if (!set) this.pendingWork.set(containerId, (set = new Set()));
    const guarded = work.catch((error) =>
      this.d.log("error", "jar update failed", String(error)),
    );
    set.add(guarded);
    void guarded.finally(() => set!.delete(guarded));
  }

  /** Repeats a navigation that went out with outdated cookies, once its stale request has finished. */
  renavigate(r: Renavigation): void {
    if (!this.d.tabs.get(r.tabId) || this.deferredRenavs.has(r.requestId))
      return;
    this.d.log("info", `re-navigating tab ${r.tabId} (${r.reason})`, r.url);
    if (!this.sends.has(r.requestId)) {
      void this.navigateAgain(r);
      return;
    }
    const timer = setTimeout(() => {
      this.deferredRenavs.delete(r.requestId);
      void this.navigateAgain(r);
    }, RENAVIGATE_WAIT_MS);
    this.deferredRenavs.set(r.requestId, { renav: r, timer });
  }

  private async navigateAgain(r: Renavigation): Promise<void> {
    // The user (or the page) navigated somewhere else meanwhile: leave the tab alone.
    const latest = this.d.detector.latestSend(r.tabId);
    if (latest && latest.requestId !== r.requestId) return;
    if (!this.d.tabs.get(r.tabId)) return;
    await this.d.prepareNavigation(r.url);
    await this.d.b.tabs.update(r.tabId, { url: r.url }).catch(() => {});
  }

  /** Sends the script-visible cookies of `sites` to every frame of every tab of the container. */
  private pushCookies(containerId: ContainerId, sites: Set<string>): void {
    const jar = this.d.containers.jar(containerId);
    const now = Date.now();
    for (const tabId of this.d.tabs.tabsOf(containerId)) {
      const visible = scriptVisibleCookies(
        jar,
        this.d.tabs.get(tabId)?.topLevelSite ?? null,
        now,
      );
      const payload: Record<string, Cookie[]> = {};
      for (const site of sites)
        payload[site] = visible.filter((c) => beaconSiteOf(c.domain) === site);
      void this.d.b.tabs
        .sendMessage(tabId, { type: "facet/cookies", sites: payload })
        .catch(() => {});
    }
  }

  // ---------------------------------------------------------------- page messages

  /** The script-visible cookies of `host`'s site in the container. */
  siteSnapshot(
    containerId: ContainerId,
    host: string,
    topLevelSite: string | null,
  ): Cookie[] {
    const site = beaconSiteOf(host);
    return scriptVisibleCookies(
      this.d.containers.jar(containerId),
      topLevelSite,
      Date.now(),
    ).filter((c) => beaconSiteOf(c.domain) === site);
  }

  /** A page's `document.cookie` / `cookieStore` write; answers once the rules carry it. */
  async cookieWrite(
    tabId: number,
    sender: MessageSender,
    value: string,
    path: string,
    at: number,
  ): Promise<CookieSnapshotReply> {
    const rec = this.d.tabs.get(tabId);
    const origin = senderOrigin(sender);
    if (!rec || rec.activeSince === null || !origin) return { ok: false };
    const host = hostnameOf(new URL(origin).hostname);
    const jar = this.d.containers.jar(rec.containerId);
    const now = Date.now();
    const before = jar.all(); // a deletion's previous value (the write parses the identity itself)
    const { parsed, outcome } = jar.applyDocumentCookieWrite(host, value, {
      secure: isSecureUrl(`${origin}/`),
      path: path.startsWith("/") ? path : "/",
      topLevelSite: rec.topLevelSite,
      now,
    });
    if (parsed.ok && CHANGED.has(outcome)) {
      this.d.containers.touchJar(rec.containerId);
      const from = Number.isFinite(at)
        ? Math.min(now, Math.max(now - 5_000, at))
        : now;
      const work = this.afterJarChange(rec.containerId, from, [
        toChange(
          parsed.cookie,
          outcome,
          before.find((c) => cookieKey(c) === cookieKey(parsed.cookie)),
        ),
      ]);
      this.track(rec.containerId, work);
      await work; // the reply doubles as the shim's fetch barrier: rules carry the cookie from here on
    }
    return {
      ok: true,
      cookies: this.siteSnapshot(rec.containerId, host, rec.topLevelSite),
    };
  }

  /** Fetch barrier: wait until the response's Set-Cookie (if any) reached the container's rules. */
  async settle(tabId: number, url: string, method: string): Promise<void> {
    const rec = this.d.tabs.get(tabId);
    if (!rec) return;
    if (method.toUpperCase() !== "GET") {
      const deadline = Date.now() + SETTLE_WAIT_MS;
      while (
        !this.recentResponses.get(tabId)?.some((r) => r.url === url) &&
        Date.now() < deadline
      )
        await sleep(5);
    }
    await sleep(0); // let queued webRequest events run first
    await Promise.all([...(this.pendingWork.get(rec.containerId) ?? [])]);
    await this.d.rules.sync();
  }
}
