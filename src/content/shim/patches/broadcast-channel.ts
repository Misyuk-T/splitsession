/* eslint-disable @typescript-eslint/no-explicit-any -- wraps another realm's constructor */
import type { Patch } from "../patch-helpers";
import { unprefixedName } from "../patch-helpers";

/** BroadcastChannel names are namespaced (a channel of another container, or of the real profile, never hears ours). */
export const patchBroadcastChannel: Patch = (W, shared, h) => {
  const Native = W.BroadcastChannel;
  if (typeof Native !== "function") return;
  const ns = shared.ns;
  const Wrapped: any = new Proxy(Native, {
    construct(target, args, newTarget): object {
      if (args.length < 1)
        return Reflect.construct(
          target,
          args,
          newTarget === Wrapped ? target : newTarget,
        );
      return Reflect.construct(
        target,
        [ns.toRaw(String(args[0])), ...args.slice(1)],
        newTarget === Wrapped ? target : newTarget,
      );
    },
  });
  h.setValue(W, "BroadcastChannel", Wrapped);
  h.setValue(Native.prototype, "constructor", Wrapped);
  h.replaceAccessor(Native.prototype, "name", { get: unprefixedName(ns) });
};
