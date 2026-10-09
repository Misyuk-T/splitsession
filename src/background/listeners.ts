import { browser } from 'wxt/browser';
import type { ApiReply } from '../core';
import type { Facet } from './facet';
import { dispatchFullApi, type FullApi } from './full-api';

const ALL_URLS = { urls: ['<all_urls>'] };
const FRAMES = { urls: ['<all_urls>'], types: ['main_frame', 'sub_frame'] };

type AnyListener = (...args: any[]) => unknown;
type Addable = { addListener(listener: AnyListener, ...rest: any[]): void };
const on = (event: unknown, listener: AnyListener, ...rest: unknown[]) => (event as Addable).addListener(listener, ...rest);

/**
 * Registers every listener synchronously, at the top level of the service worker, so that each of these events
 * wakes the worker after it was stopped. Handlers do their work after `facet.ready`.
 */
export function registerListeners(facet: Facet, api: FullApi, b: typeof browser = browser): void {
  const wr = b.webRequest;
  on(wr.onSendHeaders, (d) => facet.handleSendHeaders(d), FRAMES, ['requestHeaders', 'extraHeaders']);
  // extraHeaders: Set-Cookie is only visible with it, and it shows the header even though DNR strips it.
  on(wr.onHeadersReceived, (d) => void facet.handleResponse(d), ALL_URLS, ['responseHeaders', 'extraHeaders']);
  on(wr.onBeforeRedirect, (d) => void facet.handleResponse(d), ALL_URLS, ['responseHeaders', 'extraHeaders']);
  on(wr.onCompleted, (d) => facet.handleRequestDone(d), FRAMES);
  on(wr.onErrorOccurred, (d) => facet.handleRequestDone(d), FRAMES);

  on(b.tabs.onCreated, (tab) => facet.handleTabCreated(tab));
  on(b.tabs.onRemoved, (tabId) => facet.handleTabRemoved(tabId));
  on(b.tabs.onReplaced, (added, removed) => facet.handleTabReplaced(added, removed));
  on(b.tabs.onAttached, (tabId, info) => facet.handleTabAttached(tabId, info.newWindowId));

  const nav = b.webNavigation;
  on(nav.onCreatedNavigationTarget, (d) => facet.handleCreatedNavigationTarget(d));
  on(nav.onBeforeNavigate, (d) => facet.handleBeforeNavigate(d));
  on(nav.onCommitted, (d) => facet.handleCommitted(d));
  on(nav.onReferenceFragmentUpdated, (d) => facet.handleFragmentUpdated(d));

  on(b.alarms.onAlarm, (alarm) => void facet.handleAlarm(alarm.name));
  on(b.runtime.onSuspend, () => facet.handleSuspend());
  on(b.runtime.onInstalled, (details) => void facet.handleInstalled(details.reason));
  on(b.runtime.onStartup, () => facet.handleStartup());

  const extensionOrigin = `chrome-extension://${b.runtime.id}`;
  on(b.runtime.onMessage, (message, sender, sendResponse) => {
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') return false;
    if (sender.id !== b.runtime.id) return false;
    const fromExtensionPage = sender.origin === extensionOrigin || (sender.url ?? '').startsWith(`${extensionOrigin}/`);
    let work: Promise<unknown>;
    if (message.type === 'facet/api') {
      if (!fromExtensionPage) return false;
      work = dispatchFullApi(api, String(message.method), message.args).then(
        (value): ApiReply => ({ ok: true, value }),
        (error): ApiReply => ({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      );
    } else if (message.type.startsWith('facet/') && !fromExtensionPage) {
      work = facet.handleContentMessage(message, sender).catch((error) => {
        facet.log('error', `${message.type} failed`, String(error));
        return { ok: false };
      });
    } else {
      return false;
    }
    void work.then(sendResponse);
    return true; // keep the channel open for the async reply
  });
}
