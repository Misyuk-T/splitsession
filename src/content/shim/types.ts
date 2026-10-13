/* eslint-disable @typescript-eslint/no-explicit-any -- windows of other realms are duck-typed */
import type { BridgePush, BridgeRequest, ShimMode } from "../bridge-protocol";
import type { Namespace } from "../namespace";

/** What every realm patched from one shim run shares: its bridge to the beacon, its namespace, its bookkeeping. */
export interface Shared {
  mode: ShimMode;
  /** The page key of container mode (the bridge's `data-c`), empty otherwise. */
  key: string;
  ns: Namespace;
  masks: WeakMap<object, string>;
  request(req: BridgeRequest): any;
  onPush(listener: (push: BridgePush) => void): void;
  /** Resolves when no document.cookie write is waiting for the background (bounded). */
  writesSettled(): Promise<void> | null;
  trackWrite(id: number): void;
  nextId(): number;
  /** Fetch barrier for a finished response. */
  settle(url: string, method: string): Promise<void>;
  storageViews: WeakMap<object, { real: Storage; ns: Namespace }>;
  realToView: WeakMap<object, object>;
  redispatched: WeakSet<Event>;
  frames: FrameGuard;
}

/**
 * Keeps every same-origin window reachable from realms patched with one `Shared` patched as well. A realm whose own
 * scripts are disabled never runs the shim, yet a same-origin page can use its `document.cookie`, `localStorage` or
 * `ServiceWorkerContainer.prototype.register` (on its own objects or on ours). Such a realm is patched from here, which
 * works whatever its sandbox flags. Ways a new realm becomes reachable, and what catches each:
 *  - DOM insertion of a frame by script: the insertion methods sweep right after inserting (synchronously);
 *  - parser-inserted frames: a MutationObserver sweeps at the microtask checkpoint, before the next script runs;
 *  - `frames`, `self`, `length` getters sweep; `contentWindow`, `contentDocument`, `getSVGDocument()`, `defaultView`,
 *    `opener`, `MessageEvent.source`, `UIEvent.view` and `window.open` adopt what they return;
 *  - a frame navigating to a new document: its beacon (ISOLATED, before any script) asks its same-origin parent to
 *    patch the new realm at once, and if the frame's own shim then does not run (scripts disabled), asks every
 *    same-origin window to sweep the whole frame tree (src/content/seal.isolated.ts).
 * The adopted realm gets this `Shared` (its bridge and namespace): it is same-origin, i.e. the same site in the same
 * tab or in a popup that inherited the tab's container, so the view is exactly the adopter's own.
 */
export interface FrameGuard {
  /** Patches `win` if it is a same-origin window that nobody has patched; true when it is same-origin. */
  adopt(win: any): boolean;
  /**
   * `adopt` for a window proxy no sweep has looked at yet. Cheap for the hot getters (`contentWindow` of a
   * cross-origin frame costs one caught exception once): a seen window that later navigates to a document of its own
   * origin has its own shim, or its seal asks for a full sweep.
   */
  reach(win: any): void;
  /** Adopts the new child windows of every realm patched with this Shared. Cheap: run after every DOM insertion. */
  sweep(): void;
  /** Adopts every unpatched same-origin window in `from`'s frame tree and in popups this Shared opened. */
  sweepTree(from: any): void;
  /** A realm was patched with this Shared. */
  addRealm(win: any): void;
  /** A popup was opened by a realm of this Shared. */
  addOpened(win: any): void;
}
