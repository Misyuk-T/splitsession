import { createFrameGuard } from "./shim/frame-guard";
import { installInto } from "./shim/install";
import { createShared } from "./shim/shared";
import {
  BRIDGE_TAG,
  CONTAINER_ATTR,
  MODE_ATTR,
  SKIP_ATTR,
} from "./bridge-protocol";

/**
 * MAIN world, document_start, every frame, right after the beacon. Runs before any page script.
 *
 * - container mode: page-visible state is namespaced per container: `document.cookie` / `cookieStore` come from the
 *   container jar (via the beacon), Web Storage keys, IndexedDB / Cache Storage / BroadcastChannel names get the
 *   `__facet:<id>:` prefix, SharedWorker is unavailable (its fetches would carry the real profile's cookies), service
 *   worker registration is rejected, and `window.open` / new-tab link clicks are routed so the child tab is in the
 *   container before its first request. fetch/XHR wait for cookie writes and Set-Cookie to reach the rules.
 * - managed mode (tab without a container on a site containers use): container-namespaced state is hidden and service
 *   worker registration is rejected; nothing else changes.
 * - guard mode (strict mode, after the user agreed; any other frame of any tab): service worker registration is
 *   rejected, nothing else is patched.
 * - no bridge: plain tab, nothing is patched.
 *
 * In every mode, every same-origin window the page can reach (frames, popups) is patched with the same patches before
 * the page can use it, including windows whose own scripts are disabled (`FrameGuard`, shim/types.ts): an unpatched
 * realm would hand the page the real profile's cookies, storage and service-worker registration.
 *
 * Patches replace properties on prototypes (never `delete`), keep names/arity, and report native source text. The
 * natives they use are captured when the bundle is evaluated (shim/natives.ts); the patches of each mode and their
 * order are listed in shim/install.ts, one module per API in shim/patches/.
 */
export function runShim(): void {
  const root = document.documentElement;
  if (!root) return;
  const bridge = root.querySelector(`:scope > ${BRIDGE_TAG}`);
  if (!bridge) return;
  bridge.remove();
  if (bridge.hasAttribute(SKIP_ATTR)) return;
  const mode = bridge.getAttribute(MODE_ATTR);
  if (mode !== "container" && mode !== "managed" && mode !== "guard") return;
  const containerId = bridge.getAttribute(CONTAINER_ATTR) ?? "";
  if (mode === "container" && !/^[a-z0-9]{1,32}$/.test(containerId)) return;
  const shared = createShared(bridge, mode, containerId, (s) =>
    createFrameGuard(s, (win) => installInto(win, s)),
  );
  // Already patched: the same-origin parent adopted this realm when the beacon asked (src/content/seal.isolated.ts),
  // or the window was reused. Its patches stay; this bridge is not needed.
  if (!installInto(window as never, shared)) return;
  // Same-origin windows that exist already and have no shim of their own (scripts disabled), e.g. a sandboxed
  // sibling frame: patch them before this frame's scripts can reach them.
  shared.frames.sweepTree(window);
}
