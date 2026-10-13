/* eslint-disable @typescript-eslint/no-explicit-any -- this file patches untyped corners of the DOM on purpose */
import type { CookieItem } from "../../bridge-protocol";
import { reflectApply, setPrototypeOf } from "../natives";
import type { Patch } from "../patch-helpers";

/** `document.cookie` and `cookieStore` come from the container jar (through the beacon). */
export const patchCookies: Patch = (W, shared, h) => {
  const opaque = W.origin === "null";
  const write = (value: string): void => {
    const id = shared.nextId();
    shared.trackWrite(id);
    shared.request({ op: "cookie-set", v: value, id });
  };
  const hasBrowsingContext = (doc: any) =>
    !opaque && doc != null && doc.defaultView != null;

  h.replaceAccessor(W.Document.prototype, "cookie", {
    get(original) {
      if (!hasBrowsingContext(this)) return reflectApply(original, this, []);
      const reply = shared.request({ op: "cookie-get" });
      return reply && typeof reply.v === "string" ? reply.v : "";
    },
    set(original, value) {
      if (!hasBrowsingContext(this))
        return void reflectApply(original, this, [value]);
      write(String(value));
    },
  });

  const CookieStore = W.CookieStore;
  if (typeof CookieStore !== "function" || !("cookieStore" in W)) return;
  const fake = new W.EventTarget();
  setPrototypeOf(fake, CookieStore.prototype);
  let onchange: any = null;
  const P = W.Promise;
  const list = (): CookieItem[] =>
    shared.request({ op: "cookie-list" })?.list ?? [];
  const nameOf = (arg: any): string | undefined =>
    typeof arg === "string"
      ? arg
      : arg && arg.name !== undefined
        ? String(arg.name)
        : undefined;
  const attrs = (o: any): string => {
    const parts = [`Path=${o.path ?? "/"}`];
    if (o.domain) parts.push(`Domain=${String(o.domain)}`);
    if (W.isSecureContext) parts.push("Secure");
    if (o.partitioned) parts.push("Partitioned");
    return parts.join("; ");
  };
  const done = () => shared.writesSettled() ?? P.resolve();

  h.replaceMethod(CookieStore.prototype, "get", function (original, args) {
    if (this !== fake) return reflectApply(original, this, args);
    const name = nameOf(args[0]);
    return P.resolve(
      list().find((c) => name === undefined || c.name === name) ?? null,
    );
  });
  h.replaceMethod(CookieStore.prototype, "getAll", function (original, args) {
    if (this !== fake) return reflectApply(original, this, args);
    const name = nameOf(args[0]);
    return P.resolve(
      list().filter((c) => name === undefined || c.name === name),
    );
  });
  h.replaceMethod(CookieStore.prototype, "set", function (original, args) {
    if (this !== fake) return reflectApply(original, this, args);
    const o =
      typeof args[0] === "string"
        ? { name: args[0], value: args[1] }
        : (args[0] ?? {});
    if (o.name === undefined && o.value === undefined)
      return P.reject(
        new W.TypeError("cookieStore.set: name or value required"),
      );
    const sameSite = String(o.sameSite ?? "strict");
    let cookie = `${o.name ?? ""}=${o.value ?? ""}; ${attrs(o)}; SameSite=${sameSite[0]!.toUpperCase()}${sameSite.slice(1)}`;
    if (o.expires !== undefined && o.expires !== null)
      cookie += `; Expires=${new Date(Number(o.expires)).toUTCString()}`;
    write(cookie);
    return done().then(() => undefined);
  });
  h.replaceMethod(CookieStore.prototype, "delete", function (original, args) {
    if (this !== fake) return reflectApply(original, this, args);
    const o = typeof args[0] === "string" ? { name: args[0] } : (args[0] ?? {});
    write(`${o.name ?? ""}=; Max-Age=0; ${attrs(o)}`);
    return done().then(() => undefined);
  });
  h.replaceAccessor(CookieStore.prototype, "onchange", {
    get(original) {
      return this === fake ? onchange : reflectApply(original, this, []);
    },
    set(original, value) {
      if (this === fake)
        onchange =
          typeof value === "function" || typeof value === "object"
            ? value
            : null;
      else reflectApply(original, this, [value]);
    },
  });
  // The real cookieStore would report the real profile's cookie changes: the page only ever sees `fake`.
  h.replaceAccessor(W, "cookieStore", {
    get() {
      return fake;
    },
  });
};
