import { browser } from "wxt/browser";

import {
  type ContainerId,
  type DomainRule,
  type ExportFile,
  isHttpUrl,
  ruleKeyOf,
  type Settings,
} from "../core";
import { ContainerError } from "../engine/storage/container-store";
import type { FacetApi } from "./api";
import type { Extras } from "./extras";
import type { Facet } from "./facet";
import { exportData, importData, type ImportSummary } from "./transfer-apply";

/** The Stage C part of the API: settings, domain rules, export/import and the helpers of the choose page and popup. */
export interface ExtrasApi {
  getSettings(): Promise<Settings>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  listDomainRules(): Promise<DomainRule[]>;
  /** Insert or replace the rule for the rule's registrable domain. */
  setDomainRule(rule: DomainRule): Promise<DomainRule>;
  removeDomainRule(domain: string): Promise<boolean>;
  exportData(options?: { includeJars?: boolean }): Promise<ExportFile>;
  importData(file: unknown): Promise<ImportSummary>;
  /** Puts every container tab into its tab group again (the "Re-group" action). */
  regroupTabs(): Promise<void>;
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

  return {
    assignTab: async (tabId, containerId, options) => {
      // A tab waiting for its restore decision shows SplitSession's own page: "reload" sends it to the address it stands for.
      const heldAddress = facet.restore.heldAddress(tabId);
      await place(tabId, containerId);
      if (options?.reload) {
        // "Reopen in": the reload is SplitSession's navigation, so no service worker of the page's origin may answer it.
        if (containerId !== null)
          await facet.prepareNavigation(
            heldAddress ??
              (await b.tabs.get(tabId).catch(() => undefined))?.url,
          );
        if (heldAddress !== undefined)
          await b.tabs.update(tabId, { url: heldAddress });
        else await b.tabs.reload(tabId);
      }
    },

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
      exportData(facet, extras.rules, options?.includeJars === true)
    ),
    importData: async (file) => (
      await ready(),
      importData(facet, extras.rules, file)
    ),

    regroupTabs: async () => (await ready(), extras.groups.reconcileAll()),

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
