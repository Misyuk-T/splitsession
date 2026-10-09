import { browser } from 'wxt/browser';
import type { StorageAreaLike } from '../engine/storage/storage-area';
import { AgentBridge } from './bridge/agent-bridge';
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
  bridge.setRunner(new BridgeRouter({ b: browser, facet, api, profileLabel: () => readProfileLabel(browser.storage.local as unknown as StorageAreaLike) }));
  registerListeners(facet, api);
  registerExtrasListeners(extras);
  // Alarm that restarts a bridge connection after the worker was stopped (top level, so it wakes the worker).
  browser.alarms.onAlarm.addListener((alarm) => bridge.handleAlarm(alarm.name));
  // The agent bridge follows its setting; a restart of the worker with the setting on reconnects.
  extras.settings.onChange((next, previous) => {
    if (next.agentBridge !== previous.agentBridge) void bridge.sync(next.agentBridge, next.agentBridge);
  });
  // Same API on the worker global, for e2e tests (Playwright `worker.evaluate`) and debugging from DevTools.
  (globalThis as { facet?: unknown }).facet = api;
  void extras.start(facet.start()).then(() => bridge.sync(extras.settings.get().agentBridge));
}
