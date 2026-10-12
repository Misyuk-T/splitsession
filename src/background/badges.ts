import { CONTAINER_HEX, readableTextColor, type Container, type ContainerId } from '../core';

export interface ActionApi {
  setBadgeText(details: { tabId?: number; text: string }): Promise<void>;
  setBadgeBackgroundColor(details: { tabId?: number; color: string }): Promise<void>;
  setBadgeTextColor?(details: { tabId?: number; color: string }): Promise<void>;
  setTitle?(details: { tabId?: number; title: string }): Promise<void>;
}

/** The badge colour while the agent bridge is on (the popup's amber). */
export const BRIDGE_ON_COLOR = '#f59e0b';
/** The badge of a tab that waits for the user to choose its container (restore): bright, on purpose. */
export const HELD_COLOR = '#ef2d2d';

/** How long a notice ("moved to …") replaces the container's colour dot on the badge. */
export const NOTICE_MS = 4_000;

/**
 * Per-tab toolbar badge: a dot in the container's colour (no letters: initials such as "12" for a container named
 * "123" read as a count); cleared for plain tabs. Chrome resets tab-specific action state on navigation, so the
 * background re-applies it after each commit.
 *
 * The dot is a badge whose text is one space: Chrome draws the rounded badge in `setBadgeBackgroundColor` and does not
 * collapse whitespace-only text (only the empty string clears it). A bullet glyph in the same colour as the badge would
 * draw the same pill, and a visible one would be a dot inside a pill, so the space is the simplest option.
 *
 * While the agent bridge is on, every tab says so: plain tabs show "ON" on amber, container tabs show "ON" on the
 * container's colour (which account is still readable from the colour).
 */
export class BadgeIndicator {
  /** Per tab: a notice shown instead of the usual badge until `until` (survives the re-application after navigation). */
  private readonly notices = new Map<number, { text: string; title: string; until: number }>();

  constructor(
    private readonly action: ActionApi,
    private readonly lookup: {
      containerOf(tabId: number): ContainerId | null;
      container(id: ContainerId): Container | undefined;
      /** The agent bridge switch. */
      bridgeOn?(): boolean;
      /** Tabs waiting for the user to choose a container after a restore. */
      isHeld?(tabId: number): boolean;
      heldCount?(): number;
    },
  ) {}

  /** The default for tabs without their own badge, and the button's tooltip. */
  async applyGlobal(): Promise<void> {
    const on = __FULL__ && (this.lookup.bridgeOn?.() ?? false);
    const held = this.lookup.heldCount?.() ?? 0;
    try {
      const color = on ? BRIDGE_ON_COLOR : held > 0 ? HELD_COLOR : null;
      await this.action.setBadgeText({ text: on ? 'ON' : held > 0 ? '!' : '' });
      if (color) {
        await this.action.setBadgeBackgroundColor({ color });
        await this.action.setBadgeTextColor?.({ color: readableTextColor(color) });
      }
      await this.action.setTitle?.({ title: this.globalTitle() });
    } catch {
      /* the action API is unavailable (tests) */
    }
  }

  /** The button's tooltip for tabs without their own. */
  private globalTitle(): string {
    const on = __FULL__ && (this.lookup.bridgeOn?.() ?? false);
    const held = this.lookup.heldCount?.() ?? 0;
    const notes = [
      ...(on ? ['agent bridge ON: an agent has full access to your tabs'] : []),
      ...(held > 0 ? [`${held === 1 ? '1 tab is' : `${held} tabs are`} waiting for you to choose a container (open SplitSession)`] : []),
    ];
    return notes.length > 0 ? `SplitSession — ${notes.join('; ')}` : 'SplitSession';
  }

  /**
   * A short message on the tab's button: an arrow on the container's colour, and "<message>" as the tooltip, for
   * `ms`; then the usual badge comes back. Used when SplitSession moved the tab into a container by itself.
   */
  async notice(tabId: number, message: string, ms = NOTICE_MS): Promise<void> {
    if (tabId < 0) return;
    this.notices.set(tabId, { text: '→', title: `SplitSession — ${message}`, until: Date.now() + ms });
    await this.apply(tabId);
    setTimeout(() => {
      const current = this.notices.get(tabId);
      if (current && current.until <= Date.now()) void this.apply(tabId); // apply() ends the notice and restores the tooltip
    }, ms + 50);
  }

  /** Sets or clears the badge of one tab. Never throws (the tab may be gone). */
  async apply(tabId: number): Promise<void> {
    if (tabId < 0) return;
    const id = this.lookup.containerOf(tabId);
    const container = id === null ? undefined : this.lookup.container(id);
    const on = __FULL__ && (this.lookup.bridgeOn?.() ?? false);
    const notice = this.notices.get(tabId);
    if (notice && notice.until <= Date.now()) this.notices.delete(tabId);
    try {
      if (notice && notice.until > Date.now() && container) {
        const color = CONTAINER_HEX[container.color];
        await this.action.setBadgeText({ tabId, text: notice.text });
        await this.action.setBadgeBackgroundColor({ tabId, color });
        await this.action.setBadgeTextColor?.({ tabId, color: readableTextColor(color) });
        await this.action.setTitle?.({ tabId, title: notice.title });
        return;
      }
      if (notice) await this.action.setTitle?.({ tabId, title: this.globalTitle() });
      if (!container && this.lookup.isHeld?.(tabId)) {
        await this.action.setBadgeText({ tabId, text: '!' });
        await this.action.setBadgeBackgroundColor({ tabId, color: HELD_COLOR });
        await this.action.setBadgeTextColor?.({ tabId, color: readableTextColor(HELD_COLOR) });
        await this.action.setTitle?.({ tabId, title: 'SplitSession — this tab is waiting for you to choose its container' });
        return;
      }
      if (!container) {
        await this.action.setBadgeText({ tabId, text: on ? 'ON' : '' });
        if (on) {
          await this.action.setBadgeBackgroundColor({ tabId, color: BRIDGE_ON_COLOR });
          await this.action.setBadgeTextColor?.({ tabId, color: readableTextColor(BRIDGE_ON_COLOR) });
        }
        return;
      }
      // A colour, not letters: initials like "12" (container "123") read as a count. The bridge's "ON" keeps the container colour.
      const color = CONTAINER_HEX[container.color];
      await this.action.setBadgeText({ tabId, text: on ? 'ON' : ' ' });
      await this.action.setBadgeBackgroundColor({ tabId, color });
      await this.action.setBadgeTextColor?.({ tabId, color: readableTextColor(color) });
    } catch {
      // the tab closed while we were setting its badge
    }
  }

  async applyMany(tabIds: Iterable<number>): Promise<void> {
    await Promise.all([...tabIds].map((id) => this.apply(id)));
  }
}
