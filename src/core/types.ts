/** Shared type and message definitions. Pure data: no chrome.* references. */

export type ContainerId = string;

export const CONTAINER_COLORS = [
  'blue',
  'turquoise',
  'green',
  'yellow',
  'orange',
  'red',
  'pink',
  'purple',
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

export type SameSite = 'strict' | 'lax' | 'none' | 'unspecified';

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
 * Body the beacon rule answers with (served as a `data:` URL by declarativeNetRequest).
 * Everything the MAIN-world shim needs before the first script of the page runs.
 */
export interface BeaconPayload {
  /** Container of the tab asking. */
  c: ContainerId;
  /** Non-HttpOnly, unexpired cookies visible to this tab: the initial `document.cookie` state. */
  k?: Cookie[];
  /** Top-level site of the tab at compile time, needed to evaluate partitioned cookies in `k`. */
  s?: string | null;
  /** Set to 1 when `k` was dropped because it exceeded the size cap; the shim must fetch cookies asynchronously. */
  o?: 1;
}

/** Content script -> background: a `document.cookie = value` write made by the page. */
export interface CookieWriteMessage {
  type: 'facet/cookie-write';
  /** Document URL the write came from (host, default path and scheme are derived from it). */
  url: string;
  /** Raw string assigned to `document.cookie`. */
  value: string;
}

/** Any extension page / content script -> background: open a URL in a container. */
export interface OpenInContainerMessage {
  type: 'facet/open-in-container';
  containerId: ContainerId;
  url: string;
}

/** Content script -> background: which container does the sending tab belong to? */
export interface GetTabAssignmentMessage {
  type: 'facet/get-tab-assignment';
}

export type FacetMessage = CookieWriteMessage | OpenInContainerMessage | GetTabAssignmentMessage;
