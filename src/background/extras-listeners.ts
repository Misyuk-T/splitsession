import { browser } from "wxt/browser";

import type { Extras } from "./extras";
import { on } from "./on-event";

/** Top-level, synchronous registration (like `registerListeners`), so each of these events wakes a stopped worker. */
export function registerExtrasListeners(
  extras: Extras,
  b: typeof browser = browser,
): void {
  const nav = b.webNavigation;
  on(nav.onBeforeNavigate, (d) => void extras.handleBeforeNavigate(d));
  on(nav.onCreatedNavigationTarget, (d) =>
    extras.handleCreatedNavigationTarget(d),
  );
  on(nav.onCommitted, (d) => {
    if (d.frameId === 0) extras.handleTabRefresh(d.tabId);
  });
  on(b.tabs.onCreated, (tab) => extras.handleTabCreated(tab));
  on(b.tabs.onUpdated, (tabId, change) => {
    if (change.status === "loading" || change.url !== undefined)
      extras.handleTabRefresh(tabId);
    if (change.groupId !== undefined)
      extras.handleGroupChanged(tabId, change.groupId);
  });
  on(b.tabs.onActivated, (info) => extras.handleTabRefresh(info.tabId));
  on(b.tabs.onAttached, (tabId) => {
    extras.handleTabAttached(tabId);
    extras.handleGroupsChanged(); // dropped into a group of this window: no group change is reported for it
  });
  on(b.tabs.onRemoved, (tabId) => extras.handleTabRemoved(tabId));
  on(
    b.tabGroups.onRemoved,
    (group) =>
      void extras.ready?.then(() => extras.groups.groupRemoved(group.id)),
  );
  on(b.tabGroups.onCreated, () => extras.handleGroupsChanged());
  on(b.tabGroups.onUpdated, (group) => {
    extras.handleGroupsChanged();
    extras.handleGroupEdited(group);
  });
  on(b.alarms.onAlarm, (alarm) => extras.handleAlarm(alarm.name));
}
