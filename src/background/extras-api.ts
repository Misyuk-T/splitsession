import { type Browser, browser } from "wxt/browser";

import {
  cleanTabTitle,
  type ContainerId,
  type DomainRule,
  type ExportFile,
  type GroupRestoreOffer,
  type GroupRestoreResult,
  isHttpUrl,
  isSavableUrl,
  ruleKeyOf,
  type SavedTab,
  type Settings,
} from "../core";
import { ContainerError } from "../engine/storage/container-store";
import type { StorageAreaLike } from "../engine/storage/storage-area";
import type { FacetApi } from "./api";
import type { Extras } from "./extras";
import type { Facet } from "./facet";
import { GroupRestore, type RestoreTab } from "./group-restore";
import { exportData, importData, type ImportSummary } from "./transfer-apply";

/** The Stage C part of the API: settings, domain rules, export/import and the helpers of the choose page and popup. */
export interface ExtrasApi {
  getSettings(): Promise<Settings>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  listDomainRules(): Promise<DomainRule[]>;
  /** Insert or replace the rule for the rule's registrable domain. */
  setDomainRule(rule: DomainRule): Promise<DomainRule>;
  removeDomainRule(domain: string): Promise<boolean>;
  exportData(options?: {
    includeJars?: boolean;
    /** The tabs each container has open (in order) plus its saved tabs, up to 50 per container. */
    includeTabs?: boolean;
  }): Promise<ExportFile>;
  importData(file: unknown): Promise<ImportSummary>;
  /** Puts every container tab into its tab group again (the "Re-group" action). */
  regroupTabs(): Promise<void>;
  /**
   * After a reinstall (no containers, storage wiped) the tab groups SplitSession left in the browser stand for containers:
   * what the popup offers (null: nothing to offer, containers exist, or the user said no).
   */
  getGroupRestoreOffer(): Promise<GroupRestoreOffer | null>;
  /** Creates a container for every leftover SplitSession group and puts the groups' tabs in it (the groups are kept). */
  restoreFromGroups(): Promise<GroupRestoreResult>;
  /** The offer is not made again in this install. */
  dismissGroupRestoreOffer(): Promise<void>;
  /**
   * Opens the container's saved tabs in order, in the window (default: the current one), the first one active, each
   * assigned to the container before its first request, grouped as any container tab is. The saved set is cleared (the
   * tabs are open again); tabs that could not be opened stay saved.
   */
  openSavedTabs(
    containerId: ContainerId,
    options?: { windowId?: number },
  ): Promise<{ opened: number; failed: number }>;
  /** Forgets the container's saved tabs; returns how many there were. */
  forgetSavedTabs(containerId: ContainerId): Promise<number>;
  /** Diagnostics and tests: the container's saved tabs. */
  getSavedTabs(containerId: ContainerId): Promise<SavedTab[]>;
  /** Tests: looks at the tabs now and finishes the saves under way. */
  flushSavedTabs(): Promise<void>;
  /** A blank new tab in the container (type an address into the omnibox and it is already isolated). */
  newTabInContainer(containerId: ContainerId): Promise<number>;
  /**
   * The choose page's answer: optionally remember it as a domain rule, then open `url` in the container (null: no
   * container). When that changes the tab's container, `url` is opened in a FRESH tab at the same place and this one
   * is closed shortly after (`replaced: true`; no `window.opener` survives the move). Otherwise the tab is placed as
   * it is and the page navigates to `url` itself (`replaced: false`); that navigation is exempt from rules.
   */
  applyChoice(input: {
    tabId: number;
    url: string;
    containerId: ContainerId | null;
    remember: boolean;
  }): Promise<{ replaced: boolean }>;
}

export const EXTRAS_METHODS = [
  "getSettings",
  "updateSettings",
  "listDomainRules",
  "setDomainRule",
  "removeDomainRule",
  "exportData",
  "importData",
  "regroupTabs",
  "getGroupRestoreOffer",
  "restoreFromGroups",
  "dismissGroupRestoreOffer",
  "openSavedTabs",
  "forgetSavedTabs",
  "getSavedTabs",
  "flushSavedTabs",
  "newTabInContainer",
  "applyChoice",
] as const satisfies readonly (keyof ExtrasApi)[];

