/* eslint-disable @typescript-eslint/no-explicit-any -- this file patches untyped corners of the DOM on purpose */
import type { Namespace } from "../namespace";
import {
  defineProperty,
  findOwner,
  getOwnPropertyDescriptor,
  nativeFnToString,
  reflectApply,
} from "./natives";
import type { Shared } from "./types";

/**
 * How patches replace natives: properties on prototypes are redefined (never deleted), keep their name and arity, and
 * report the native's source text (`masks`, read by the patched `Function.prototype.toString`).
 */
export function makeHelpers(shared: Shared) {
  const nativeSource = (fn: any): string => {
    const masked = shared.masks.get(fn);
    return masked !== undefined
      ? masked
      : (reflectApply(nativeFnToString, fn, []) as string);
  };
  const mask = <T extends object>(fn: T, original: any): T => {
    shared.masks.set(fn, nativeSource(original));
    return fn;
  };

  /** Replaces `obj[key]` (a method) with `impl(original, args)` called with the caller's `this`. */
  const replaceMethod = (
    obj: any,
    key: string,
    impl: (this: any, original: any, args: any[]) => any,
  ): void => {
    const owner = obj && findOwner(obj, key);
    const desc = owner && getOwnPropertyDescriptor(owner, key);
    if (!desc || typeof desc.value !== "function") return;
    const original = desc.value;
    const wrapper = {
      [key](this: any, ...args: any[]) {
        return reflectApply(impl, this, [original, args]);
      },
    }[key]!;
    defineProperty(wrapper, "length", {
      value: original.length,
      configurable: true,
    });
    defineProperty(owner, key, { ...desc, value: mask(wrapper, original) });
  };

  const replaceAccessor = (
    obj: any,
    key: string,
    impl: {
      get?: (this: any, original: () => any) => any;
      set?: (this: any, original: (v: any) => void, value: any) => void;
    },
  ): void => {
    const owner = obj && findOwner(obj, key);
    const desc = owner && getOwnPropertyDescriptor(owner, key);
    if (!desc || (!desc.get && !desc.set)) return;
    const next: PropertyDescriptor = { ...desc };
    if (impl.get && desc.get) {
      const original = desc.get;
      const getter = getOwnPropertyDescriptor(
        {
          get [key]() {
            return reflectApply(impl.get!, this, [original]);
          },
        },
        key,
      )!.get!;
      next.get = mask(getter, original);
    }
    if (impl.set && desc.set) {
      const original = desc.set;
      const setter = getOwnPropertyDescriptor(
        {
          set [key](value: any) {
            reflectApply(impl.set!, this, [original, value]);
          },
        },
        key,
      )!.set!;
      next.set = mask(setter, original);
    }
    defineProperty(owner, key, next);
  };

  const setValue = (obj: any, key: string, value: any): void => {
    const owner = findOwner(obj, key) ?? obj;
    const desc = getOwnPropertyDescriptor(owner, key);
    defineProperty(
      owner,
      key,
      desc && "value" in desc
        ? { ...desc, value }
        : { value, writable: true, configurable: true, enumerable: false },
    );
  };

  return { mask, replaceMethod, replaceAccessor, setValue, nativeSource };
}

export type Helpers = ReturnType<typeof makeHelpers>;

/** One patch: applied to the realm `W` (its window) with the run's `Shared`. */
export type Patch = (W: any, shared: Shared, h: Helpers) => void;

/** A `replaceMethod` implementation that namespaces the first argument (a database or cache name). */
export const renameFirstArg = (ns: Namespace) =>
  function (this: any, original: any, args: any[]) {
    if (args.length < 1) return reflectApply(original, this, args);
    return reflectApply(original, this, [
      ns.toRaw(String(args[0])),
      ...args.slice(1),
    ]);
  };

/** An accessor `get` that shows a namespaced name (of a database or channel) without its prefix. */
export const unprefixedName = (ns: Namespace) =>
  function (this: any, original: () => any) {
    const raw = reflectApply(original, this, []) as string;
    return ns.owns(raw) ? ns.fromRaw(raw) : raw;
  };
