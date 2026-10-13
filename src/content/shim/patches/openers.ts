/* eslint-disable @typescript-eslint/no-explicit-any -- the page's windows and events are duck-typed */
import { findOwner, getOwnPropertyDescriptor, reflectApply } from "../natives";
import type { Patch } from "../patch-helpers";
import { adoptOpened } from "./child-windows";

/** The shim navigates its blank child at the latest this long after `window.open` (the background answers sooner). */
const CHILD_WAIT_MS = 800;

/** `window.open` features that ask for no opener. */
const isNoopener = (features: string) =>
  features.split(/[\s,]+/).some((f) => {
    const [name, value] = f.toLowerCase().split("=");
    return (
      (name === "noopener" || name === "noreferrer") &&
      (value === undefined ||
        value === "" ||
        value === "yes" ||
        value === "1" ||
        value === "true")
    );
  });

/**
 * `window.open` and links that open new tabs: the child tab is in the container before its first request. A child
 * that keeps its opener opens at `about:blank#facet-<nonce>` and is navigated once the background has put it into the
 * container; one without an opener is opened by the background directly.
 */
export const patchOpeners: Patch = (W, shared, h) => {
  const adopt = adoptOpened(W, shared);
  const pendingChildren = new Map<
    string,
    { win: any; url: string; timer: ReturnType<typeof setTimeout> }
  >();
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
    if (push.t === "child") go(push.nonce);
  });
  const randomNonce = () => {
    const bytes = new Uint8Array(8);
    W.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(36).padStart(2, "0"))
      .join("")
      .slice(0, 16);
  };
  const networkUrl = (raw: string): string | null => {
    try {
      const url = new URL(raw, W.document.baseURI);
      return url.protocol === "http:" || url.protocol === "https:"
        ? url.href
        : null;
    } catch {
      return null;
    }
  };
  const openTab = (url: string, active: boolean) =>
    shared.request({ op: "open-tab", url, active });

  const openOwner = findOwner(W, "open");
  const nativeOpen = openOwner
    ? getOwnPropertyDescriptor(openOwner, "open")!.value
    : null;
  if (typeof nativeOpen !== "function") return;
  const openViaBlank = (
    thisArg: any,
    url: string,
    target: string,
    features: string,
  ) => {
    const nonce = randomNonce();
    const win = reflectApply(nativeOpen, thisArg, [
      `about:blank#facet-${nonce}`,
      target,
      features,
    ]);
    if (!win) return win;
    // Chrome runs the popup's own scripts in this about:blank synchronously (measured); if it ever does not, the
    // opener's patches stand in until the popup leaves about:blank.
    adopt(win);
    pendingChildren.set(nonce, {
      win,
      url,
      timer: setTimeout(() => go(nonce), CHILD_WAIT_MS),
    });
    shared.request({ op: "await-child", nonce, url });
    return win;
  };

  h.replaceMethod(W, "open", function (original, args) {
    const url =
      args[0] === undefined || args[0] === null ? "" : String(args[0]);
    const href = url === "" ? null : networkUrl(url);
    const target = args[1] === undefined ? "_blank" : String(args[1]);
    const features = args[2] === undefined ? "" : String(args[2]);
    if (!href || /^_(self|parent|top)$/i.test(target)) {
      const win = reflectApply(original, this, args);
      adopt(win);
      return win;
    }
    if (isNoopener(features)) {
      openTab(href, true);
      return null;
    }
    return openViaBlank(
      this,
      href,
      target === "" ? "_blank" : target,
      features,
    );
  });

  const linkOf = (event: Event): HTMLAnchorElement | HTMLAreaElement | null => {
    for (const node of event.composedPath()) {
      if (
        node instanceof W.HTMLAnchorElement ||
        node instanceof W.HTMLAreaElement
      ) {
        const a = node as HTMLAnchorElement;
        return a.hasAttribute("href") ? a : null;
      }
    }
    return null;
  };
  const onActivate = (event: MouseEvent) => {
    if (event.defaultPrevented) return;
    const link = linkOf(event);
    if (!link || link.hasAttribute("download")) return;
    const href = networkUrl(link.href);
    if (!href) return;
    const modifier = event.ctrlKey || event.metaKey || event.shiftKey;
    const middle = event.type === "auxclick" && event.button === 1;
    const target = (link.getAttribute("target") ?? "").trim();
    const targetsOther = target !== "" && !/^_(self|parent|top)$/i.test(target);
    if (
      event.type === "click" &&
      (event.button !== 0 || (!modifier && !targetsOther))
    )
      return;
    if (event.type === "auxclick" && !middle) return;
    event.preventDefault();
    const rel = ` ${(link.getAttribute("rel") ?? "").toLowerCase()} `;
    const wantsOpener =
      rel.includes(" opener ") &&
      !rel.includes(" noopener ") &&
      !rel.includes(" noreferrer ");
    if (
      !modifier &&
      !middle &&
      targetsOther &&
      (wantsOpener || target.toLowerCase() !== "_blank")
    ) {
      openViaBlank(W, href, target, "");
    } else {
      // target=_blank implies noopener; modified and middle clicks open background tabs.
      openTab(href, !(middle || event.ctrlKey || event.metaKey));
    }
  };
  W.addEventListener("click", onActivate, false);
  W.addEventListener("auxclick", onActivate, false);
};
