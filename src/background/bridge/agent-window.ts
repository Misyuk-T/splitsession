import type { browser } from "wxt/browser";

import type { StorageAreaLike } from "../../engine/storage/storage-area";

type Browser = typeof browser;

/** `storage.session` key holding the ID of the agents' window (it survives the worker stopping, not a browser restart). */
export const AGENT_WINDOW_KEY = "agentWindowId";

export interface AgentWindowDeps {
  b: Browser;
  /** `storage.session`. */
  area: StorageAreaLike;
  /** The "Open agent tabs in a separate window" setting, read at every open. */
  enabled: () => boolean;
}

/**
 * The agents' window: tabs an agent opens itself (open_tab, open_in_container) go into one ordinary window of this Chrome
 * profile instead of the one the user is working in. Chrome has no window title API, so the window is told apart by its ID,
 * kept in `storage.session`. It is created on the first open, without taking focus, and reused while it exists; when the
 * user closes it, the next open makes a new one. An explicit `windowId` from the agent always wins, and with the setting
 * off nothing changes: tabs open in the current window.
 */
export class AgentWindow {
  private creating: Promise<number | undefined> | null = null;
  /** The blank tab a new window starts with; closed once the first real tab is in the window. */
  private placeholder: number | null = null;

  constructor(private readonly d: AgentWindowDeps) {}

  /**
   * The window to open an agent's tab in: the agent's own choice if it gave one, else the agents' window (made on demand),
   * else `undefined` (the setting is off, or no window could be made: Chrome then uses the current window).
   */
  async resolve(explicit?: number): Promise<number | undefined> {
    if (explicit !== undefined || !this.d.enabled()) return explicit;
    if (this.creating) return this.creating;
    const found = await this.existing();
    if (found !== null) return found;
    // Two tabs opened at once must not make two windows.
    this.creating ??= this.create().finally(() => {
      this.creating = null;
    });
    return this.creating;
  }

  /** The tab the caller asked for is in `windowId`: if that is the agents' window, its blank first tab can go. */
  async opened(windowId: number | undefined): Promise<void> {
    const blank = this.placeholder;
    if (blank === null || windowId === undefined) return;
    if ((await this.stored()) !== windowId) return;
    const tabs = await this.d.b.tabs.query({ windowId }).catch(() => []);
    if (!tabs.some((t) => t.id === blank))
      this.placeholder = null; // already gone
    else if (tabs.length > 1) {
      this.placeholder = null;
      await this.d.b.tabs.remove(blank).catch(() => {});
    } // else: it is the window's only tab, so closing it would close the window; wait for the real tab
  }

  private async stored(): Promise<number | null> {
    try {
      const id = (await this.d.area.get(AGENT_WINDOW_KEY))[AGENT_WINDOW_KEY];
      return typeof id === "number" ? id : null;
    } catch {
      return null;
    }
  }

  /** The stored window, if it is still there. */
  private async existing(): Promise<number | null> {
    const id = await this.stored();
    if (id === null) return null;
    const win = await this.d.b.windows.get(id).catch(() => null);
    return win && (win.type === undefined || win.type === "normal") ? id : null;
  }

  private async create(): Promise<number | undefined> {
    try {
      const win = await this.d.b.windows.create({
        url: "about:blank",
        type: "normal",
        state: "normal",
        focused: false,
      });
      if (win?.id === undefined) return undefined;
      this.placeholder = win.tabs?.[0]?.id ?? null;
      await this.d.area.set({ [AGENT_WINDOW_KEY]: win.id }).catch(() => {});
      return win.id;
    } catch {
      return undefined; // no window could be made: the tab opens where the user is, as with the setting off
    }
  }
}
