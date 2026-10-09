/* eslint-disable @typescript-eslint/no-explicit-any -- this file patches untyped corners of the DOM on purpose */
import {
  BRIDGE_TAG,
  CONTAINER_ATTR,
  MODE_ATTR,
  PUSH_EVENT,
  REQ_EVENT,
  RES_ATTR,
  SKIP_ATTR,
  type BridgePush,
  type BridgeRequest,
  type CookieItem,
  type ShimMode,
} from './bridge-protocol';
import { containerNamespace, realNamespace, visibleNames, type Namespace } from './namespace';

/**
 * MAIN world, document_start, every frame, right after the beacon. Runs before any page script.
 *
 * - container mode: page-visible state is namespaced per container: `document.cookie` / `cookieStore` come from the
 *   container jar (via the beacon), Web Storage keys, IndexedDB / Cache Storage / BroadcastChannel names get the
 *   `__facet:<id>:` prefix, SharedWorker is unavailable (its fetches would carry the real profile's cookies), service
 *   worker registration is rejected, and `window.open` / new-tab link clicks are routed so the child tab is in the
 *   container before its first request. fetch/XHR wait for cookie writes and Set-Cookie to reach the rules.
 * - managed mode (tab without a container on a site containers use): container-namespaced state is hidden and service
 *   worker registration is rejected; nothing else changes.
 * - no bridge: plain tab, nothing is patched.
 *
 * Patches replace properties on prototypes (never `delete`), keep names/arity, and report native source text.
 */

const MARK = Symbol.for('facet.shim');
const CHILD_WAIT_MS = 800;
const SETTLE_WAIT_MS = 400;
const WRITE_WAIT_MS = 1000;

const { defineProperty, getOwnPropertyDescriptor, getPrototypeOf, setPrototypeOf } = Object;
const reflectApply = Reflect.apply as (target: any, thisArg: any, args: ArrayLike<any>) => any;
const nativeFnToString = Function.prototype.toString;
const jsonParse = JSON.parse;
const jsonStringify = JSON.stringify;

interface Shared {
  mode: ShimMode;
  ns: Namespace;
  masks: WeakMap<object, string>;
  request(req: BridgeRequest): any;
  onPush(listener: (push: BridgePush) => void): void;
  /** Resolves when no document.cookie write is waiting for the background (bounded). */
  writesSettled(): Promise<void> | null;
  trackWrite(id: number): void;
  nextId(): number;
  /** Fetch barrier for a finished response. */
  settle(url: string, method: string): Promise<void>;
  storageViews: WeakMap<object, { real: Storage; ns: Namespace }>;
  realToView: WeakMap<object, object>;
  redispatched: WeakSet<Event>;
}

export function runShim(): void {
  const root = document.documentElement;
  if (!root) return;
  const bridge = root.querySelector(`:scope > ${BRIDGE_TAG}`);
  if (!bridge) return;
  bridge.remove();
  if (bridge.hasAttribute(SKIP_ATTR)) return;
  const mode = bridge.getAttribute(MODE_ATTR);
  if (mode !== 'container' && mode !== 'managed') return;
  const containerId = bridge.getAttribute(CONTAINER_ATTR) ?? '';
  if (mode === 'container' && !/^[a-z0-9]{1,32}$/.test(containerId)) return;
  installInto(window as any, createShared(bridge, mode, containerId));
}

