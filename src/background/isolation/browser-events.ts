import type { Browser } from "wxt/browser";

import { ctrMarkerRef } from "../../core";
import { networkOrigin } from "../../engine/capture/headers";
import type { SessionRuleManager } from "../../engine/dnr/session-rules";
import type { ServiceWorkerPolicy } from "../../engine/sw-policy";
import type { FacetEvents } from "../events";
import type { TabRestore } from "../restore";
import type { Assignments } from "./assignments";
import type { ContainerRules } from "./container-rules";
import type { CookieCapture } from "./cookie-capture";
import type { CtrMarkers } from "./ctr-marker";
import type { OwnTabs } from "./own-tabs";
import { CHILD_NONCE, type PopupChildren } from "./popup-children";
import type { EngineCore, NavigationDetails, WebRequestDetails } from "./types";
import { siteOfFrameUrl } from "./urls";

export interface BrowserEventsDeps extends EngineCore {
  rules: SessionRuleManager;
  swPolicy: ServiceWorkerPolicy;
  restore: TabRestore;
  events: FacetEvents;
  assignments: Assignments;
  containerRules: ContainerRules;
  capture: CookieCapture;
  ctr: CtrMarkers;
  children: PopupChildren;
  own: OwnTabs;
}

/**
 * What each `webRequest`, `tabs`, `tabGroups`, `sessions` and `webNavigation` event does to the engine. `listeners.ts`
 * registers the listeners (synchronously, at the top level of the worker) and forwards here; work that needs the
 * engine's state waits for `ready`.
 */
export class BrowserEvents {
  constructor(private readonly d: BrowserEventsDeps) {}

  // ---------------------------------------------------------------- webRequest

  /**
   * `webRequest.onBeforeRequest` for frames: remembers who started each main-frame navigation (for `#ctr=`), and the
   * sites a container tab loads frames from, so their beacon answers (page keys) are installed before the frames'
   * content scripts ask.
   */
  handleBeforeRequest(details: WebRequestDetails): void {
    if (details.tabId < 0) return;
    if (details.type === "main_frame") {
      void this.d
        .ready()
        .then(() =>
          this.d.restore.mainFrameRequest(details.tabId, details.url),
        );
      this.d.ctr.noteMainFrame(details);
    }
    const site = siteOfFrameUrl(details.url);
    if (!site) return;
    void this.d.ready().then(() => {
      const rec = this.d.tabs.get(details.tabId);
      if (!rec) return;
      void this.d.containerRules.addFrameSite(
        details.tabId,
        rec.containerId,
        site,
        details.type === "main_frame",
      );
    });
  }

  handleSendHeaders(details: WebRequestDetails): void {
    this.d.capture.noteSend(details);
  }

  /** `webRequest.onCompleted` and `onErrorOccurred` (frames). */
  handleRequestDone(details: {
    requestId: string;
    tabId?: number;
    url?: string;
    type?: string;
    error?: string;
  }): void {
    this.d.capture.forgetSend(details.requestId);
    if (
      details.error !== undefined &&
      details.tabId !== undefined &&
      details.url !== undefined
    ) {
      const failed = {
        tabId: details.tabId,
        url: details.url,
        type: details.type,
        error: details.error,
      };
      void this.d.ready().then(() => this.d.restore.requestFailed(failed));
    }
    this.d.capture.runDeferred(details.requestId);
  }

  /** onHeadersReceived and onBeforeRedirect: harvest Set-Cookie of container tabs into their jar. */
  handleResponse(details: WebRequestDetails): void {
    this.d.capture.noteResponse(details);
  }

  // ---------------------------------------------------------------- tabs, groups, sessions

  /**
   * `openerTabId` is also set for tabs the user opens next to the active tab (Ctrl+T, bookmarks, omnibox Alt+Enter,
   * tabs created over CDP): those must NOT inherit. Here only the shim's own `about:blank#facet-<nonce>` child does
   * (early, before its navigation). Other page-initiated opens (links, `window.open` without the shim, context menu
   * "Open link in new tab") come through `webNavigation.onCreatedNavigationTarget`, which Chrome fires only for
   * navigations a page started.
   */
  handleTabCreated(tab: Browser.tabs.Tab): void {
    void this.d.ready().then(() => this.d.restore.tabCreated(tab));
    if (tab.id === undefined || tab.openerTabId === undefined) return;
    const url = tab.pendingUrl ?? tab.url ?? "";
    if (!CHILD_NONCE.test(url)) return;
    void this.d.children.inherit(tab.id, tab.openerTabId, url);
  }

