/* eslint-disable @typescript-eslint/no-explicit-any -- windows of other realms are duck-typed */
import type { ShimMode } from "../bridge-protocol";
import { patchBroadcastChannel } from "./patches/broadcast-channel";
import { patchCaches } from "./patches/cache-storage";
import { patchChildWindows } from "./patches/child-windows";
import { patchCookies } from "./patches/cookies";
import { patchIndexedDb } from "./patches/indexed-db";
import { patchNetworkBarrier } from "./patches/network-barrier";
import { patchOpeners } from "./patches/openers";
import { patchStorage } from "./patches/storage";
import { patchToString } from "./patches/to-string";
import {
  hideSharedWorker,
  patchServiceWorker,
  recoverFromServiceWorker,
} from "./patches/workers";
import { defineProperty, getOwnPropertyDescriptor, MARK } from "./natives";
import { makeHelpers, type Patch } from "./patch-helpers";
import type { Shared } from "./types";

/** Page-visible state hidden in every mode but guard: the namespaced stores, service workers, child windows. */
const NAMESPACED: Patch[] = [
  patchStorage,
  patchIndexedDb,
  patchCaches,
  patchServiceWorker,
  patchChildWindows,
];

/**
 * The patches of each mode, in the order they are applied (after `Function.prototype.toString`):
 * - guard: service-worker registration is rejected; child windows get the same patch;
 * - managed: container-namespaced state is hidden, service workers are rejected;
 * - container: all of managed, plus the container's cookies, channels, no SharedWorker, new tabs routed into the
 *   container, the network barrier, and a page served by a service worker is reloaded without it.
 */
const PATCHES: Record<ShimMode, readonly Patch[]> = {
  guard: [patchServiceWorker, patchChildWindows],
  managed: NAMESPACED,
  container: [
    ...NAMESPACED,
    patchCookies,
    patchBroadcastChannel,
    hideSharedWorker,
    patchOpeners,
    patchNetworkBarrier,
    recoverFromServiceWorker,
  ],
};

/** Patches the realm `W` with `shared`. False when it was patched already (or is cross-origin). */
export function installInto(W: any, shared: Shared): boolean {
  try {
    if (getOwnPropertyDescriptor(W, MARK)) return false;
    defineProperty(W, MARK, { value: true });
  } catch {
    return false; // cross-origin
  }
  shared.frames.addRealm(W);
  const h = makeHelpers(shared);
  patchToString(W, shared);
  // An indexed loop, not `for...of`: a realm is also adopted after page scripts ran, and the page may have replaced
  // `Array.prototype[Symbol.iterator]` by then.
  const patches = PATCHES[shared.mode];
  for (let i = 0; i < patches.length; i++) patches[i]!(W, shared, h);
  return true;
}