/**
 * Wraps the base API: `assignTab` becomes a deliberate placement (the tab's next navigation is exempt from domain
 * rules, also when the tab was in that container already), and the Stage C methods are added.
 */
export function createExtrasApi(
  facet: Facet,
  extras: Extras,
  b: typeof browser = browser,
): { assignTab: FacetApi["assignTab"] } & ExtrasApi {
  const ready = async () => {
    await facet.ready;
    await extras.ready;
  };

  const place = async (
    tabId: number,
    containerId: ContainerId | null,
  ): Promise<void> => {
    await ready();
    await facet.assignTab(tabId, containerId); // no reload here: the mark must be in place before the page restarts
    extras.exemptions.markPlacement(tabId, containerId);
  };

  const assignTab: FacetApi["assignTab"] = async (
    tabId,
    containerId,
    options,
  ) => {
    // A tab waiting for its restore decision shows SplitSession's own page: "reload" sends it to the address it stands for.
    const heldAddress = facet.restore.heldAddress(tabId);
    await place(tabId, containerId);
    if (options?.reload) {
      // "Reopen in": the reload is SplitSession's navigation, so no service worker of the page's origin may answer it.
      if (containerId !== null)
        await facet.prepareNavigation(
          heldAddress ?? (await b.tabs.get(tabId).catch(() => undefined))?.url,
        );
      if (heldAddress !== undefined)
        await b.tabs.update(tabId, { url: heldAddress });
      else await b.tabs.reload(tabId);
    }
  };

  const groupRestore = new GroupRestore({
    area: b.storage.local as unknown as StorageAreaLike,
    containerCount: () => facet.containers.list().length,
    groups: async () =>
      (await b.tabGroups.query({})).map((g) => ({
        id: g.id,
        windowId: g.windowId,
        title: g.title,
        color: g.color,
      })),
    tabsOf: async (groupId) =>
      (await b.tabs.query({ groupId })) as RestoreTab[],
    tab: (tabId) =>
      b.tabs.get(tabId).then(
        (t) => t as RestoreTab,
        () => null,
      ),
    createContainer: (input) => facet.restoreContainer(input),
    assignInPlace: (tabId, id) => facet.assignInPlace(tabId, id),
    reopen: (tabId, id, url) => extras.reopenInContainer(tabId, id, url),
    adopt: async () => {
      await extras.groups.adoptExisting();
      await extras.groups.idle();
    },
    log: facet.log,
  });

  /** The container's open tabs in the order they stand (window, position); savable addresses, the page's own titles. */
  const openTabsOf = async (
    containerId: ContainerId,
    name: string,
  ): Promise<SavedTab[]> => {
    const tabs = (
      await Promise.all(
        facet.tabs
          .tabsOf(containerId)
          .map((id) => b.tabs.get(id).catch(() => undefined)),
      )
    ).filter((t): t is Browser.tabs.Tab => t !== undefined);
    tabs.sort((x, y) => x.windowId - y.windowId || x.index - y.index);
    return tabs
      .map((t) => ({ url: t.url ?? t.pendingUrl ?? "", title: t.title }))
      .filter((t) => isSavableUrl(t.url))
      .map((t) => ({ url: t.url, title: cleanTabTitle(t.title, name) }));
  };

  return {
    assignTab,

    getSettings: async () => (await ready(), extras.settings.get()),
    updateSettings: async (patch) => {
      await ready();
      // Strict mode on: the service workers go first. If that fails the setting stays off and the caller gets the error.
      if (patch.strictMode === true) await facet.strict.turnOn();
      const next = await extras.settings.update(patch);
      await facet.applySettings(next); // already started by the change listener; this waits for it
      return next;
    },

    listDomainRules: async () => (await ready(), extras.rules.list()),
    setDomainRule: async (rule) => (await ready(), extras.rules.set(rule)),
    removeDomainRule: async (domain) => (
      await ready(),
      extras.rules.remove(String(domain))
    ),

    exportData: async (options) => (
      await ready(),
      exportData(facet, extras.rules, {
        includeJars: options?.includeJars === true,
        ...(options?.includeTabs === true
          ? { openTabs: (id, name) => openTabsOf(id, name) }
          : {}),
      })
    ),
    importData: async (file) => (
      await ready(),
      importData(facet, extras.rules, file)
    ),

    regroupTabs: async () => (await ready(), extras.groups.reconcileAll()),

    getGroupRestoreOffer: async () => (await ready(), groupRestore.offer()),
    restoreFromGroups: async () => (await ready(), groupRestore.restore()),
    dismissGroupRestoreOffer: async () => (
      await ready(),
      groupRestore.dismiss()
    ),

    openSavedTabs: async (containerId, options) => {
      await ready();
      const container = facet.containers.resolve(containerId);
      if (!container) throw new ContainerError(`no container "${containerId}"`);
      const saved = facet.savedTabs.get(container.id);
      if (saved.length === 0) return { opened: 0, failed: 0 };
      // Cleared first: a second click while the tabs open must not open them twice. What fails to open is put back.
      await facet.savedTabs.clear(container.id);
      const windowId =
        typeof options?.windowId === "number" &&
        Number.isInteger(options.windowId)
          ? options.windowId
          : undefined;
      const failed: SavedTab[] = [];
      let opened = 0;
      let lastError: unknown;
      for (const tab of saved) {
        try {
          await facet.openInContainer(tab.url, container.id, {
            active: opened === 0,
            ...(windowId !== undefined ? { windowId } : {}),
          });
          opened++;
        } catch (error) {
          lastError = error;
          failed.push(tab);
        }
      }
      if (failed.length > 0) await facet.savedTabs.set(container.id, failed);
      if (opened === 0 && lastError !== undefined)
        throw lastError instanceof Error
          ? lastError
          : new ContainerError(String(lastError));
      return { opened, failed: failed.length };
    },
    forgetSavedTabs: async (containerId) => {
      await ready();
      const container = facet.containers.resolve(containerId);
      if (!container) throw new ContainerError(`no container "${containerId}"`);
      return facet.savedTabs.clear(container.id);
    },
    getSavedTabs: async (containerId) => {
      await ready();
      const container = facet.containers.resolve(containerId);
      return container ? facet.savedTabs.get(container.id) : [];
    },
    flushSavedTabs: async () => (await ready(), extras.saved.flush()),

    newTabInContainer: async (containerId) => {
      await ready();
      const container = facet.containers.resolve(containerId);
      if (!container) throw new ContainerError(`no container "${containerId}"`);
      let tab;
      try {
        tab = await facet.trackOwnCreation(
          b.tabs.create({ url: "chrome://newtab/", active: true }),
        );
      } catch {
        tab = await facet.trackOwnCreation(
          b.tabs.create({ url: "about:blank", active: true }),
        );
      }
      if (tab.id === undefined) throw new ContainerError("tab creation failed");
      try {
        await place(tab.id, container.id);
      } catch (error) {
        await b.tabs.remove(tab.id).catch(() => {});
        throw error;
      } finally {
        facet.ownTabDone(tab.id);
      }
      return tab.id;
    },

    applyChoice: async ({ tabId, url, containerId, remember }) => {
      await ready();
      const key = isHttpUrl(String(url)) ? ruleKeyOf(String(url)) : null;
      if (key === null)
        throw new ContainerError(
          "only http(s) addresses can be opened in a container",
        );
      if (containerId !== null && !facet.containers.get(containerId))
        throw new ContainerError(`no container "${containerId}"`);
      if (remember) {
        // "Remember" with a container: always open the site there. Without one: stop asking (no rule at all).
        if (containerId !== null)
          await extras.rules.set({
            domain: key,
            action: "always",
            containerId,
          });
        else await extras.rules.remove(key);
      }
      if (facet.getTabContainer(tabId) !== containerId) {
        // The tab changes container (or leaves one): its document may have an opener that could script the new
        // identity's page. Open the address in a fresh tab instead and close this one once the reply is out.
        await facet.replaceTab(tabId, containerId, String(url), (newTabId) =>
          extras.exemptions.markSite(newTabId, containerId, key),
        );
        extras.saved.willMove(tabId);
        setTimeout(() => void b.tabs.remove(tabId).catch(() => {}), 150);
        return { replaced: true };
      }
      await place(tabId, containerId);
      // Even when the tab is already where it should be, the navigation that follows is the user's own decision.
      extras.exemptions.markSite(tabId, containerId, key);
      // The choose page navigates to `url` next: no service worker of it may answer a container's request.
      if (containerId !== null) await facet.prepareNavigation(String(url));
      return { replaced: false };
    },
  };
}
