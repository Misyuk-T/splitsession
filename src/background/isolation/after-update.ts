import { networkOrigin } from "../../engine/capture/headers";
import type { ContentScriptLifecycle } from "../../engine/content-scripts";
import type { SessionRuleManager } from "../../engine/dnr/session-rules";
import type { FacetEvents } from "../events";
import type { EngineCore } from "./types";

export interface AfterUpdateDeps extends EngineCore {
  rules: SessionRuleManager;
  scripts: ContentScriptLifecycle;
  events: FacetEvents;
}

/**
 * Chrome wipes session rules and `storage.session` when the extension is updated or reloaded, which would turn open
 * container tabs into real-profile tabs. Puts back every tab that is still the same tab (id, window and URL match the
 * `storage.local` backup), then reloads it so it gets fresh content scripts.
 */
export async function restoreTabsAfterUpdate(
  d: AfterUpdateDeps,
): Promise<void> {
  const { tabs, b } = d;
  const backup = await tabs.loadBackup();
  if (backup.size === 0 || tabs.entries().length > 0) return;
  const restored: number[] = [];
  for (const [tabId, rec] of backup) {
    if (!d.containers.get(rec.containerId)) continue;
    const tab = await b.tabs.get(tabId).catch(() => null);
    // Same tab ID and window, and still on the same origin (pushState may have changed the path). The origin check
    // guards against tab IDs reused after a browser restart in case the update is applied during startup.
    if (!tab || tab.windowId !== rec.windowId) continue;
    if (
      rec.url !== undefined &&
      networkOrigin(tab.url) !== networkOrigin(rec.url)
    )
      continue;
    void tabs.set(tabId, { ...rec, activeSince: null });
    restored.push(tabId);
  }
  if (restored.length === 0) return;
  // They reload below: the content scripts first (an update may have cleared them).
  await d.scripts.ensure();
  const ok = await d.rules.invalidate(
    ...new Set(restored.map((id) => tabs.containerOf(id)!)),
  );
  const now = Date.now();
  for (const tabId of restored) {
    if (!ok) await tabs.delete(tabId);
    else {
      await tabs.update(tabId, { activeSince: now });
      d.events.emit({
        type: "tab-assigned",
        tabId,
        containerId: tabs.containerOf(tabId)!,
      });
    }
    await d.prepareNavigation((await b.tabs.get(tabId).catch(() => null))?.url);
    await b.tabs.reload(tabId).catch(() => {});
  }
  d.log("info", `restored ${restored.length} container tabs after an update`);
}
