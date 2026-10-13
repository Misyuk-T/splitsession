import { reflectApply } from "../natives";
import { type Patch, renameFirstArg, unprefixedName } from "../patch-helpers";

/** IndexedDB database names are namespaced; `databases()` lists the namespace's own. */
export const patchIndexedDb: Patch = (W, shared, h) => {
  const F = W.IDBFactory?.prototype;
  if (!F) return;
  const ns = shared.ns;
  const renamed = renameFirstArg(ns);
  h.replaceMethod(F, "open", renamed);
  h.replaceMethod(F, "deleteDatabase", renamed);
  h.replaceMethod(F, "databases", function (original, args) {
    return reflectApply(original, this, args).then(
      (list: Array<{ name: string; version: number }>) =>
        list
          .filter((d) => ns.owns(d.name))
          .map((d) => ({ name: ns.fromRaw(d.name), version: d.version })),
    );
  });
  h.replaceAccessor(W.IDBDatabase?.prototype, "name", {
    get: unprefixedName(ns),
  });
};
