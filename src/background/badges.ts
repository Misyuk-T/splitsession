import { badgeText, CONTAINER_HEX, readableTextColor, type Container, type ContainerId } from '../core';

export interface ActionApi {
  setBadgeText(details: { tabId?: number; text: string }): Promise<void>;
  setBadgeBackgroundColor(details: { tabId?: number; color: string }): Promise<void>;
  setBadgeTextColor?(details: { tabId?: number; color: string }): Promise<void>;
  setTitle?(details: { tabId?: number; title: string }): Promise<void>;
}

/** The badge colour while the agent bridge is on (the popup's amber). */
export const BRIDGE_ON_COLOR = '#f59e0b';

/**
 * Per-tab toolbar badge: the container's initials on its colour; cleared for plain tabs. Chrome resets tab-specific
 * action state on navigation, so the background re-applies it after each commit.
 *
 * While the agent bridge is on, every tab says so in amber: plain tabs show "ON", container tabs keep their initials
 * (which account) on amber instead of the container colour (the colour is still on the tab group and in the popup).
 */
export class BadgeIndicator {
  constructor(
    private readonly action: ActionApi,
    private readonly lookup: {
      containerOf(tabId: number): ContainerId | null;
      container(id: ContainerId): Container | undefined;
      /** The agent bridge switch. */
      bridgeOn?(): boolean;
    },
  ) {}

  /** The default for tabs without their own badge, and the button's tooltip. */
  async applyGlobal(): Promise<void> {
    const on = this.lookup.bridgeOn?.() ?? false;
    try {
      await this.action.setBadgeText({ text: on ? 'ON' : '' });
      if (on) {
        await this.action.setBadgeBackgroundColor({ color: BRIDGE_ON_COLOR });
        await this.action.setBadgeTextColor?.({ color: readableTextColor(BRIDGE_ON_COLOR) });
      }
      await this.action.setTitle?.({ title: on ? 'Facet — agent bridge ON: an agent has full access to your tabs' : 'Facet' });
    } catch {
      /* the action API is unavailable (tests) */
    }
  }

  /** Sets or clears the badge of one tab. Never throws (the tab may be gone). */
  async apply(tabId: number): Promise<void> {
    if (tabId < 0) return;
    const id = this.lookup.containerOf(tabId);
    const container = id === null ? undefined : this.lookup.container(id);
    const on = this.lookup.bridgeOn?.() ?? false;
    try {
      if (!container) {
        await this.action.setBadgeText({ tabId, text: on ? 'ON' : '' });
        if (on) {
          await this.action.setBadgeBackgroundColor({ tabId, color: BRIDGE_ON_COLOR });
          await this.action.setBadgeTextColor?.({ tabId, color: readableTextColor(BRIDGE_ON_COLOR) });
        }
        return;
      }
      const color = on ? BRIDGE_ON_COLOR : CONTAINER_HEX[container.color];
      await this.action.setBadgeText({ tabId, text: badgeText(container.name) });
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
