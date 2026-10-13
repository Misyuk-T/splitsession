/* eslint-disable @typescript-eslint/no-explicit-any -- patches another realm's Function.prototype */
import {
  defineProperty,
  getOwnPropertyDescriptor,
  nativeFnToString,
  reflectApply,
} from "../natives";
import type { Shared } from "../types";

/** `Function.prototype.toString` reports the native source text of every patched function (`shared.masks`). */
export function patchToString(W: any, shared: Shared): void {
  const proto = W.Function.prototype;
  const current = proto.toString;
  if (shared.masks.has(current)) return;
  const proxy = new Proxy(current, {
    apply(target, thisArg, args) {
      const masked = shared.masks.get(thisArg);
      return masked !== undefined
        ? masked
        : reflectApply(target, thisArg, args);
    },
  });
  shared.masks.set(
    proxy,
    reflectApply(nativeFnToString, current, []) as string,
  );
  defineProperty(proto, "toString", {
    ...getOwnPropertyDescriptor(proto, "toString"),
    value: proxy,
  });
}
