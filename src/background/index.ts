import { browser } from 'wxt/browser';
import { createApi } from './api';
import { Facet } from './facet';
import { registerListeners } from './listeners';

/** Service-worker entry (wrapped by src/entrypoints/background.ts). Must stay synchronous up to listener registration. */
export function main(): void {
  const facet = new Facet();
  const api = createApi(facet, () => browser.declarativeNetRequest.getSessionRules() as Promise<unknown[]>);
  registerListeners(facet, api);
  // Same API on the worker global, for e2e tests (Playwright `worker.evaluate`) and debugging from DevTools.
  (globalThis as { facet?: unknown }).facet = api;
  void facet.start();
}
