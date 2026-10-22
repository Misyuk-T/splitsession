import { browser } from "wxt/browser";

import type { StorageAreaLike } from "../engine/storage/storage-area";
import { AgentActivity } from "./bridge/activity";
import { AgentBridge } from "./bridge/agent-bridge";
import { type BridgeApi, createBridgeApi } from "./bridge/bridge-api";
import { CdpSessions, type DebuggerApi } from "./bridge/cdp";
import { GroupActivityMark } from "./bridge/group-activity";
import { readProfileLabel } from "./bridge/profile-label";
import { BridgeRouter } from "./bridge/router";
import type { Extras } from "./extras";
import type { Facet } from "./facet";
import type { FullApi } from "./full-api";

/**
 * The Full edition's background half: the agent bridge (native messaging, command router), its CDP sessions and the
 * agent-activity display. Imported only from `if (__FULL__)` branches, so the Lite bundle does not contain this module or
 * anything it imports (scripts/check-lite.mjs fails the Lite build if it does).
 */
export interface AgentSide {
  bridgeApi: BridgeApi;
  /** Wires the router, CDP sessions, activity display and settings handling to the finished API. Synchronous. */
  install(api: FullApi): void;
  /** After the settings are loaded: connect the bridge if the setting is on. */
  start(): Promise<void>;
}

export function createAgentSide(
  facet: Facet,
  extras: Extras,
  b: typeof browser = browser,
): AgentSide {
  const bridge = new AgentBridge(
    b,
    b.storage.session as unknown as StorageAreaLike,
    facet.log,
  );
  return {
    bridgeApi: createBridgeApi(bridge, b),
    install(api) {
      // The activity mark of tab groups follows the activity display (its timers) and never has a clock of its own.
      const groupMark = new GroupActivityMark({
        groupOf: (tabId) =>
          b.tabs.get(tabId).then(
            (tab) => tab.groupId,
            () => null,
          ),
        isContainerGroup: async (groupId) => {
          await extras.ready; // the books (owned groups, containers, settings) are loaded
          return (await extras.groups.containerOfGroup(groupId)) !== null;
        },
        setMark: (groupId, on) => extras.groups.setActivity(groupId, on),
      });
      b.tabs.onUpdated.addListener((tabId, change) => {
        if (change.groupId !== undefined) groupMark.groupChanged(tabId);
      });
      const activity = new AgentActivity({
        b,
        enabled: () => extras.settings.get().agentActivity,
        groupMark,
        startBlink: (tabId) => extras.badges.startBlink(tabId),
        stopBlink: (tabId) => extras.badges.stopBlink(tabId),
        held: (tabId) => cdp.isHeld(tabId),
      });
      // CDP sessions of the agent bridge: attached on demand while the bridge is on (its listeners register right here).
      const cdp = new CdpSessions({
        dbg: (b as unknown as { debugger: DebuggerApi }).debugger,
        tabUrl: async (tabId) => {
          const tab = await b.tabs.get(tabId).catch(() => null);
          return tab ? tab.url || tab.pendingUrl : undefined;
        },
        log: facet.log,
      });
      const nav = navigator as Navigator & {
        userAgentData?: { platform?: string };
      };
      const isMac = /mac/i.test(
        nav.userAgentData?.platform ?? nav.platform ?? "",
      );
      const router = new BridgeRouter({
        b,
        facet,
        api,
        activity,
        cdp,
        isMac,
        profileLabel: () =>
          readProfileLabel(b.storage.local as unknown as StorageAreaLike),
      });
      bridge.setRunner(router);
      b.tabs.onRemoved.addListener((tabId) => {
        cdp.forget(tabId);
        router.forgetTab(tabId);
      });
      // Alarm that restarts a bridge connection after the worker was stopped (top level, so it wakes the worker).
      b.alarms.onAlarm.addListener((alarm) => bridge.handleAlarm(alarm.name));
      // The agent bridge follows its setting; a restart of the worker with the setting on reconnects.
      extras.settings.onChange((next, previous) => {
        // Off (the bridge or "Show agent activity"): whatever the page side shows in tabs goes now, not when its timer runs out.
        if (
          (previous.agentBridge && !next.agentBridge) ||
          (previous.agentActivity && !next.agentActivity)
        )
          void activity.stopAll();
        if (next.agentBridge === previous.agentBridge) return;
        // Off: every debugger session goes first, so nothing more can be done to a page.
        if (!next.agentBridge) void cdp.detachAll();
        void bridge.sync(next.agentBridge, next.agentBridge);
        void extras.ready?.then(() => extras.refreshAllBadges());
      });
      // The debugger sessions too (e2e checks that switching off detaches; DevTools debugging).
      (globalThis as { facetCdp?: unknown }).facetCdp = cdp;
      void cdp.detachStale();
    },
    start() {
      return bridge.sync(extras.settings.get().agentBridge);
    },
  };
}
