import { useCallback, useEffect, useState } from "preact/hooks";
import { browser } from "wxt/browser";

import type { ContainerInfo } from "../../background/facet";
import type { RestoreStatus } from "../../background/restore";
import type { GroupRestoreOffer, Settings } from "../../core";
import { facetApi } from "../../engine/api-client";
import { describeError } from "../format";

export interface TabInfo {
  id: number;
  url: string;
}

/** The tab the popup acts on: the active tab of this window (a `?tab=<id>` override exists for tests). */
async function currentTab(): Promise<TabInfo | null> {
  const override = new URLSearchParams(location.search).get("tab");
  const tab = override
    ? await browser.tabs.get(Number(override)).catch(() => undefined)
    : (await browser.tabs.query({ active: true, currentWindow: true }))[0];
  return tab?.id === undefined
    ? null
    : { id: tab.id, url: tab.url ?? tab.pendingUrl ?? "" };
}

/** What the popup shows, read from the background in one go (`refresh` reads it again). */
export function usePopupData() {
  const [containers, setContainers] = useState<ContainerInfo[] | null>(null);
  const [tab, setTab] = useState<TabInfo | null>(null);
  const [tabContainer, setTabContainer] = useState<string | null>(null);
  const [, setSettings] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [restore, setRestore] = useState<RestoreStatus | null>(null);
  const [groupOffer, setGroupOffer] = useState<GroupRestoreOffer | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [list, active, prefs, restoreStatus, offer] = await Promise.all([
        facetApi.listContainers(),
        currentTab(),
        facetApi.getSettings(),
        facetApi.getRestoreStatus(),
        facetApi.getGroupRestoreOffer(),
      ]);
      setContainers(list);
      setGroupOffer(offer);
      setRestore(restoreStatus);
      setTab(active);
      setSettings(prefs);
      setTabContainer(
        active ? await facetApi.getTabContainer(active.id) : null,
      );
      setLoadError(null);
    } catch (error) {
      setLoadError(describeError(error));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    containers,
    tab,
    tabContainer,
    restore,
    groupOffer,
    loadError,
    refresh,
  };
}
