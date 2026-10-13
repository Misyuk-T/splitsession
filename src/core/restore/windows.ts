import { gateKey } from "./gate";

function fnv1a(text: string, seed: number): string {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Signature of a window: its http(s) tabs' URLs in tab-strip order (other tabs, such as a new-tab page, are ignored). */
export function windowSignature(urls: readonly string[]): string {
  const text = urls.join("\n");
  return `${urls.length}:${fnv1a(text, 0x811c9dc5)}${fnv1a(text, 0x5bd1e995)}`;
}

export interface LiveTab {
  id: number;
  windowId: number;
  index: number;
  /** `url`, or `pendingUrl` while the first navigation has not committed. */
  url: string;
  groupId: number;
}

export interface WindowLayout {
  sig: string;
  /** How many http(s) tabs the window has. */
  count: number;
  /** Position of each http(s) tab among the window's http(s) tabs. */
  pos: Map<number, number>;
}

export function layoutWindows(
  tabs: readonly LiveTab[],
): Map<number, WindowLayout> {
  const byWindow = new Map<number, LiveTab[]>();
  for (const tab of tabs) {
    if (!gateKey(tab.url)) continue;
    const list = byWindow.get(tab.windowId);
    if (list) list.push(tab);
    else byWindow.set(tab.windowId, [tab]);
  }
  const out = new Map<number, WindowLayout>();
  for (const [windowId, list] of byWindow) {
    list.sort((a, b) => a.index - b.index);
    out.set(windowId, {
      sig: windowSignature(list.map((t) => t.url)),
      count: list.length,
      pos: new Map(list.map((t, i) => [t.id, i])),
    });
  }
  return out;
}
