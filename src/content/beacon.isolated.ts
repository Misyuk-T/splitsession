import { browser } from "wxt/browser";

import { BEACON_URL } from "../core/dnr/rule-compiler";
import { CookieJar, serializeCookieHeader } from "../core/jar/cookie-jar";
import { domainMatches, hostnameOf, isSecureUrl, siteOf } from "../core/site";
import type {
  BeaconAnswer,
  BeaconPayload,
  Cookie,
  CookiesChangedMessage,
  CookieSnapshotReply,
} from "../core/types";
import {
  BRIDGE_TAG,
  type BridgePush,
  type BridgeRequest,
  CONTAINER_ATTR,
  type CookieItem,
  MODE_ATTR,
  PUSH_EVENT,
  REQ_EVENT,
  RES_ATTR,
  SKIP_ATTR,
} from "./bridge-protocol";
import { sealFrame } from "./seal.isolated";
import { startPageName } from "./title-prefix";

const KEEPALIVE_MS = 25_000;
/** How long a frame whose site has no beacon answer yet waits (blocking, at document_start) for the background. */
const SITE_WAIT_MS = 1_000;
/** Survives in the isolated world when a same-origin navigation reuses the window (initial about:blank). */
const STATE_KEY = "__facetBeaconState";

/**
 * ISOLATED world, document_start, every frame. Learns the frame's container synchronously from the beacon (a sync
 * XHR that declarativeNetRequest answers with a `data:` URL, never touching the network), keeps the frame's
 * `document.cookie` view and relays the MAIN-world shim's requests to the background.
 */
export function runBeacon(): void {
  const root = document.documentElement;
  if (!root) return;
  let answer = askBeacon();
  if (!answer) return;
  if ("p" in answer && answer.p === 1) answer = waitForSiteAnswer(answer);
  const state = globalThis as unknown as Record<string, unknown>;
  const reused = state[STATE_KEY] === true;
  state[STATE_KEY] = true;

  const bridge = document.createElement(BRIDGE_TAG);
  if (reused) bridge.setAttribute(SKIP_ATTR, "1");
  if (
    ("c" in answer && typeof answer.c === "string") ||
    ("p" in answer && answer.p === 1)
  ) {
    // No per-site answer even after asking (opaque origin, background unreachable): a throwaway key, so the frame is
    // still isolated; whatever it stores is not seen again.
    const key =
      "c" in answer && typeof answer.c === "string" ? answer.c : throwawayKey();
    bridge.setAttribute(MODE_ATTR, "container");
    bridge.setAttribute(CONTAINER_ATTR, key);
    startContainer({ ...(answer as Partial<BeaconPayload>), c: key }, bridge);
    // The name reaches pages only when the user allows it (the background leaves `n` out otherwise). Full edition only.
    if (__FULL__ && window === window.top && typeof answer.n === "string")
      startPageName(root, answer.n);
  } else if ("m" in answer && answer.m === 1) {
    bridge.setAttribute(MODE_ATTR, "managed");
  } else if ("g" in answer && answer.g === 1) {
    bridge.setAttribute(MODE_ATTR, "guard");
  } else {
    return;
  }
  root.appendChild(bridge);
  // The shim runs after the ISOLATED scripts and detaches the node. A document whose scripts are disabled gets no
  // shim: the seal has a same-origin realm patch this one (and never leaves the node to the page).
  sealFrame(
    bridge,
    bridge.getAttribute(MODE_ATTR) ?? "",
    bridge.getAttribute(CONTAINER_ATTR) ?? "",
  );
}

function askBeacon(): BeaconAnswer | null {
  try {
    const xhr = new XMLHttpRequest();
    xhr.open(
      "GET",
      `${BEACON_URL}?${Math.random().toString(36).slice(2)}`,
      false,
    );
    xhr.send();
    if (!xhr.responseURL.startsWith("data:")) return null; // never trust a real server on ctr.localhost
    const parsed: unknown = JSON.parse(xhr.responseText);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as BeaconAnswer)
      : null;
  } catch {
    return null; // no rule at all (extension starting up): plain tab
  }
}

/**
 * The generic answer `{p: 1}`: this frame is in a container tab, but its site has no beacon rule yet (a frame the
 * background has not seen being requested). Ask the background to add the site and poll the beacon until the
 * per-site answer appears. The message is sent at once; the loop blocks only this frame's document_start.
 */
function waitForSiteAnswer(first: BeaconAnswer): BeaconAnswer {
  if (!frameOrigin()) return first;
  try {
    void (
      browser.runtime.sendMessage({
        type: "facet/need-site",
      }) as Promise<unknown>
    ).catch(() => undefined);
  } catch {
    return first;
  }
  const deadline = Date.now() + SITE_WAIT_MS;
  while (Date.now() < deadline) {
    const next = askBeacon();
    if (!next) break;
    if (!("p" in next)) return next;
  }
  return first;
}

function throwawayKey(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => alphabet[b & 31]).join("");
}

/** Frame origin; about:blank / srcdoc frames report their inherited origin through `self.origin`. */
function frameOrigin(): string | null {
  const origin = self.origin;
  return origin && origin !== "null" && /^https?:\/\//.test(origin)
    ? origin
    : null;
}

function topLevelSite(): string | null {
  try {
    const ancestors = location.ancestorOrigins;
    const top =
      ancestors && ancestors.length > 0
        ? ancestors[ancestors.length - 1]
        : self.origin;
    return top && top !== "null" && /^https?:\/\//.test(top)
      ? siteOf(top)
      : null;
  } catch {
    return null;
  }
}

