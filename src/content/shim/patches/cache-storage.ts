import { visibleNames } from "../../namespace";
import { reflectApply } from "../natives";
import { type Patch, renameFirstArg } from "../patch-helpers";

/** Cache Storage names are namespaced; `caches.match` searches the namespace's caches only. */
export const patchCaches: Patch = (W, shared, h) => {
  const C = W.CacheStorage?.prototype;
  if (!C) return;
  const ns = shared.ns;
  const nativeKeys = C.keys;
  const nativeOpen = C.open;
  const renamed = renameFirstArg(ns);
  h.replaceMethod(C, "open", renamed);
  h.replaceMethod(C, "has", renamed);
  h.replaceMethod(C, "delete", renamed);
  h.replaceMethod(C, "keys", function (original, args) {
    return reflectApply(original, this, args).then((names: string[]) =>
      visibleNames(names, ns),
    );
  });
  h.replaceMethod(C, "match", function (original, args) {
    const [req, options] = args;
    if (options && options.cacheName !== undefined) {
      return reflectApply(original, this, [
        req,
        { ...options, cacheName: ns.toRaw(String(options.cacheName)) },
      ]);
    }
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the async IIFE below needs the Storage instance, and an arrow would hide it from the patched method's own `this` rules
    const storage = this;
    return (async () => {
      const names: string[] = await reflectApply(nativeKeys, storage, []);
      for (const raw of names) {
        if (!ns.owns(raw)) continue;
        const cache = await reflectApply(nativeOpen, storage, [raw]);
        const hit = await cache.match(req, options);
        if (hit) return hit;
      }
      return undefined;
    })();
  });
};