function createShared(bridge: Element, mode: ShimMode, containerId: string): Shared {
  const dispatch = EventTarget.prototype.dispatchEvent;
  const addListener = EventTarget.prototype.addEventListener;
  const getAttr = Element.prototype.getAttribute;
  const removeAttr = Element.prototype.removeAttribute;
  const NativeCustomEvent = CustomEvent;
  const setTimer = setTimeout;
  const NativePromise = Promise;
  const pushListeners: Array<(push: BridgePush) => void> = [];

  const request = (req: BridgeRequest): any => {
    reflectApply(dispatch, bridge, [new NativeCustomEvent(REQ_EVENT, { detail: jsonStringify(req) })]);
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
    if (push.t === 'cookie-ack') {
      pendingWrites.delete(push.id);
      if (pendingWrites.size === 0) {
        const waiters = writeWaiters;
        writeWaiters = [];
        for (const w of waiters) w();
      }
    } else if (push.t === 'settled') {
      settleWaiters.get(push.id)?.();
      settleWaiters.delete(push.id);
    }
  });
  const bounded = (p: Promise<void>, ms: number) => NativePromise.race([p, new NativePromise<void>((r) => setTimer(r, ms))]);

  return {
    mode,
    ns: mode === 'container' ? containerNamespace(containerId) : realNamespace(),
    masks: new WeakMap(),
    request,
    onPush: (listener) => void pushListeners.push(listener),
    nextId: () => ++seq,
    trackWrite: (id) => void pendingWrites.add(id),
    writesSettled: () =>
      pendingWrites.size === 0 ? null : bounded(new NativePromise<void>((r) => writeWaiters.push(r)), WRITE_WAIT_MS),
    settle: (url, method) => {
      const id = ++seq;
      const done = new NativePromise<void>((r) => settleWaiters.set(id, r));
      request({ op: 'settle', id, url, method });
      return bounded(done, SETTLE_WAIT_MS).then(() => void settleWaiters.delete(id));
    },
    storageViews: new WeakMap(),
    realToView: new WeakMap(),
    redispatched: new WeakSet(),
  };
}

// ------------------------------------------------------------------------------------------------ patch helpers

function findOwner(obj: any, key: PropertyKey): any {
  for (let o = obj; o; o = getPrototypeOf(o)) if (getOwnPropertyDescriptor(o, key)) return o;
  return null;
}

function makeHelpers(shared: Shared) {
  const nativeSource = (fn: any): string => {
    const masked = shared.masks.get(fn);
    return masked !== undefined ? masked : (reflectApply(nativeFnToString, fn, []) as string);
  };
  const mask = <T extends object>(fn: T, original: any): T => {
    shared.masks.set(fn, nativeSource(original));
    return fn;
  };

  /** Replaces `obj[key]` (a method) with `impl(original, args)` called with the caller's `this`. */
  const replaceMethod = (obj: any, key: string, impl: (this: any, original: any, args: any[]) => any): void => {
    const owner = obj && findOwner(obj, key);
    const desc = owner && getOwnPropertyDescriptor(owner, key);
    if (!desc || typeof desc.value !== 'function') return;
    const original = desc.value;
    const wrapper = {
      [key](this: any, ...args: any[]) {
        return reflectApply(impl, this, [original, args]);
      },
    }[key]!;
    defineProperty(wrapper, 'length', { value: original.length, configurable: true });
    defineProperty(owner, key, { ...desc, value: mask(wrapper, original) });
  };

  const replaceAccessor = (
    obj: any,
    key: string,
    impl: { get?: (this: any, original: () => any) => any; set?: (this: any, original: (v: any) => void, value: any) => void },
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
    defineProperty(owner, key, desc && 'value' in desc ? { ...desc, value } : { value, writable: true, configurable: true, enumerable: false });
  };

  return { mask, replaceMethod, replaceAccessor, setValue, nativeSource };
}

// ------------------------------------------------------------------------------------------------ install

function installInto(W: any, shared: Shared): void {
  try {
    if (getOwnPropertyDescriptor(W, MARK)) return;
    defineProperty(W, MARK, { value: true });
  } catch {
    return; // cross-origin
  }
  const h = makeHelpers(shared);
  patchToString(W, shared);
  patchStorage(W, shared, h);
  patchIndexedDb(W, shared, h);
  patchCaches(W, shared, h);
  patchServiceWorker(W, h);
  const adopt = patchChildWindows(W, shared, h);
  if (shared.mode !== 'container') return;
  patchCookies(W, shared, h);
  patchBroadcastChannel(W, shared, h);
  h.setValue(W, 'SharedWorker', undefined);
  patchOpeners(W, shared, h, adopt);
  patchNetworkBarrier(W, shared, h);
  recoverFromServiceWorker(W);
}

type Helpers = ReturnType<typeof makeHelpers>;