function startContainer(answer: BeaconPayload, bridge: HTMLElement): void {
  const origin = frameOrigin();
  const host = origin ? hostnameOf(new URL(origin).hostname) : null;
  const secure = origin ? isSecureUrl(`${origin}/`) : false;
  // The beacon's group site is exact (full PSL in the background); our own estimate is the fallback.
  const tls = answer.s ?? topLevelSite();
  const docPath = () =>
    location.protocol === "http:" || location.protocol === "https:"
      ? location.pathname
      : "/";
  // A frame of another site than the top document sees only SameSite=None cookies, like the requests it makes
  // (the rules split cookies by SameSite) and like Chrome's third-party document.cookie.
  const crossSite = origin !== null && tls !== null && siteOf(origin) !== tls;
  const visible = (c: Cookie) =>
    !c.httpOnly && (!crossSite || c.sameSite === "none");

  let base: Cookie[] = answer.k ?? [];
  let jar = new CookieJar(base);
  /** Writes made locally and not yet confirmed by the background: re-applied on top of every refresh. */
  const unconfirmed = new Map<number, string>();
  const rebuild = () => {
    jar = new CookieJar(base);
    if (host)
      for (const v of unconfirmed.values())
        jar.applyDocumentCookieWrite(host, v, {
          secure,
          path: docPath(),
          topLevelSite: tls,
        });
  };
  const replaceSnapshot = (cookies: Cookie[] | undefined) => {
    if (!cookies) return;
    base = cookies;
    rebuild();
  };

  const push = (message: BridgePush) =>
    bridge.dispatchEvent(
      new CustomEvent(PUSH_EVENT, { detail: JSON.stringify(message) }),
    );
  const send = <T>(message: object): Promise<T | undefined> =>
    (browser.runtime.sendMessage(message) as Promise<T>).catch(() => undefined);

  if (answer.o === 1 || answer.k === undefined) {
    if (host)
      void send<CookieSnapshotReply>({ type: "facet/cookie-snapshot" }).then(
        (r) => replaceSnapshot(r?.cookies),
      );
  }

  browser.runtime.onMessage.addListener((message: unknown) => {
    const m = message as CookiesChangedMessage;
    if (m?.type !== "facet/cookies" || !host || !m.sites) return undefined;
    // Keys are registrable domains: ours is the one our host belongs to (no PSL needed for that).
    const mine = Object.keys(m.sites)
      .filter((site) => domainMatches(host, site))
      .sort((a, b) => b.length - a.length)[0];
    if (mine !== undefined) replaceSnapshot(m.sites[mine]);
    return undefined;
  });

  const handle = (req: BridgeRequest): unknown => {
    switch (req.op) {
      case "cookie-get":
        return {
          v: host
            ? serializeCookieHeader(
                jar
                  .cookiesForHost(host, { secure, topLevelSite: tls })
                  .filter(visible),
              )
            : "",
        };
      case "cookie-list": {
        if (!host) return { list: [] };
        const list: CookieItem[] = jar
          .cookiesForHost(host, { secure, topLevelSite: tls })
          .filter(visible)
          .map((c) => ({
            name: c.name,
            value: c.value,
            domain: c.hostOnly ? null : c.domain,
            path: c.path,
            expires: c.expires,
            secure: c.secure,
            sameSite: c.sameSite === "unspecified" ? "lax" : c.sameSite,
            partitioned: c.partitioned,
          }));
        return { list };
      }
      case "cookie-set": {
        if (!host) {
          push({ t: "cookie-ack", id: req.id });
          return {};
        }
        const { parsed } = jar.applyDocumentCookieWrite(host, req.v, {
          secure,
          path: docPath(),
          topLevelSite: tls,
        });
        if (!parsed.ok) {
          push({ t: "cookie-ack", id: req.id });
          return {};
        }
        unconfirmed.set(req.id, req.v);
        void send<CookieSnapshotReply>({
          type: "facet/cookie-write",
          value: req.v,
          path: docPath(),
          at: Date.now(),
        }).then((reply) => {
          unconfirmed.delete(req.id);
          if (reply?.ok) replaceSnapshot(reply.cookies);
          else rebuild();
          push({ t: "cookie-ack", id: req.id });
        });
        return {};
      }
      case "open-tab":
        void send({ type: "facet/open-tab", url: req.url, active: req.active });
        return {};
      case "await-child":
        void send<{ ok: boolean }>({
          type: "facet/await-child",
          nonce: req.nonce,
          url: req.url,
        }).then((r) =>
          push({ t: "child", nonce: req.nonce, ok: r?.ok === true }),
        );
        return {};
      case "settle":
        void send({
          type: "facet/settle",
          url: req.url,
          method: req.method,
        }).then(() => push({ t: "settled", id: req.id }));
        return {};
      default:
        return null;
    }
  };

  bridge.addEventListener(REQ_EVENT, (event) => {
    let result: unknown = null;
    try {
      result = handle(
        JSON.parse(String((event as CustomEvent).detail)) as BridgeRequest,
      );
    } catch {
      result = null;
    }
    bridge.setAttribute(RES_ATTR, JSON.stringify(result));
  });

  if (window === window.top) {
    setInterval(() => void send({ type: "facet/ping" }), KEEPALIVE_MS);
  }
}
