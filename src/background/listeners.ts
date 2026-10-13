import { browser } from "wxt/browser";

import type { ApiReply } from "../core";
import type { Facet } from "./facet";
import { dispatchFullApi, type FullApi } from "./full-api";
import { on } from "./on-event";

const ALL_URLS = { urls: ["<all_urls>"] };
const FRAMES = { urls: ["<all_urls>"], types: ["main_frame", "sub_frame"] };

/**
 * Registers every listener synchronously, at the top level of the service worker, so that each of these events
 * wakes the worker after it was stopped. Handlers do their work after `facet.ready`: tab, navigation and webRequest
 * events in `facet.browserEvents` (`isolation/browser-events.ts`), the runtime's own events in `Facet`.
 */
export function registerListeners(
  facet: Facet,
  api: FullApi,
  b: typeof browser = browser,
): void {
  const events = facet.browserEvents;
  const wr = b.webRequest;
  // Initiators of main-frame navigations (#ctr=) and frame sites of container tabs (per-site beacon answers).
  on(wr.onBeforeRequest, (d) => events.handleBeforeRequest(d), FRAMES);
  on(wr.onSendHeaders, (d) => events.handleSendHeaders(d), FRAMES, [
    "requestHeaders",
    "extraHeaders",
  ]);
  // extraHeaders: Set-Cookie is only visible with it, and it shows the header even though DNR strips it.
  on(wr.onHeadersReceived, (d) => void events.handleResponse(d), ALL_URLS, [
    "responseHeaders",
    "extraHeaders",
  ]);
  on(wr.onBeforeRedirect, (d) => void events.handleResponse(d), ALL_URLS, [
    "responseHeaders",
    "extraHeaders",
  ]);
  on(wr.onCompleted, (d) => events.handleRequestDone(d), FRAMES);
  on(wr.onErrorOccurred, (d) => events.handleRequestDone(d), FRAMES);

  on(b.tabs.onCreated, (tab) => events.handleTabCreated(tab));
  on(b.tabs.onRemoved, (tabId, info) => events.handleTabRemoved(tabId, info));
  on(b.tabs.onReplaced, (added, removed) =>
    events.handleTabReplaced(added, removed),
  );
  on(b.tabs.onAttached, (tabId, info) => {
    events.handleTabAttached(tabId, info.newWindowId);
    events.handleLayoutChanged();
  });
  // Restore snapshot: where container tabs sit (window, position, group) and what they show.
  on(b.tabs.onUpdated, (_tabId, change) => {
    if (
      change.url !== undefined ||
      change.groupId !== undefined ||
      change.pinned !== undefined
    )
      events.handleLayoutChanged();
  });
  on(b.tabs.onMoved, () => events.handleLayoutChanged());
  on(b.tabs.onDetached, () => events.handleLayoutChanged());
  on(b.tabGroups.onCreated, () => events.handleLayoutChanged());
  on(b.tabGroups.onUpdated, () => events.handleLayoutChanged());
  on(b.tabGroups.onRemoved, (group) => events.handleGroupRemoved(group.id));
  // Recently closed tabs and windows: which entry was restored just now.
  on(b.sessions.onChanged, () => events.handleSessionsChanged());

  const nav = b.webNavigation;
  on(nav.onCreatedNavigationTarget, (d) =>
    events.handleCreatedNavigationTarget(d),
  );
  on(nav.onBeforeNavigate, (d) => events.handleBeforeNavigate(d));
  on(nav.onCommitted, (d) => events.handleCommitted(d));

  on(b.alarms.onAlarm, (alarm) => void facet.handleAlarm(alarm.name));
  on(b.runtime.onSuspend, () => facet.handleSuspend());
  on(
    b.runtime.onInstalled,
    (details) => void facet.handleInstalled(details.reason),
  );
  on(b.runtime.onStartup, () => facet.handleStartup());

  const extensionOrigin = `chrome-extension://${b.runtime.id}`;
  on(b.runtime.onMessage, (message, sender, sendResponse) => {
    if (
      !message ||
      typeof message !== "object" ||
      typeof message.type !== "string"
    )
      return false;
    if (sender.id !== b.runtime.id) return false;
    const fromExtensionPage =
      sender.origin === extensionOrigin ||
      (sender.url ?? "").startsWith(`${extensionOrigin}/`);
    let work: Promise<unknown>;
    if (message.type === "facet/api") {
      if (!fromExtensionPage) return false;
      work = dispatchFullApi(api, String(message.method), message.args).then(
        (value): ApiReply => ({ ok: true, value }),
        (error): ApiReply => ({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } else if (message.type.startsWith("facet/") && !fromExtensionPage) {
      work = facet.handleContentMessage(message, sender).catch((error) => {
        facet.log("error", `${message.type} failed`, String(error));
        return { ok: false };
      });
    } else {
      return false;
    }
    void work.then(sendResponse);
    return true; // keep the channel open for the async reply
  });
}
