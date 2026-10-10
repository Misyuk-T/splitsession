import { browser } from 'wxt/browser';
import type { StorageAreaLike } from '../engine/storage/storage-area';
import { AgentActivity } from './bridge/activity';
import { AgentBridge } from './bridge/agent-bridge';
import { CdpSessions, type DebuggerApi } from './bridge/cdp';
import { readProfileLabel } from './bridge/profile-label';
import { BridgeRouter } from './bridge/router';
import { Extras } from './extras';
import { registerExtrasListeners } from './extras-listeners';
import { Facet } from './facet';
import { createFullApi } from './full-api';
import { registerListeners } from './listeners';

/** Service-worker entry (wrapped by src/entrypoints/background.ts). Must stay synchronous up to listener registration. */
export function main(): void {
  const facet = new Facet();
  const extras = new Extras(facet);
  const bridge = new AgentBridge(browser, browser.storage.session as unknown as StorageAreaLike, facet.log);
  const api = createFullApi(facet, extras, () => browser.declarativeNetRequest.getSessionRules() as Promise<unknown[]>, browser, bridge);
  const activity = new AgentActivity({
    b: browser,
    enabled: () => extras.settings.get().agentActivity,
    restoreBadge: (tabId) => extras.badges.apply(tabId),
    held: (tabId) => cdp.isHeld(tabId),
  });
  // CDP sessions of the agent bridge: attached on demand while the bridge is on (its listeners register right here).
  const cdp = new CdpSessions({
    dbg: (browser as unknown as { debugger: DebuggerApi }).debugger,
    tabUrl: async (tabId) => {
      const tab = await browser.tabs.get(tabId).catch(() => null);
      return tab ? (tab.url || tab.pendingUrl) : undefined;
    },
    log: facet.log,
  });
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const isMac = /mac/i.test(nav.userAgentData?.platform ?? nav.platform ?? '');
  const router = new BridgeRouter({ b: browser, facet, api, activity, cdp, isMac, profileLabel: () => readProfileLabel(browser.storage.local as unknown as StorageAreaLike) });
  bridge.setRunner(router);
  browser.tabs.onRemoved.addListener((tabId) => {
    cdp.forget(tabId);
    router.forgetTab(tabId);
  });
  registerListeners(facet, api);
  registerExtrasListeners(extras);
  // Alarm that restarts a bridge connection after the worker was stopped (top level, so it wakes the worker).
  browser.alarms.onAlarm.addListener((alarm) => bridge.handleAlarm(alarm.name));
  // The agent bridge follows its setting; a restart of the worker with the setting on reconnects.
  extras.settings.onChange((next, previous) => {
    // Off (the bridge or "Show agent activity"): whatever the page side shows in tabs goes now, not when its timer runs out.
    if ((previous.agentBridge && !next.agentBridge) || (previous.agentActivity && !next.agentActivity)) void activity.stopAll();
    if (next.agentBridge === previous.agentBridge) return;
    // Off: every debugger session goes first, so nothing more can be done to a page.
    if (!next.agentBridge) void cdp.detachAll();
    void bridge.sync(next.agentBridge, next.agentBridge);
    void extras.ready?.then(() => extras.refreshAllBadges());
  });
  // Same API on the worker global, for e2e tests (Playwright `worker.evaluate`) and debugging from DevTools.
  (globalThis as { facet?: unknown }).facet = api;
  // The debugger sessions too (e2e checks that switching off detaches; DevTools debugging).
  (globalThis as { facetCdp?: unknown }).facetCdp = cdp;
  void cdp.detachStale();
  void extras.start(facet.start()).then(() => bridge.sync(extras.settings.get().agentBridge));
}
