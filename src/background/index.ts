import { browser } from 'wxt/browser';
import { Extras } from './extras';
import { registerExtrasListeners } from './extras-listeners';
import { Facet } from './facet';
import { createAgentSide } from './full-edition';
import { createFullApi } from './full-api';
import { registerListeners } from './listeners';

/**
 * Service-worker entry (wrapped by src/entrypoints/background.ts). Must stay synchronous up to listener registration.
 * Everything behind `__FULL__` is the Full edition's agent side (src/background/full-edition.ts) and is not in Lite.
 */
export function main(): void {
  const facet = new Facet();
  const extras = new Extras(facet);
  const agent = __FULL__ ? createAgentSide(facet, extras) : null;
  const api = createFullApi(facet, extras, () => browser.declarativeNetRequest.getSessionRules() as Promise<unknown[]>, browser, agent?.bridgeApi);
  agent?.install(api);
  registerListeners(facet, api);
  registerExtrasListeners(extras);
  // Same API on the worker global, for e2e tests (Playwright `worker.evaluate`) and debugging from DevTools.
  (globalThis as { facet?: unknown }).facet = api;
  void extras.start(facet.start()).then(() => agent?.start());
}
