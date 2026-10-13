import { visibleNames } from "../../namespace";
import {
  defineProperty,
  getOwnPropertyDescriptor,
  reflectApply,
} from "../natives";
import type { Patch } from "../patch-helpers";

/** `localStorage` / `sessionStorage` show the namespace's keys only (prefixed underneath); `storage` events follow. */
export const patchStorage: Patch = (W, shared, h) => {
  const SP = W.Storage?.prototype;
  if (!SP) return;
  const ns = shared.ns;
  const views = shared.storageViews;
  const nativeKey = SP.key as (i: number) => string | null;
  const nativeLength = getOwnPropertyDescriptor(SP, "length")!
    .get as () => number;
  const nativeGet = SP.getItem as (k: string) => string | null;
  const nativeSet = SP.setItem as (k: string, v: string) => void;
  const nativeRemove = SP.removeItem as (k: string) => void;
  const rawKeys = (real: Storage): string[] => {
    const out: string[] = [];
    const n = reflectApply(nativeLength, real, []) as number;
    for (let i = 0; i < n; i++) {
      const k = reflectApply(nativeKey, real, [i]) as string | null;
      if (k !== null) out.push(k);
    }
    return out;
  };
  const visible = (real: Storage) => visibleNames(rawKeys(real), ns);

  h.replaceMethod(SP, "getItem", function (original, args) {
    const v = views.get(this);
    if (!v || args.length < 1)
      return reflectApply(original, v ? v.real : this, args);
    return reflectApply(original, v.real, [ns.toRaw(String(args[0]))]);
  });
  h.replaceMethod(SP, "setItem", function (original, args) {
    const v = views.get(this);
    if (!v || args.length < 2)
      return reflectApply(original, v ? v.real : this, args);
    return reflectApply(original, v.real, [
      ns.toRaw(String(args[0])),
      String(args[1]),
    ]);
  });
  h.replaceMethod(SP, "removeItem", function (original, args) {
    const v = views.get(this);
    if (!v || args.length < 1)
      return reflectApply(original, v ? v.real : this, args);
    return reflectApply(original, v.real, [ns.toRaw(String(args[0]))]);
  });
  h.replaceMethod(SP, "key", function (original, args) {
    const v = views.get(this);
    if (!v || args.length < 1)
      return reflectApply(original, v ? v.real : this, args);
    const index = Number(args[0]) >>> 0;
    const keys = visible(v.real);
    return index < keys.length ? keys[index] : null;
  });
  h.replaceMethod(SP, "clear", function (original, args) {
    const v = views.get(this);
    if (!v) return reflectApply(original, this, args);
    for (const raw of rawKeys(v.real))
      if (ns.owns(raw)) reflectApply(nativeRemove, v.real, [raw]);
  });
  h.replaceAccessor(SP, "length", {
    get(original) {
      const v = views.get(this);
      return v ? visible(v.real).length : reflectApply(original, this, []);
    },
  });

  const makeView = (real: Storage): object => {
    const has = (name: string) =>
      reflectApply(nativeGet, real, [ns.toRaw(name)]) !== null;
    const view: object = new Proxy(real, {
      get(_t, prop) {
        if (typeof prop === "symbol" || prop in SP)
          return Reflect.get(SP, prop, view);
        const value = reflectApply(nativeGet, real, [ns.toRaw(prop)]);
        return value === null ? undefined : value;
      },
      set(_t, prop, value) {
        if (typeof prop === "symbol") return false;
        reflectApply(nativeSet, real, [ns.toRaw(prop), String(value)]);
        return true;
      },
      deleteProperty(_t, prop) {
        if (typeof prop === "symbol") return true;
        reflectApply(nativeRemove, real, [ns.toRaw(prop)]);
        return true;
      },
      has(_t, prop) {
        if (typeof prop === "symbol" || prop in SP) return prop in SP;
        return has(prop);
      },
      ownKeys() {
        return visible(real);
      },
      getOwnPropertyDescriptor(_t, prop) {
        if (typeof prop === "symbol") return undefined;
        const value = reflectApply(nativeGet, real, [ns.toRaw(prop)]);
        return value === null
          ? undefined
          : { value, writable: true, enumerable: true, configurable: true };
      },
      defineProperty(_t, prop, desc) {
        if (typeof prop === "symbol" || !("value" in desc)) return false;
        reflectApply(nativeSet, real, [ns.toRaw(prop), String(desc.value)]);
        return true;
      },
      getPrototypeOf: () => SP,
      setPrototypeOf: () => false,
      preventExtensions: () => false,
      isExtensible: () => true,
    });
    views.set(view, { real, ns });
    shared.realToView.set(real, view);
    return view;
  };

  for (const key of ["localStorage", "sessionStorage"]) {
    let cachedReal: Storage | null = null;
    let cachedView: object | null = null;
    h.replaceAccessor(W, key, {
      get(original) {
        const real = reflectApply(original, this, []) as Storage | null;
        if (!real) return real;
        if (real !== cachedReal) {
          cachedReal = real;
          cachedView = shared.realToView.get(real) ?? makeView(real);
        }
        return cachedView;
      },
    });
  }

  // `storage` events report raw keys of every namespace: drop foreign ones, rewrite ours.
  const StorageEvent = W.StorageEvent;
  W.addEventListener(
    "storage",
    (event: StorageEvent) => {
      if (shared.redispatched.has(event)) return;
      // Any storage area reported to this window is this window's own local or session storage.
      const area = event.storageArea;
      if (!area) return;
      const view = shared.realToView.get(area) ?? makeView(area);
      event.stopImmediatePropagation();
      if (event.key !== null && !ns.owns(event.key)) return;
      const copy = new StorageEvent("storage", {
        key: event.key === null ? null : ns.fromRaw(event.key),
        oldValue: event.oldValue,
        newValue: event.newValue,
        url: event.url,
        storageArea: null,
      });
      defineProperty(copy, "storageArea", {
        value: view,
        enumerable: true,
        configurable: true,
      });
      shared.redispatched.add(copy);
      W.dispatchEvent(copy);
    },
    true,
  );
};
