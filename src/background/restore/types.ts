import type { ContainerId, DnrRule, HeldTab, LiveTab } from "../../core";
import type { StorageAreaLike } from "../../engine/storage/storage-area";
import type { Logger } from "../log";

export interface TabLike {
  id?: number;
  windowId: number;
  index: number;
  url?: string;
  pendingUrl?: string;
  groupId?: number;
  status?: string;
  discarded?: boolean;
  title?: string;
}

/** The parts of `chrome.*` the restore manager uses. */
export interface RestoreBrowser {
  tabs: {
    query(q: object): Promise<TabLike[]>;
    get(id: number): Promise<TabLike>;
    reload(id: number): Promise<void>;
    update(id: number, props: { url: string }): Promise<unknown>;
  };
  tabGroups: {
    query(q: object): Promise<Array<{ id: number; title?: string }>>;
  };
  sessions: {
    getRecentlyClosed(filter?: { maxResults?: number }): Promise<unknown[]>;
  };
  webNavigation: {
    getFrame(d: {
      tabId: number;
      frameId: number;
    }): Promise<{ errorOccurred?: boolean; url?: string } | null | undefined>;
  };
  declarativeNetRequest: {
    getDynamicRules(): Promise<Array<{ id: number }>>;
    updateDynamicRules(o: {
      removeRuleIds?: number[];
      addRules?: DnrRule[];
    }): Promise<void>;
  };
}

export interface RestoreDeps {
  b: RestoreBrowser;
  local: StorageAreaLike;
  session: StorageAreaLike;
  log: Logger;
  /** Every tab in a container right now. */
  containerTabs(): Array<[number, ContainerId]>;
  hasContainer(id: ContainerId): boolean;
  isContainerTab(tabId: number): boolean;
  /** `Facet.assign`: puts the tab in the container (it calls `clearSync` itself); throws when the rules fail. */
  assign(tabId: number, containerId: ContainerId): Promise<void>;
  /** Recompiles this module's session rules (`RESTORE_KEY`); resolves once they are installed. */
  invalidate(): Promise<boolean>;
  prepareNavigation(url: string | undefined): Promise<void>;
  /** The extension page a waiting tab shows, without its query (`held.html`). */
  heldPage: string;
  /** The set of waiting tabs changed (`tabIds`: those added or removed): badges follow. */
  heldChanged(tabIds: number[]): void;
  /** Tabs that were being matched or held may be decided now (no event of its own): the content scripts re-check. */
  waitingChanged?(): void;
}

/** A tab waiting for the user's choice, and since when. */
export interface HeldEntry extends HeldTab {
  at: number;
}

export interface RestoreStatus {
  enabled: boolean;
  /** Tabs SplitSession could not match with certainty: they wait (their address is not loaded) until the user decides. */
  held: Array<{
    tabId: number;
    url: string;
    title: string;
    candidates: ContainerId[];
  }>;
  /** How many of them "Restore container tabs" puts back in one click. */
  oneClick: number;
}

export const urlOf = (t: TabLike): string => t.url || t.pendingUrl || "";

export const toLive = (t: TabLike): LiveTab => ({
  id: t.id!,
  windowId: t.windowId,
  index: t.index,
  url: urlOf(t),
  groupId: t.groupId ?? -1,
});
