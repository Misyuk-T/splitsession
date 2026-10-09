import { browser } from 'wxt/browser';
import { ruleKeyOf, type ContainerId, type DomainRule, type ExportFile, type Settings } from '../core';
import { ContainerError } from '../engine/storage/container-store';
import type { FacetApi } from './api';
import type { Extras } from './extras';
import type { Facet } from './facet';
import { exportData, importData, type ImportSummary } from './transfer-apply';

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
   * The choose page's answer: optionally remember it as a domain rule, then put the tab in the container (null: take
   * it out). The page navigates to `url` afterwards; that navigation is exempt from rules.
   */
  applyChoice(input: { tabId: number; url: string; containerId: ContainerId | null; remember: boolean }): Promise<void>;
}

export const EXTRAS_METHODS = [
  'getSettings',
  'updateSettings',
  'listDomainRules',
  'setDomainRule',
  'removeDomainRule',
  'exportData',
  'importData',
  'regroupTabs',
  'newTabInContainer',
  'applyChoice',
] as const satisfies readonly (keyof ExtrasApi)[];

/**
 * Wraps the base API: `assignTab` becomes a deliberate placement (the tab's next navigation is exempt from domain
 * rules, also when the tab was in that container already), and the Stage C methods are added.
 */
export function createExtrasApi(facet: Facet, extras: Extras, b: typeof browser = browser): { assignTab: FacetApi['assignTab'] } & ExtrasApi {
  const ready = async () => {
    await facet.ready;
    await extras.ready;
  };

  const place = async (tabId: number, containerId: ContainerId | null): Promise<void> => {
    await ready();
    await facet.assignTab(tabId, containerId); // no reload here: the mark must be in place before the page restarts
    extras.exemptions.markPlacement(tabId, containerId);
  };

  return {
    assignTab: async (tabId, containerId, options) => {
      await place(tabId, containerId);
      if (options?.reload) await b.tabs.reload(tabId);
    },

    getSettings: async () => (await ready(), extras.settings.get()),
    updateSettings: async (patch) => (await ready(), extras.settings.update(patch)),

    listDomainRules: async () => (await ready(), extras.rules.list()),
    setDomainRule: async (rule) => (await ready(), extras.rules.set(rule)),
    removeDomainRule: async (domain) => (await ready(), extras.rules.remove(String(domain))),

    exportData: async (options) => (await ready(), exportData(facet, extras.rules, options?.includeJars === true)),
    importData: async (file) => (await ready(), importData(facet, extras.rules, file)),

    regroupTabs: async () => (await ready(), extras.groups.reconcileAll()),

    newTabInContainer: async (containerId) => {
      await ready();
      const container = facet.containers.resolve(containerId);
      if (!container) throw new ContainerError(`no container "${containerId}"`);
      let tab;
      try {
        tab = await b.tabs.create({ url: 'chrome://newtab/', active: true });
      } catch {
        tab = await b.tabs.create({ url: 'about:blank', active: true });
      }
      if (tab.id === undefined) throw new ContainerError('tab creation failed');
      try {
        await place(tab.id, container.id);
      } catch (error) {
        await b.tabs.remove(tab.id).catch(() => {});
        throw error;
      }
      return tab.id;
    },

    applyChoice: async ({ tabId, url, containerId, remember }) => {
      await ready();
      const key = /^https?:\/\//i.test(String(url)) ? ruleKeyOf(String(url)) : null;
      if (key === null) throw new ContainerError('only http(s) addresses can be opened in a container');
      if (containerId !== null && !facet.containers.get(containerId)) throw new ContainerError(`no container "${containerId}"`);
      if (remember) {
        // "Remember" with a container: always open the site there. Without one: stop asking (no rule at all).
        if (containerId !== null) await extras.rules.set({ domain: key, action: 'always', containerId });
        else await extras.rules.remove(key);
      }
      await place(tabId, containerId);
      // Even when the tab is already where it should be, the navigation that follows is the user's own decision.
      extras.exemptions.markSite(tabId, containerId, key);
    },
  };
}
