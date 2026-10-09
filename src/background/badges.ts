import { badgeText, CONTAINER_HEX, readableTextColor, type Container, type ContainerId } from '../core';

export interface ActionApi {
  setBadgeText(details: { tabId: number; text: string }): Promise<void>;
  setBadgeBackgroundColor(details: { tabId: number; color: string }): Promise<void>;
  setBadgeTextColor?(details: { tabId: number; color: string }): Promise<void>;
}

/**
 * Per-tab toolbar badge: the container's initials on its colour; cleared for plain tabs. Chrome resets tab-specific
 * action state on navigation, so the background re-applies it after each commit.
 */
export class BadgeIndicator {
  constructor(
    private readonly action: ActionApi,
    private readonly lookup: {
      containerOf(tabId: number): ContainerId | null;
      container(id: ContainerId): Container | undefined;
    },
  ) {}

  /** Sets or clears the badge of one tab. Never throws (the tab may be gone). */
  async apply(tabId: number): Promise<void> {
    if (tabId < 0) return;
    const id = this.lookup.containerOf(tabId);
    const container = id === null ? undefined : this.lookup.container(id);
    try {
      if (!container) {
        await this.action.setBadgeText({ tabId, text: '' });
        return;
      }
      const color = CONTAINER_HEX[container.color];
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