function patchToString(W: any, shared: Shared): void {
  const proto = W.Function.prototype;
  const current = proto.toString;
  if (shared.masks.has(current)) return;
  const proxy = new Proxy(current, {
    apply(target, thisArg, args) {
      const masked = shared.masks.get(thisArg);
      return masked !== undefined ? masked : reflectApply(target, thisArg, args);
    },
  });
  shared.masks.set(proxy, reflectApply(nativeFnToString, current, []) as string);
  defineProperty(proto, 'toString', { ...getOwnPropertyDescriptor(proto, 'toString'), value: proxy });
}

// ---- document.cookie and cookieStore

function patchCookies(W: any, shared: Shared, h: Helpers): void {
  const opaque = W.origin === 'null';
  const write = (value: string): void => {
    const id = shared.nextId();
    shared.trackWrite(id);
    shared.request({ op: 'cookie-set', v: value, id });
  };
  const hasBrowsingContext = (doc: any) => !opaque && doc != null && doc.defaultView != null;

  h.replaceAccessor(W.Document.prototype, 'cookie', {
    get(original) {
      if (!hasBrowsingContext(this)) return reflectApply(original, this, []);
      const reply = shared.request({ op: 'cookie-get' });
      return reply && typeof reply.v === 'string' ? reply.v : '';
    },
    set(original, value) {
      if (!hasBrowsingContext(this)) return void reflectApply(original, this, [value]);
      write(String(value));
    },
  });

  const CookieStore = W.CookieStore;
  if (typeof CookieStore !== 'function' || !('cookieStore' in W)) return;
  const fake = new W.EventTarget();
  setPrototypeOf(fake, CookieStore.prototype);
  let onchange: any = null;
  const P = W.Promise;
  const list = (): CookieItem[] => shared.request({ op: 'cookie-list' })?.list ?? [];
  const nameOf = (arg: any): string | undefined => (typeof arg === 'string' ? arg : arg && arg.name !== undefined ? String(arg.name) : undefined);
  const attrs = (o: any): string => {
    const parts = [`Path=${o.path ?? '/'}`];
    if (o.domain) parts.push(`Domain=${String(o.domain)}`);
    if (W.isSecureContext) parts.push('Secure');
    if (o.partitioned) parts.push('Partitioned');
    return parts.join('; ');
  };
  const done = () => shared.writesSettled() ?? P.resolve();

  h.replaceMethod(CookieStore.prototype, 'get', function (original, args) {
    if (this !== fake) return reflectApply(original, this, args);
    const name = nameOf(args[0]);
    return P.resolve(list().find((c) => name === undefined || c.name === name) ?? null);
  });
  h.replaceMethod(CookieStore.prototype, 'getAll', function (original, args) {
    if (this !== fake) return reflectApply(original, this, args);
    const name = nameOf(args[0]);
    return P.resolve(list().filter((c) => name === undefined || c.name === name));
  });
  h.replaceMethod(CookieStore.prototype, 'set', function (original, args) {
    if (this !== fake) return reflectApply(original, this, args);
    const o = typeof args[0] === 'string' ? { name: args[0], value: args[1] } : (args[0] ?? {});
    if (o.name === undefined && o.value === undefined) return P.reject(new W.TypeError('cookieStore.set: name or value required'));
    const sameSite = String(o.sameSite ?? 'strict');
    let cookie = `${o.name ?? ''}=${o.value ?? ''}; ${attrs(o)}; SameSite=${sameSite[0]!.toUpperCase()}${sameSite.slice(1)}`;
    if (o.expires !== undefined && o.expires !== null) cookie += `; Expires=${new Date(Number(o.expires)).toUTCString()}`;
    write(cookie);
    return done().then(() => undefined);
  });
  h.replaceMethod(CookieStore.prototype, 'delete', function (original, args) {
    if (this !== fake) return reflectApply(original, this, args);
    const o = typeof args[0] === 'string' ? { name: args[0] } : (args[0] ?? {});
    write(`${o.name ?? ''}=; Max-Age=0; ${attrs(o)}`);
    return done().then(() => undefined);
  });
  h.replaceAccessor(CookieStore.prototype, 'onchange', {
    get(original) {
      return this === fake ? onchange : reflectApply(original, this, []);
    },
    set(original, value) {
      if (this === fake) onchange = typeof value === 'function' || typeof value === 'object' ? value : null;
      else reflectApply(original, this, [value]);
    },
  });
  // The real cookieStore would report the real profile's cookie changes: the page only ever sees `fake`.
  h.replaceAccessor(W, 'cookieStore', {
    get() {
      return fake;
    },
  });
}