  handleTabRemoved(
    tabId: number,
    info: { isWindowClosing?: boolean } = {},
  ): void {
    void this.d
      .ready()
      .then(() =>
        this.d.restore.tabRemoved(tabId, info.isWindowClosing === true),
      );
    this.d.own.forgetTab(tabId);
    this.d.children.forgetTab(tabId);
    this.d.capture.forgetTab(tabId);
    this.d.containerRules.forgetTab(tabId);
    this.d.ctr.forgetTab(tabId);
    void this.d.ready().then(() => this.d.assignments.unassign(tabId));
  }

  handleTabReplaced(addedTabId: number, removedTabId: number): void {
    const { tabs } = this.d;
    void this.d.ready().then(async () => {
      this.d.restore.tabReplaced(addedTabId, removedTabId);
      const rec = tabs.get(removedTabId);
      if (!rec) return;
      await tabs.delete(removedTabId);
      await tabs.set(addedTabId, rec);
      await this.d.rules.invalidate(rec.containerId);
      this.d.events.emit({
        type: "tab-replaced",
        added: addedTabId,
        removed: removedTabId,
      });
    });
  }

  handleTabAttached(tabId: number, windowId: number): void {
    void this.d.ready().then(() => {
      if (this.d.tabs.get(tabId)) void this.d.tabs.update(tabId, { windowId });
    });
  }

  /** `chrome.sessions.onChanged`: a tab or window was closed or reopened. */
  handleSessionsChanged(): void {
    void this.d.ready().then(() => this.d.restore.sessionsChanged());
  }

  /** Tabs moved, grouped, regrouped, pinned or navigated: the restore snapshot follows. */
  handleLayoutChanged(): void {
    void this.d.ready().then(() => this.d.restore.scheduleSnapshot());
  }

  handleGroupRemoved(groupId: number): void {
    void this.d.ready().then(() => this.d.restore.groupRemoved(groupId));
  }

  // ---------------------------------------------------------------- webNavigation

  handleCreatedNavigationTarget(details: {
    sourceTabId: number;
    tabId: number;
    url: string;
  }): void {
    void this.d.children.inherit(
      details.tabId,
      details.sourceTabId,
      details.url,
    );
  }

  handleBeforeNavigate(details: NavigationDetails): void {
    if (details.tabId < 0) return;
    void this.d.ready().then(async () => {
      if (details.frameId === 0 && ctrMarkerRef(details.url) !== null) {
        const containerId = await this.d.ctr.decision(details);
        if (containerId !== null) {
          await this.d.ctr.apply(details.tabId, details.url, containerId);
          return;
        }
      }
      if (!this.d.tabs.get(details.tabId)) return;
      this.noteContainerOrigin(details.url);
    });
  }

  handleCommitted(details: {
    tabId: number;
    frameId: number;
    url: string;
  }): void {
    if (details.tabId < 0) return;
    if (details.frameId === 0 && details.url === "about:blank")
      this.d.own.blankCommittedIn(details.tabId);
    void this.d.ready().then(async () => {
      const rec = this.d.tabs.get(details.tabId);
      if (details.frameId === 0)
        this.d.restore.tabCommitted(
          details.tabId,
          details.url,
          rec?.containerId,
        );
      if (!rec) return;
      this.d.children.committed(details.tabId, details.url, rec);
      this.noteContainerOrigin(details.url);
      if (details.frameId !== 0) return;
      await this.d.containerRules.topLevelCommitted(
        details.tabId,
        rec,
        details.url,
      );
    });
  }

  /** A container tab's frame is on this origin: the service-worker policy manages the origin from now on. */
  private noteContainerOrigin(url: string): void {
    const origin = networkOrigin(url);
    if (origin) void this.d.swPolicy.noteContainerOrigin(origin);
  }
}
