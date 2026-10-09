import { browser } from 'wxt/browser';
import type { Extras } from './extras';

type AnyListener = (...args: any[]) => unknown;
type Addable = { addListener(listener: AnyListener, ...rest: any[]): void };
const on = (event: unknown, listener: AnyListener, ...rest: unknown[]) => (event as Addable).addListener(listener, ...rest);

/** Top-level, synchronous registration (like `registerListeners`), so each of these events wakes a stopped worker. */
export function registerExtrasListeners(extras: Extras, b: typeof browser = browser): void {
  const nav = b.webNavigation;
  on(nav.onBeforeNavigate, (d) => void extras.handleBeforeNavigate(d));
  on(nav.onCreatedNavigationTarget, (d) => extras.handleCreatedNavigationTarget(d));
  on(nav.onCommitted, (d) => {
    if (d.frameId === 0) extras.handleTabRefresh(d.tabId);
  });
  on(b.tabs.onUpdated, (tabId, change) => {
    if (change.status === 'loading' || change.url !== undefined) extras.handleTabRefresh(tabId);
  });
  on(b.tabs.onActivated, (info) => extras.handleTabRefresh(info.tabId));
  on(b.tabs.onAttached, (tabId) => extras.handleTabAttached(tabId));
  on(b.tabs.onRemoved, (tabId) => extras.handleTabRemoved(tabId));
  on(b.tabGroups.onRemoved, (group) => void extras.ready?.then(() => extras.groups.groupRemoved(group.id)));
}
