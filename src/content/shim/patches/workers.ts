/* eslint-disable @typescript-eslint/no-explicit-any -- the page's worker objects are duck-typed */
import { getOwnPropertyDescriptor } from "../natives";
import type { Patch } from "../patch-helpers";

/** Service-worker registration is rejected (a worker's fetches carry no tab ID, outside the container's rules). */
export const patchServiceWorker: Patch = (W, _shared, h) => {
  const SWC = W.ServiceWorkerContainer?.prototype;
  if (!SWC) return;
  h.replaceMethod(SWC, "register", () =>
    W.Promise.reject(
      new W.DOMException(
        "Service workers are disabled by SplitSession (containers).",
        "SecurityError",
      ),
    ),
  );
};

/** SharedWorker is unavailable in a container (its fetches would carry the real profile's cookies). */
export const hideSharedWorker: Patch = (W, _shared, h) => {
  h.setValue(W, "SharedWorker", undefined);
};

/** A page served by a service worker in a container tab came through the real profile: drop the worker, reload. */
export const recoverFromServiceWorker: Patch = (W) => {
  try {
    const container = W.navigator.serviceWorker;
    if (!container?.controller) return;
    const flag = "__facet:sw-recovery";
    const session = getOwnPropertyDescriptor(W, "sessionStorage")
      ? W.sessionStorage
      : null;
    if (session?.getItem(flag)) return;
    session?.setItem(flag, "1");
    W.stop();
    container
      .getRegistrations()
      .then((regs: any[]) => Promise.all(regs.map((r) => r.unregister())))
      .finally(() => W.location.reload());
  } catch {
    // best effort
  }
};
