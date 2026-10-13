/* eslint-disable @typescript-eslint/no-explicit-any -- windows of other realms are duck-typed */
import { ADOPT_EVENT, ADOPT_SWEEP } from "../../bridge-protocol";
import {
  getOwnPropertyDescriptor,
  nativeAddListener,
  reflectApply,
} from "../natives";
import type { Patch } from "../patch-helpers";
import type { Shared } from "../types";

/** Patches a window this realm reached (a frame, its opener, a message source) unless it is the realm itself. */
const adopter =
  (W: any, shared: Shared) =>
  (win: any): void => {
    if (win && win !== W) shared.frames.reach(win);
  };

/** What a realm's `window.open` does with the window it returns: remembered as a popup of this Shared, and adopted. */
export const adoptOpened = (W: any, shared: Shared) => {
  const adopt = adopter(W, shared);
  return (win: any): void => {
    shared.frames.addOpened(win);
    adopt(win);
  };
};

/** Same-origin child windows get the same patches before the page uses them (see `FrameGuard`). */
export const patchChildWindows: Patch = (W, shared, h) => {
  const frames = shared.frames;
  const adopt = adopter(W, shared);
  const sweep = () => frames.sweep();

  // Element accessors that hand out a child window or document.
  for (const Ctor of [
    W.HTMLIFrameElement,
    W.HTMLFrameElement,
    W.HTMLObjectElement,
    W.HTMLEmbedElement,
  ]) {
    const proto = Ctor?.prototype;
    if (!proto) continue;
    h.replaceAccessor(proto, "contentWindow", {
      get(original) {
        const win = reflectApply(original, this, []);
        adopt(win);
        return win;
      },
    });
    h.replaceAccessor(proto, "contentDocument", {
      get(original) {
        const doc = reflectApply(original, this, []);
        if (doc) adopt(doc.defaultView);
        return doc;
      },
    });
    h.replaceMethod(proto, "getSVGDocument", function (original, args) {
      const doc = reflectApply(original, this, args);
      if (doc) adopt(doc.defaultView);
      return doc;
    });
  }
  h.replaceAccessor(W.Document?.prototype, "defaultView", {
    get(original) {
      const win = reflectApply(original, this, []);
      adopt(win);
      return win;
    },
  });
  for (const [Ctor, key] of [
    [W.MessageEvent, "source"],
    [W.UIEvent, "view"],
  ] as const) {
    h.replaceAccessor(Ctor?.prototype, key, {
      get(original) {
        const value = reflectApply(original, this, []);
        adopt(value);
        return value;
      },
    });
  }

  // Window getters that lead to child windows (`frames[0]`, `self[0]`): sweep first. Indexed access on `window`
  // itself (`window[0]`) cannot be intercepted; the insertion hooks and the observer below have patched it by then.
  for (const key of ["frames", "self", "length"]) {
    h.replaceAccessor(W, key, {
      get(original) {
        sweep();
        return reflectApply(original, this, []);
      },
    });
  }
  h.replaceAccessor(W, "opener", {
    get(original) {
      const win = reflectApply(original, this, []);
      adopt(win);
      return win;
    },
  });

  // DOM insertion by script creates a frame's window synchronously: sweep right after every insertion method.
  const afterInsert = (proto: any, keys: string[]) => {
    if (!proto) return;
    for (const key of keys) {
      if (!getOwnPropertyDescriptor(proto, key)) continue; // never wrap an inherited method twice
      h.replaceMethod(proto, key, function (original, args) {
        try {
          return reflectApply(original, this, args);
        } finally {
          sweep();
        }
      });
    }
  };
  const afterSet = (proto: any, keys: string[]) => {
    if (!proto) return;
    for (const key of keys) {
      if (!getOwnPropertyDescriptor(proto, key)) continue;
      h.replaceAccessor(proto, key, {
        set(original, value) {
          try {
            reflectApply(original, this, [value]);
          } finally {
            sweep();
          }
        },
      });
    }
  };
  const childNode = ["before", "after", "replaceWith"];
  const parentNode = ["append", "prepend", "replaceChildren"];
  afterInsert(W.Node?.prototype, [
    "appendChild",
    "insertBefore",
    "replaceChild",
  ]);
  afterInsert(W.Element?.prototype, [
    ...childNode,
    ...parentNode,
    "insertAdjacentElement",
    "insertAdjacentHTML",
    "setHTMLUnsafe",
    "setHTML",
    "moveBefore",
  ]);
  afterInsert(W.CharacterData?.prototype, childNode);
  afterInsert(W.DocumentType?.prototype, childNode);
  afterInsert(W.Document?.prototype, [
    ...parentNode,
    "write",
    "writeln",
    "close",
    "execCommand",
    "moveBefore",
  ]);
  afterInsert(W.DocumentFragment?.prototype, [...parentNode, "moveBefore"]); // ShadowRoot inherits these
  afterInsert(W.ShadowRoot?.prototype, ["setHTMLUnsafe", "setHTML"]);
  afterInsert(W.Range?.prototype, ["insertNode", "surroundContents"]);
  afterSet(W.Element?.prototype, ["innerHTML", "outerHTML"]);
  afterSet(W.ShadowRoot?.prototype, ["innerHTML"]);
  afterSet(W.Document?.prototype, ["body"]);

  // Requests from beacons of frames whose shim may not run (src/content/seal.isolated.ts).
  reflectApply(nativeAddListener, W, [
    ADOPT_EVENT,
    (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail === ADOPT_SWEEP) return frames.sweepTree(W);
      if (typeof detail !== "string") return;
      const [index, mode, key] = detail.split("|");
      if (mode !== shared.mode || key !== shared.key) return; // its own view would differ: its own shim decides
      const i = Number(index);
      if (!Number.isInteger(i) || i < 0) return;
      let child: any = null;
      try {
        child = W[i];
      } catch {
        return;
      }
      if (child && child !== W) frames.adopt(child);
    },
    true,
  ]);

  // Container mode routes `window.open` itself (patches/openers.ts).
  if (shared.mode !== "container") {
    const opened = adoptOpened(W, shared);
    h.replaceMethod(W, "open", function (original, args) {
      const win = reflectApply(original, this, args);
      opened(win);
      return win;
    });
  }
};
