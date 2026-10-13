/* eslint-disable @typescript-eslint/no-explicit-any -- the natives are used on any realm's objects */
/**
 * Natives captured when the shim's bundle is evaluated (MAIN world, document_start): before any page script can
 * replace them. Every patch uses these, never the (page-replaceable) globals.
 */

/** Marks a realm (window) the shim has patched. */
export const MARK = Symbol.for("facet.shim");

export const {
  defineProperty,
  getOwnPropertyDescriptor,
  getPrototypeOf,
  setPrototypeOf,
} = Object;
export const reflectApply = Reflect.apply as (
  target: any,
  thisArg: any,
  args: ArrayLike<any>,
) => any;
export const nativeFnToString = Function.prototype.toString;
export const jsonParse = JSON.parse;
export const jsonStringify = JSON.stringify;
// Captured before any page script: the page can redefine `length` on its window (it is [Replaceable]).
export const nativeWindowLength = getOwnPropertyDescriptor(
  window,
  "length",
)?.get;
export const nativeAddListener = EventTarget.prototype.addEventListener;
export const NativeMutationObserver = MutationObserver;
export const nativeObserve = MutationObserver.prototype.observe;
export const NativeWeakRef = WeakRef;

/** The object on `obj`'s prototype chain that owns `key`, or null. */
export function findOwner(obj: any, key: PropertyKey): any {
  for (let o = obj; o; o = getPrototypeOf(o))
    if (getOwnPropertyDescriptor(o, key)) return o;
  return null;
}
