/* eslint-disable @typescript-eslint/no-explicit-any -- windows of other realms are duck-typed */
import {
  NativeMutationObserver,
  nativeObserve,
  NativeWeakRef,
  nativeWindowLength,
  reflectApply,
} from "./natives";
import type { FrameGuard, Shared } from "./types";

/** Bounds for walking a frame tree (pages with more frames than this are not a realistic target). */
const MAX_TREE_WINDOWS = 300;
const MAX_TREE_DEPTH = 12;

const lengthOf = (win: any): number => {
  try {
    return nativeWindowLength
      ? (reflectApply(nativeWindowLength, win, []) as number)
      : win.length;
  } catch {
    try {
      return win.length;
    } catch {
      return 0;
    }
  }
};

/** `document` is [LegacyUnforgeable]: the page cannot redefine it. Null for cross-origin windows. */
const documentOf = (win: any): any => {
  try {
    return win.document ?? null;
  } catch {
    return null;
  }
};

const live = (list: Array<WeakRef<any>>) =>
  list.filter((ref) => ref.deref() !== undefined);

/** The FrameGuard of `shared` (see `FrameGuard`); `install` patches a window with `shared` (no-op when patched). */
export function createFrameGuard(
  shared: Shared,
  install: (win: any) => unknown,
): FrameGuard {
  /** Window proxies a sweep has looked at; a later navigation of one of them is covered by its seal or its shim. */
  const seen = new WeakSet<object>();
  /** Realms patched with this Shared (their window proxies). */
  let realms: Array<WeakRef<any>> = [];
  const realmSet = new WeakSet<object>();
  let opened: Array<WeakRef<any>> = [];
  const observed = new WeakSet<object>();
  let observer: MutationObserver | null = null;
  let busy = false;

  const observe = (doc: any): void => {
    if (!doc || observed.has(doc)) return;
    observed.add(doc);
    observer ??= new NativeMutationObserver(() => guard.sweep());
    try {
      reflectApply(nativeObserve, observer, [
        doc,
        { childList: true, subtree: true },
      ]);
    } catch {
      // not a node of a live document
    }
  };

  const guard: FrameGuard = {
    adopt(win) {
      if (!win) return false;
      const doc = documentOf(win);
      if (!doc) return false;
      install(win);
      // A realm of ours may have a new document (same-origin navigation reusing the window): watch that one too.
      if (realmSet.has(win)) observe(doc);
      return true;
    },
    reach(win) {
      if (!win || typeof win !== "object" || seen.has(win)) return;
      seen.add(win);
      guard.adopt(win);
    },
    sweep() {
      if (busy) return;
      busy = true;
      try {
        // Realms adopted during the loop are appended and visited too.
        for (let k = 0; k < realms.length; k++) {
          const realm = realms[k]!.deref();
          if (!realm) continue;
          const n = lengthOf(realm);
          for (let i = 0; i < n; i++) {
            let child: any;
            try {
              child = realm[i];
            } catch {
              continue;
            }
            guard.reach(child);
          }
        }
        if (realms.length > 32) realms = live(realms);
      } finally {
        busy = false;
      }
    },
    sweepTree(from) {
      if (busy) return;
      busy = true;
      try {
        const visited = new Set<any>();
        const visit = (win: any, depth: number): void => {
          if (
            !win ||
            visited.has(win) ||
            visited.size >= MAX_TREE_WINDOWS ||
            depth > MAX_TREE_DEPTH
          )
            return;
          visited.add(win);
          seen.add(win);
          guard.adopt(win);
          const n = lengthOf(win);
          for (let i = 0; i < n; i++) {
            try {
              visit(win[i], depth + 1);
            } catch {
              // removed meanwhile
            }
          }
        };
        let top: any = null;
        try {
          top = from.top;
        } catch {
          top = from;
        }
        visit(top, 0);
        opened = live(opened);
        for (const ref of opened) {
          const win = ref.deref();
          try {
            if (win && !win.closed) visit(win.top, 0);
          } catch {
            // closed meanwhile
          }
        }
      } finally {
        busy = false;
      }
    },
    addRealm(win) {
      if (realmSet.has(win)) return;
      realmSet.add(win);
      seen.add(win);
      realms.push(new NativeWeakRef(win));
      observe(documentOf(win));
    },
    addOpened(win) {
      if (win) opened.push(new NativeWeakRef(win));
    },
  };
  return guard;
}