// ---- Web Storage

function patchStorage(W: any, shared: Shared, h: Helpers): void {
  const SP = W.Storage?.prototype;
  if (!SP) return;
  const ns = shared.ns;
  const views = shared.storageViews;
  const nativeKey = SP.key as (i: number) => string | null;
  const nativeLength = getOwnPropertyDescriptor(SP, 'length')!.get as () => number;
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

  h.replaceMethod(SP, 'getItem', function (original, args) {
    const v = views.get(this);
    if (!v || args.length < 1) return reflectApply(original, v ? v.real : this, args);
    return reflectApply(original, v.real, [ns.toRaw(String(args[0]))]);
  });
  h.replaceMethod(SP, 'setItem', function (original, args) {
    const v = views.get(this);
    if (!v || args.length < 2) return reflectApply(original, v ? v.real : this, args);
    return reflectApply(original, v.real, [ns.toRaw(String(args[0])), String(args[1])]);
  });
  h.replaceMethod(SP, 'removeItem', function (original, args) {
    const v = views.get(this);
    if (!v || args.length < 1) return reflectApply(original, v ? v.real : this, args);
    return reflectApply(original, v.real, [ns.toRaw(String(args[0]))]);
  });
  h.replaceMethod(SP, 'key', function (original, args) {
    const v = views.get(this);
    if (!v || args.length < 1) return reflectApply(original, v ? v.real : this, args);
    const index = Number(args[0]) >>> 0;
    const keys = visible(v.real);
    return index < keys.length ? keys[index] : null;
  });
  h.replaceMethod(SP, 'clear', function (original, args) {
    const v = views.get(this);
    if (!v) return reflectApply(original, this, args);
    for (const raw of rawKeys(v.real)) if (ns.owns(raw)) reflectApply(nativeRemove, v.real, [raw]);
  });
  h.replaceAccessor(SP, 'length', {
    get(original) {
      const v = views.get(this);
      return v ? visible(v.real).length : reflectApply(original, this, []);
    },
  });

  const makeView = (real: Storage): object => {
    const has = (name: string) => reflectApply(nativeGet, real, [ns.toRaw(name)]) !== null;
    const view: object = new Proxy(real, {
      get(_t, prop) {
        if (typeof prop === 'symbol' || prop in SP) return Reflect.get(SP, prop, view);
        const value = reflectApply(nativeGet, real, [ns.toRaw(prop)]);
        return value === null ? undefined : value;
      },
      set(_t, prop, value) {
        if (typeof prop === 'symbol') return false;
        reflectApply(nativeSet, real, [ns.toRaw(prop), String(value)]);
        return true;
      },
      deleteProperty(_t, prop) {
        if (typeof prop === 'symbol') return true;
        reflectApply(nativeRemove, real, [ns.toRaw(prop)]);
        return true;
      },
      has(_t, prop) {
        if (typeof prop === 'symbol' || prop in SP) return prop in SP;
        return has(prop);
      },
      ownKeys() {
        return visible(real);
      },
      getOwnPropertyDescriptor(_t, prop) {
        if (typeof prop === 'symbol') return undefined;
        const value = reflectApply(nativeGet, real, [ns.toRaw(prop)]);
        return value === null ? undefined : { value, writable: true, enumerable: true, configurable: true };
      },
      defineProperty(_t, prop, desc) {
        if (typeof prop === 'symbol' || !('value' in desc)) return false;
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

  for (const key of ['localStorage', 'sessionStorage']) {
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
    'storage',
    (event: StorageEvent) => {
      if (shared.redispatched.has(event)) return;
      // Any storage area reported to this window is this window's own local or session storage.
      const area = event.storageArea;
      if (!area) return;
      const view = shared.realToView.get(area) ?? makeView(area);
      event.stopImmediatePropagation();
      if (event.key !== null && !ns.owns(event.key)) return;
      const copy = new StorageEvent('storage', {
        key: event.key === null ? null : ns.fromRaw(event.key),
        oldValue: event.oldValue,
        newValue: event.newValue,
        url: event.url,
        storageArea: null,
      });
      defineProperty(copy, 'storageArea', { value: view, enumerable: true, configurable: true });
      shared.redispatched.add(copy);
      W.dispatchEvent(copy);
    },
    true,
  );
}

// ---- IndexedDB and Cache Storage

function patchIndexedDb(W: any, shared: Shared, h: Helpers): void {
  const F = W.IDBFactory?.prototype;
  if (!F) return;
  const ns = shared.ns;
  const renamed = function (this: any, original: any, args: any[]) {
    if (args.length < 1) return reflectApply(original, this, args);
    return reflectApply(original, this, [ns.toRaw(String(args[0])), ...args.slice(1)]);
  };
  h.replaceMethod(F, 'open', renamed);
  h.replaceMethod(F, 'deleteDatabase', renamed);
  h.replaceMethod(F, 'databases', function (original, args) {
    return reflectApply(original, this, args).then((list: Array<{ name: string; version: number }>) =>
      list.filter((d) => ns.owns(d.name)).map((d) => ({ name: ns.fromRaw(d.name), version: d.version })),
    );
  });
  h.replaceAccessor(W.IDBDatabase?.prototype, 'name', {
    get(original) {
      const raw = reflectApply(original, this, []) as string;
      return ns.owns(raw) ? ns.fromRaw(raw) : raw;
    },
  });
}

function patchCaches(W: any, shared: Shared, h: Helpers): void {
  const C = W.CacheStorage?.prototype;
  if (!C) return;
  const ns = shared.ns;
  const nativeKeys = C.keys;
  const nativeOpen = C.open;
  const renamed = function (this: any, original: any, args: any[]) {
    if (args.length < 1) return reflectApply(original, this, args);
    return reflectApply(original, this, [ns.toRaw(String(args[0])), ...args.slice(1)]);
  };
  h.replaceMethod(C, 'open', renamed);
  h.replaceMethod(C, 'has', renamed);
  h.replaceMethod(C, 'delete', renamed);
  h.replaceMethod(C, 'keys', function (original, args) {
    return reflectApply(original, this, args).then((names: string[]) => visibleNames(names, ns));
  });
  h.replaceMethod(C, 'match', function (original, args) {
    const [req, options] = args;
    if (options && options.cacheName !== undefined) {
      return reflectApply(original, this, [req, { ...options, cacheName: ns.toRaw(String(options.cacheName)) }]);
    }
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
}

// ---- BroadcastChannel, service workers

function patchBroadcastChannel(W: any, shared: Shared, h: Helpers): void {
  const Native = W.BroadcastChannel;
  if (typeof Native !== 'function') return;
  const ns = shared.ns;
  const Wrapped: any = new Proxy(Native, {
    construct(target, args, newTarget): object {
      if (args.length < 1) return Reflect.construct(target, args, newTarget === Wrapped ? target : newTarget);
      return Reflect.construct(target, [ns.toRaw(String(args[0])), ...args.slice(1)], newTarget === Wrapped ? target : newTarget);
    },
  });
  h.setValue(W, 'BroadcastChannel', Wrapped);
  h.setValue(Native.prototype, 'constructor', Wrapped);
  h.replaceAccessor(Native.prototype, 'name', {
    get(original) {
      const raw = reflectApply(original, this, []) as string;
      return ns.owns(raw) ? ns.fromRaw(raw) : raw;
    },
  });
}

function patchServiceWorker(W: any, h: Helpers): void {
  const SWC = W.ServiceWorkerContainer?.prototype;
  if (!SWC) return;
  h.replaceMethod(SWC, 'register', function () {
    return W.Promise.reject(new W.DOMException('Service workers are disabled on this site by Facet (containers).', 'SecurityError'));
  });
}

/** A page served by a service worker in a container tab came through the real profile: drop the worker, reload. */
function recoverFromServiceWorker(W: any): void {
  try {
    const container = W.navigator.serviceWorker;
    if (!container?.controller) return;
    const flag = '__facet:sw-recovery';
    const session = getOwnPropertyDescriptor(W, 'sessionStorage') ? W.sessionStorage : null;
    if (session?.getItem(flag)) return;
    session?.setItem(flag, '1');
    W.stop();
    container
      .getRegistrations()
      .then((regs: any[]) => Promise.all(regs.map((r) => r.unregister())))
      .finally(() => W.location.reload());
  } catch {
    // best effort
  }
}

// ---- same-origin child windows (about:blank iframes and popups) get the same patches before the page uses them

function patchChildWindows(W: any, shared: Shared, h: Helpers): (win: any) => void {
  const adopt = (child: any) => {
    if (!child || child === W) return;
    try {
      void child.document; // throws for cross-origin
      installInto(child, shared);
    } catch {
      // cross-origin: it has its own content scripts
    }
  };
  for (const Ctor of [W.HTMLIFrameElement, W.HTMLFrameElement, W.HTMLObjectElement]) {
    const proto = Ctor?.prototype;
    if (!proto) continue;
    h.replaceAccessor(proto, 'contentWindow', {
      get(original) {
        const win = reflectApply(original, this, []);
        adopt(win);
        return win;
      },
    });
    h.replaceAccessor(proto, 'contentDocument', {
      get(original) {
        const doc = reflectApply(original, this, []);
        if (doc) adopt(doc.defaultView);
        return doc;
      },
    });
  }
  if (shared.mode !== 'container') {
    h.replaceMethod(W, 'open', function (original, args) {
      const win = reflectApply(original, this, args);
      adopt(win);
      return win;
    });
  }
  return adopt;
}

// ---- window.open and links that open new tabs

function patchOpeners(W: any, shared: Shared, h: Helpers, adopt: (win: any) => void): void {
  const pendingChildren = new Map<string, { win: any; url: string; timer: ReturnType<typeof setTimeout> }>();
  const go = (nonce: string) => {
    const pending = pendingChildren.get(nonce);
    if (!pending) return;
    pendingChildren.delete(nonce);
    clearTimeout(pending.timer);
    try {
      if (!pending.win.closed) pending.win.location.replace(pending.url);
    } catch {
      // the child navigated away or was closed
    }
  };
  shared.onPush((push) => {
    if (push.t === 'child') go(push.nonce);
  });
  const randomNonce = () => {
    const bytes = new Uint8Array(8);
    W.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 16);
  };
  const networkUrl = (raw: string): string | null => {
    try {
      const url = new URL(raw, W.document.baseURI);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
    } catch {
      return null;
    }
  };
  const isNoopener = (features: string) =>
    features.split(/[\s,]+/).some((f) => {
      const [name, value] = f.toLowerCase().split('=');
      return (name === 'noopener' || name === 'noreferrer') && (value === undefined || value === '' || value === 'yes' || value === '1' || value === 'true');
    });
  const openTab = (url: string, active: boolean) => shared.request({ op: 'open-tab', url, active });

  const openOwner = findOwner(W, 'open');
  const nativeOpen = openOwner ? getOwnPropertyDescriptor(openOwner, 'open')!.value : null;
  if (typeof nativeOpen !== 'function') return;
  const openViaBlank = (thisArg: any, url: string, target: string, features: string) => {
    const nonce = randomNonce();
    const win = reflectApply(nativeOpen, thisArg, [`about:blank#facet-${nonce}`, target, features]);
    // Not adopted: it leaves about:blank within CHILD_WAIT_MS and gets its own scripts there.
    if (!win) return win;
    pendingChildren.set(nonce, { win, url, timer: setTimeout(() => go(nonce), CHILD_WAIT_MS) });
    shared.request({ op: 'await-child', nonce });
    return win;
  };

  h.replaceMethod(W, 'open', function (original, args) {
    const url = args[0] === undefined || args[0] === null ? '' : String(args[0]);
    const href = url === '' ? null : networkUrl(url);
    const target = args[1] === undefined ? '_blank' : String(args[1]);
    const features = args[2] === undefined ? '' : String(args[2]);
    if (!href || /^_(self|parent|top)$/i.test(target)) {
      const win = reflectApply(original, this, args);
      adopt(win);
      return win;
    }
    if (isNoopener(features)) {
      openTab(href, true);
      return null;
    }
    return openViaBlank(this, href, target === '' ? '_blank' : target, features);
  });

  const linkOf = (event: Event): HTMLAnchorElement | HTMLAreaElement | null => {
    for (const node of event.composedPath()) {
      if (node instanceof W.HTMLAnchorElement || node instanceof W.HTMLAreaElement) {
        const a = node as HTMLAnchorElement;
        return a.hasAttribute('href') ? a : null;
      }
    }
    return null;
  };
  const onActivate = (event: MouseEvent) => {
    if (event.defaultPrevented) return;
    const link = linkOf(event);
    if (!link || link.hasAttribute('download')) return;
    const href = networkUrl(link.href);
    if (!href) return;
    const modifier = event.ctrlKey || event.metaKey || event.shiftKey;
    const middle = event.type === 'auxclick' && event.button === 1;
    const target = (link.getAttribute('target') ?? '').trim();
    const targetsOther = target !== '' && !/^_(self|parent|top)$/i.test(target);
    if (event.type === 'click' && (event.button !== 0 || (!modifier && !targetsOther))) return;
    if (event.type === 'auxclick' && !middle) return;
    event.preventDefault();
    const rel = ` ${(link.getAttribute('rel') ?? '').toLowerCase()} `;
    const wantsOpener = rel.includes(' opener ') && !rel.includes(' noopener ') && !rel.includes(' noreferrer ');
    if (!modifier && !middle && targetsOther && (wantsOpener || target.toLowerCase() !== '_blank')) {
      openViaBlank(W, href, target, '');
    } else {
      // target=_blank implies noopener; modified and middle clicks open background tabs.
      openTab(href, !(middle || event.ctrlKey || event.metaKey));
    }
  };
  W.addEventListener('click', onActivate, false);
  W.addEventListener('auxclick', onActivate, false);
}

// ---- fetch / XHR barrier: requests wait for pending cookie writes; responses wait until their Set-Cookie is in

function patchNetworkBarrier(W: any, shared: Shared, h: Helpers): void {
  h.replaceMethod(W, 'fetch', function (original, args) {
    const P = W.Promise;
    const before = shared.writesSettled();
    const send = () => reflectApply(original, W, args) as Promise<Response>;
    const method = String((args[1] && args[1].method) || (args[0] instanceof W.Request ? args[0].method : 'GET'));
    return (before ? before.then(send) : send()).then((response: Response) =>
      shared.settle(response.url, method).then(() => response),
    ) as typeof P;
  });

  const XHR = W.XMLHttpRequest?.prototype;
  if (!XHR) return;
  const meta = new WeakMap<object, { method: string; url: string; async: boolean }>();
  h.replaceMethod(XHR, 'open', function (original, args) {
    meta.set(this, { method: String(args[0] ?? 'GET'), url: String(args[1] ?? ''), async: args.length < 3 || Boolean(args[2]) });
    return reflectApply(original, this, args);
  });
  const GATED = ['readystatechange', 'load', 'loadend'];
  h.replaceMethod(XHR, 'send', function (original, args) {
    const info = meta.get(this);
    if (!info || !info.async) return reflectApply(original, this, args);
    const xhr = this;
    const queue: Event[] = [];
    let settling: Promise<void> | null = null;
    const gate = (event: Event) => {
      if (shared.redispatched.has(event)) return;
      if (event.type === 'readystatechange' && xhr.readyState !== 4) return;
      if (xhr.status === 0) return; // network error / abort: no cookies to wait for
      event.stopImmediatePropagation();
      const copy =
        event.type === 'readystatechange'
          ? new W.Event('readystatechange')
          : new W.ProgressEvent(event.type, {
              lengthComputable: (event as ProgressEvent).lengthComputable,
              loaded: (event as ProgressEvent).loaded,
              total: (event as ProgressEvent).total,
            });
      queue.push(copy);
      settling ??= shared.settle(xhr.responseURL || info.url, info.method).then(() => {
        for (const e of queue.splice(0)) {
          shared.redispatched.add(e);
          xhr.dispatchEvent(e);
        }
      });
    };
    for (const type of GATED) xhr.addEventListener(type, gate, true);
    const start = () => reflectApply(original, xhr, args);
    const before = shared.writesSettled();
    if (!before) return start();
    // Delay the send itself until pending document.cookie writes reached the rules.
    void before.then(start);
    return undefined;
  });
}
