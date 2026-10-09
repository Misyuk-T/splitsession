/**
 * Protocol between the ISOLATED beacon script and the MAIN-world shim of the same frame.
 *
 * At document_start, before any page script, the beacon appends a `<facet-bridge>` element to `<html>`; the shim
 * (injected right after it) takes the element out of the DOM and keeps it. From then on both worlds hold the only
 * references to that detached node: requests travel as `facet:req` CustomEvents (string `detail`, answered
 * synchronously in the `data-res` attribute), pushes from the beacon as `facet:push` events. Page scripts cannot
 * reach the node, so they cannot read the cross-host cookie snapshot held by the beacon or forge pushes.
 */
export const BRIDGE_TAG = 'facet-bridge';
export const REQ_EVENT = 'facet:req';
export const PUSH_EVENT = 'facet:push';
export const RES_ATTR = 'data-res';
export const MODE_ATTR = 'data-mode';
export const CONTAINER_ATTR = 'data-c';
/** Set by the beacon when the shim of this realm is already installed (window reused by a same-origin navigation). */
export const SKIP_ATTR = 'data-skip';
/**
 * Asks a shim to patch same-origin windows whose own shim may not run (scripts disabled), dispatched on a document by
 * the beacon of such a frame (src/content/seal.isolated.ts). `detail` is either `<index>|<mode>|<key>` (from a frame
 * to its same-origin parent: patch your child `index` if your mode and key are these) or `ADOPT_SWEEP` (patch every
 * unpatched same-origin window of your frame tree). A page that fires it can only cause what the shim does anyway.
 */
export const ADOPT_EVENT = 'facet:adopt';
export const ADOPT_SWEEP = 'sweep';

/** container: namespaced state; managed: plain tab on a container site; guard: strict mode, any other frame. */
export type ShimMode = 'container' | 'managed' | 'guard';

/** Cookie as exposed to `cookieStore` (CookieListItem). */
export interface CookieItem {
  name: string;
  value: string;
  domain: string | null;
  path: string;
  expires: number | null;
  secure: boolean;
  sameSite: 'strict' | 'lax' | 'none';
  partitioned: boolean;
}

export type BridgeRequest =
  | { op: 'cookie-get' }
  | { op: 'cookie-set'; v: string; id: number }
  | { op: 'cookie-list' }
  | { op: 'open-tab'; url: string; active: boolean }
  | { op: 'await-child'; nonce: string; url?: string }
  | { op: 'settle'; id: number; url: string; method: string };

export type BridgePush =
  | { t: 'cookie-ack'; id: number }
  | { t: 'child'; nonce: string; ok: boolean }
  | { t: 'settled'; id: number };
