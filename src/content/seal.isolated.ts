import { ADOPT_EVENT, ADOPT_SWEEP } from './bridge-protocol';

/**
 * Runs in the ISOLATED world as part of the beacon, at document_start, before the MAIN-world shim.
 *
 * Chrome does not inject MAIN-world content scripts into a document whose scripts are disabled
 * (`<iframe sandbox="allow-same-origin">` without `allow-scripts`, a `sandbox` CSP without it), but every same-origin
 * page can still use that document's realm: `frames[n].document.cookie`, its `localStorage`, its
 * `ServiceWorkerContainer.prototype.register`... Unpatched, those are the real profile's. Patching that realm from a
 * same-origin realm that does have the shim works whatever the frame's sandbox flags. Chrome runs every ISOLATED script
 * before the MAIN ones (measured, Chromium 156), so this code cannot see whether the shim will run. Hence:
 *  1. At once, before any script can touch the new realm: if the parent is same-origin, ask the parent's shim to patch
 *     this realm now (`facet:adopt` with this frame's index, mode and key; the parent only accepts when its own mode
 *     and key are the same, i.e. its view is the one this frame would have). A frame whose shim does run then finds
 *     its realm patched and keeps the parent's bridge, which lives as long as the frame does.
 *  2. On the next task: if the bridge is still in the document, the frame's own shim did not run. Remove it and ask
 *     every same-origin window of the frame tree and of the opener's tree to sweep (a cousin of a cross-origin parent,
 *     a top-level document opened by a same-origin page). Until then such a realm is reachable unpatched: the measured
 *     residual window, see docs/limits.md.
 *
 * Nothing in an opaque origin (`sandbox` without `allow-same-origin`) needs this: no other realm can reach its
 * document, and its storage and cookies are inaccessible.
 */
const MAX_WINDOWS = 300;

export function sealFrame(bridge: Element, mode: string, key: string): void {
  if (self.origin === 'null') return;
  askParent(mode, key);
  let done = false;
  const check = () => {
    if (done) return;
    done = true;
    if (!bridge.isConnected) return; // the shim took it
    bridge.remove();
    requestSweep();
  };
  try {
    const channel = new MessageChannel();
    channel.port1.onmessage = check;
    channel.port2.postMessage(0);
  } catch {
    // no MessageChannel: the timer below
  }
  setTimeout(check, 0);
}

function askParent(mode: string, key: string): void {
  try {
    const parent = window.parent;
    if (!parent || parent === window) return;
    const doc = parent.document; // throws when the parent is cross-origin
    const n = parent.length;
    for (let i = 0; i < n; i++) {
      if (parent[i] === window) {
        doc.dispatchEvent(new CustomEvent(ADOPT_EVENT, { detail: `${i}|${mode}|${key}` }));
        return;
      }
    }
  } catch {
    // cross-origin parent: step 2 covers it
  }
}

function requestSweep(): void {
  const documents: Document[] = [];
  const visited = new Set<Window>();
  const visit = (win: Window | null, depth: number): void => {
    if (!win || visited.has(win) || visited.size >= MAX_WINDOWS || depth > 12) return;
    visited.add(win);
    if (win !== window) {
      try {
        const doc = win.document; // throws for cross-origin windows
        if (doc) documents.push(doc);
      } catch {
        // cross-origin: cannot use this realm either
      }
    }
    let length = 0;
    try {
      length = win.length;
    } catch {
      return;
    }
    for (let i = 0; i < length; i++) {
      try {
        visit(win[i] as Window, depth + 1);
      } catch {
        // gone meanwhile
      }
    }
  };
  visit(window.top, 0);
  try {
    if (window.opener) visit((window.opener as Window).top, 0);
  } catch {
    // severed or cross-origin opener chain
  }
  for (const doc of documents) {
    try {
      doc.dispatchEvent(new CustomEvent(ADOPT_EVENT, { detail: ADOPT_SWEEP }));
    } catch {
      // detached meanwhile
    }
  }
}
