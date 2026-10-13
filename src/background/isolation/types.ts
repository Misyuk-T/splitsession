import type { browser } from "wxt/browser";

import type { ContainerStore } from "../../engine/storage/container-store";
import type { TabRegistry } from "../../engine/storage/tab-registry";
import type { Logger } from "../log";

/** The `webRequest` event details the engine reads. */
export type WebRequestDetails = {
  requestHeaders?: Array<{ name: string; value?: string }>;
  /** Origin that started the request; absent for browser-initiated navigations (address bar, tabs.update, CDP). */
  initiator?: string;
  requestId: string;
  url: string;
  method: string;
  tabId: number;
  type: string;
  frameId: number;
  timeStamp: number;
  statusCode?: number;
  /** onErrorOccurred only. */
  error?: string;
  responseHeaders?: Array<{
    name: string;
    value?: string;
    binaryValue?: ArrayLike<number>;
  }>;
};

/** `webNavigation.onBeforeNavigate` details. */
export interface NavigationDetails {
  tabId: number;
  frameId: number;
  url: string;
  timeStamp?: number;
}

/** What every isolation module may read: the engine's state and its readiness. */
export interface EngineCore {
  b: typeof browser;
  /** Resolves once the engine has rehydrated (read at call time: `start` sets it). */
  ready(): Promise<void>;
  tabs: TabRegistry;
  containers: ContainerStore;
  log: Logger;
  /** Removes the origin's service workers before SplitSession navigates a container tab there (`Facet.prepareNavigation`). */
  prepareNavigation(url: string | undefined): Promise<void>;
}
