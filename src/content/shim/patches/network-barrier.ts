import { reflectApply } from "../natives";
import type { Patch } from "../patch-helpers";

/** XMLHttpRequest events held back until the response's cookies reached the rules. */
const GATED = ["readystatechange", "load", "loadend"];

/** fetch / XHR barrier: requests wait for pending cookie writes; responses wait until their Set-Cookie is in. */
export const patchNetworkBarrier: Patch = (W, shared, h) => {
  h.replaceMethod(W, "fetch", (original, args) => {
    const P = W.Promise;
    const before = shared.writesSettled();
    const send = () => reflectApply(original, W, args) as Promise<Response>;
    const method = String(
      (args[1] && args[1].method) ||
        (args[0] instanceof W.Request ? args[0].method : "GET"),
    );
    return (before ? before.then(send) : send()).then((response: Response) =>
      shared.settle(response.url, method).then(() => response),
    ) as typeof P;
  });

  const XHR = W.XMLHttpRequest?.prototype;
  if (!XHR) return;
  interface Pending {
    method: string;
    url: string;
    async: boolean;
    queue: Event[];
    settling: Promise<void> | null;
  }
  const pending = new WeakMap<object, Pending>();
  const gated = new WeakSet<object>();
  /**
   * The gate goes on at open(), before a page can add its handlers: on an XMLHttpRequest listeners run in the order they
   * were added (a capture listener gets no priority, unlike on a DOM node), so a gate added only at send() would run
   * after an `onload` set earlier and the page would read the response before its cookies reached the rules.
   */
  const install = (xhr: XMLHttpRequest) => {
    if (gated.has(xhr)) return;
    gated.add(xhr);
    const gate = (event: Event) => {
      const state = pending.get(xhr);
      if (!state?.async || shared.redispatched.has(event)) return;
      if (event.type === "readystatechange" && xhr.readyState !== 4) return;
      if (xhr.status === 0) return; // network error / abort: no cookies to wait for
      event.stopImmediatePropagation();
      const copy =
        event.type === "readystatechange"
          ? new W.Event("readystatechange")
          : new W.ProgressEvent(event.type, {
              lengthComputable: (event as ProgressEvent).lengthComputable,
              loaded: (event as ProgressEvent).loaded,
              total: (event as ProgressEvent).total,
            });
      state.queue.push(copy);
      state.settling ??= shared
        .settle(xhr.responseURL || state.url, state.method)
        .then(() => {
          for (const e of state.queue.splice(0)) {
            shared.redispatched.add(e);
            xhr.dispatchEvent(e);
          }
        });
    };
    for (const type of GATED) xhr.addEventListener(type, gate, true);
  };
  h.replaceMethod(XHR, "open", function (original, args) {
    pending.set(this, {
      method: String(args[0] ?? "GET"),
      url: String(args[1] ?? ""),
      async: args.length < 3 || Boolean(args[2]),
      queue: [],
      settling: null,
    });
    install(this);
    return reflectApply(original, this, args);
  });
  h.replaceMethod(XHR, "send", function (original, args) {
    const info = pending.get(this);
    if (!info || !info.async) return reflectApply(original, this, args);
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the delayed start below runs with its own `this`
    const xhr = this;
    const start = () => reflectApply(original, xhr, args);
    const before = shared.writesSettled();
    if (!before) return start();
    // Delay the send itself until pending document.cookie writes reached the rules.
    void before.then(start);
    return undefined;
  });
};
