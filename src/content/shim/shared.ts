/* eslint-disable @typescript-eslint/no-explicit-any -- the bridge answers are untyped JSON */
import {
  type BridgePush,
  type BridgeRequest,
  PUSH_EVENT,
  REQ_EVENT,
  RES_ATTR,
  type ShimMode,
} from "../bridge-protocol";
import { containerNamespace, realNamespace } from "../namespace";
import { jsonParse, jsonStringify, reflectApply } from "./natives";
import type { FrameGuard, Shared } from "./types";

const SETTLE_WAIT_MS = 400;
const WRITE_WAIT_MS = 1000;

/**
 * The `Shared` of one shim run: the synchronous request channel to the beacon (`bridge` element events and
 * attributes), its pushes, the document.cookie write barrier and the fetch barrier. `frames` builds its FrameGuard.
 */
export function createShared(
  bridge: Element,
  mode: ShimMode,
  containerId: string,
  frames: (shared: Shared) => FrameGuard,
): Shared {
  const dispatch = EventTarget.prototype.dispatchEvent;
  const addListener = EventTarget.prototype.addEventListener;
  const getAttr = Element.prototype.getAttribute;
  const removeAttr = Element.prototype.removeAttribute;
  const NativeCustomEvent = CustomEvent;
  const setTimer = setTimeout;
  const NativePromise = Promise;
  const pushListeners: Array<(push: BridgePush) => void> = [];

  const request = (req: BridgeRequest): any => {
    reflectApply(dispatch, bridge, [
      new NativeCustomEvent(REQ_EVENT, { detail: jsonStringify(req) }),
    ]);
    const raw = reflectApply(getAttr, bridge, [RES_ATTR]) as string | null;
    reflectApply(removeAttr, bridge, [RES_ATTR]);
    try {
      return raw ? jsonParse(raw) : null;
    } catch {
      return null;
    }
  };
  reflectApply(addListener, bridge, [
    PUSH_EVENT,
    (event: Event) => {
      let push: BridgePush;
      try {
        push = jsonParse(String((event as CustomEvent).detail));
      } catch {
        return;
      }
      for (const listener of pushListeners) listener(push);
    },
  ]);

  let seq = 0;
  const pendingWrites = new Set<number>();
  let writeWaiters: Array<() => void> = [];
  const settleWaiters = new Map<number, () => void>();
  pushListeners.push((push) => {
    if (push.t === "cookie-ack") {
      pendingWrites.delete(push.id);
      if (pendingWrites.size === 0) {
        const waiters = writeWaiters;
        writeWaiters = [];
        for (const w of waiters) w();
      }
    } else if (push.t === "settled") {
      settleWaiters.get(push.id)?.();
      settleWaiters.delete(push.id);
    }
  });
  const bounded = (p: Promise<void>, ms: number) =>
    NativePromise.race([p, new NativePromise<void>((r) => setTimer(r, ms))]);

  const shared: Shared = {
    mode,
    key: mode === "container" ? containerId : "",
    ns:
      mode === "container" ? containerNamespace(containerId) : realNamespace(),
    masks: new WeakMap(),
    request,
    onPush: (listener) => void pushListeners.push(listener),
    nextId: () => ++seq,
    trackWrite: (id) => void pendingWrites.add(id),
    writesSettled: () =>
      pendingWrites.size === 0
        ? null
        : bounded(
            new NativePromise<void>((r) => writeWaiters.push(r)),
            WRITE_WAIT_MS,
          ),
    settle: (url, method) => {
      const id = ++seq;
      const done = new NativePromise<void>((r) => settleWaiters.set(id, r));
      request({ op: "settle", id, url, method });
      return bounded(done, SETTLE_WAIT_MS).then(
        () => void settleWaiters.delete(id),
      );
    },
    storageViews: new WeakMap(),
    realToView: new WeakMap(),
    redispatched: new WeakSet(),
    frames: null as unknown as FrameGuard,
  };
  shared.frames = frames(shared);
  return shared;
}
