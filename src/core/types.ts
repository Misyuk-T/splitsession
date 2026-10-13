/** Shared type and message definitions. Pure data: no chrome.* references. */

export type ContainerId = string;

export const CONTAINER_COLORS = [
  "blue",
  "turquoise",
  "green",
  "yellow",
  "orange",
  "red",
  "pink",
  "purple",
] as const;
export type ContainerColor = (typeof CONTAINER_COLORS)[number];

export interface Container {
  id: ContainerId;
  name: string;
  color: ContainerColor;
  /** Epoch milliseconds. */
  createdAt: number;
}

/** A tab's identity. Source of truth is `tabId -> containerId`; tab groups are only a projection. */
export interface TabAssignment {
  tabId: number;
  containerId: ContainerId;
}

export type SameSite = "strict" | "lax" | "none" | "unspecified";

/** A cookie as held in a container jar. Plain JSON-serialisable data. */
export interface Cookie {
  name: string;
  value: string;
  /** Lowercase, no leading dot. For host-only cookies this is the exact request host. */
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  /** `unspecified` means no recognised SameSite attribute (Lax-by-default semantics apply). */
  sameSite: SameSite;
  /** CHIPS: stored per top-level site. */
  partitioned: boolean;
  /** Top-level site (see `siteOf`) for partitioned cookies, otherwise null. */
  partitionKey: string | null;
  /** Epoch milliseconds, or null for a session cookie. */
  expires: number | null;
  /** Epoch milliseconds. */
  creationTime: number;
}

/**
 * Body the beacon rules answer with (served as a `data:` URL by declarativeNetRequest).
 * Everything the MAIN-world shim needs before the first script of the page runs.
 *
 * A page can fetch the beacon URL itself, so the answer is per registrable domain of the requesting frame
 * (`initiatorDomains`) and never holds the container ID: `c` is an opaque key that differs per site.
 */
export interface BeaconPayload {
  /** Page key of the container on the requesting frame's site (`page-key.ts`): namespaces page storage. */
  c: string;
  /** Container display name (page marker `data-ctr`, title prefix); only when the user lets pages see it. */
  n?: string;
  /** Non-HttpOnly, unexpired cookies of the requesting frame's site: the initial `document.cookie` state. */
  k?: Cookie[];
  /** Top-level site of the group at compile time, needed to evaluate partitioned cookies in `k`. */
  s?: string | null;
  /** Set to 1 when `k` was dropped because it exceeded the size cap; the shim must fetch cookies asynchronously. */
  o?: 1;
}

/** A container tab, but no answer for this frame's site yet: ask the background (`facet/need-site`) and poll. */
export interface PendingBeaconAnswer {
  p: 1;
  n?: string;
}

/** Answer in a tab WITHOUT a container on an origin SplitSession has seen inside containers ("managed"). */
export interface ManagedBeaconAnswer {
  m: 1;
}

/** Strict mode (consented): any other frame. The shim refuses service-worker registration and does nothing else. */
export interface GuardBeaconAnswer {
  g: 1;
}

/** Anything the beacon XHR can yield. `{}` = plain tab (static default rule). */
export type BeaconAnswer =
  | BeaconPayload
  | PendingBeaconAnswer
  | ManagedBeaconAnswer
  | GuardBeaconAnswer
  | Record<string, never>;

/** Storage-key / database-name / cache-name / channel-name prefix of container-namespaced page state. */
export const NAMESPACE_PREFIX = "__facet:";
/** Prefix of one container's state on one site: `__facet:<page key>:` (never the container ID, see `page-key.ts`). */
export const namespacePrefix = (pageKey: string): string =>
  `${NAMESPACE_PREFIX}${pageKey}:`;

// ---- Content script (ISOLATED) -> background. The background derives tab, frame origin and container from
// `sender`, never from the message, so a page driving the bridge can only act within its own container. ----

/** A `document.cookie = value` (or cookieStore) write made by the page. Reply: `CookieSnapshotReply`. */
export interface CookieWriteMessage {
  type: "facet/cookie-write";
  /** Raw string assigned to `document.cookie`. */
  value: string;
  /** Document path (for the default cookie path). */
  path: string;
  /** Epoch ms when the page made the write (start of the stale-navigation window). */
  at: number;
}

/** Ask for the current script-visible cookies of the sender frame's site. Reply: `CookieSnapshotReply`. */
export interface CookieSnapshotMessage {
  type: "facet/cookie-snapshot";
}

export interface CookieSnapshotReply {
  ok: boolean;
  /** Script-visible cookies of the sender frame's site (replace the local view of that site with these). */
  cookies?: Cookie[];
}

/** Fetch barrier: resolve once Set-Cookie of a just-finished response has reached the container's rules. */
export interface SettleMessage {
  type: "facet/settle";
  url: string;
  method: string;
}

/** The shim opened `about:blank#facet-<nonce>`; reply when the child tab is in the container with rules applied. */
export interface AwaitChildMessage {
  type: "facet/await-child";
  nonce: string;
  /** Where the child will go: its origin's service workers are removed before the reply. */
  url?: string;
}

/** The beacon got `{p: 1}`: add the sender frame's site to the container's beacon rules (the beacon then polls). */
export interface NeedSiteMessage {
  type: "facet/need-site";
}

/** Open a URL in a new tab of the sender's container (noopener / target=_blank / modified clicks). */
export interface OpenTabMessage {
  type: "facet/open-tab";
  url: string;
  active: boolean;
}

/** Keeps the service worker warm while container tabs are open. */
export interface PingMessage {
  type: "facet/ping";
}

export type ContentMessage =
  | CookieWriteMessage
  | CookieSnapshotMessage
  | SettleMessage
  | AwaitChildMessage
  | NeedSiteMessage
  | OpenTabMessage
  | PingMessage;

/** Background -> content scripts of a container tab: fresh script-visible cookies, per site. */
export interface CookiesChangedMessage {
  type: "facet/cookies";
  sites: Record<string, Cookie[]>;
}

/** Extension page -> background: programmatic API call (see `src/background/api.ts`). */
export interface ApiCallMessage {
  type: "facet/api";
  method: string;
  args: unknown[];
}

export type ApiReply =
  { ok: true; value: unknown } | { ok: false; error: string };
