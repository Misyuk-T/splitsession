import type { ToolResult } from "../../../bridge/protocol";
import { withoutAgentMark } from "../../../core/indicators";
import type { TabSession } from "../cdp";
import { ToolError } from "../errors";
import { tabUrl, type ToolContext, type ToolHandler } from "../tool-context";
import {
  type ActionMeta,
  type Args,
  checkUrl,
  hostOf,
  isWebUrl,
  json,
  live,
  messageOf,
  OPEN_SCHEMES,
} from "../tool-kit";

/** Long enough to see "closing" on the tab before it goes. */
const CLOSE_PAUSE_MS = 600;

/** Which Chrome profile the agent is talking to: the user's label plus the size of the profile. */
const bridgeInfo: ToolHandler = async (c) => {
  const label = ((await c.d.profileLabel?.()) ?? "").trim();
  const [windows, tabs] = await Promise.all([
    c.b.windows.getAll(),
    c.b.tabs.query({}),
  ]);
  return json({
    profileLabel: label === "" ? null : label,
    windows: windows.length,
    tabs: tabs.length,
    containers: c.d.facet.listContainers().length,
    extensionVersion: c.b.runtime.getManifest().version,
  });
};

const listContainers: ToolHandler = async (c) =>
  json(
    c.d.facet.listContainers().map((x) => ({
      id: x.id,
      name: x.name,
      color: x.color,
      tabCount: x.tabCount,
    })),
  );

const listTabs: ToolHandler = async (c, a) => {
  const query: { windowId?: number } = {};
  if (a.windowId !== undefined) query.windowId = a.windowId;
  let only: string | undefined;
  if (a.containerId !== undefined) {
    const found = c.d.facet.containers.resolve(a.containerId);
    if (!found) throw new ToolError(`no container "${a.containerId}"`);
    only = found.id;
  }
  const tabs = await c.b.tabs.query(query);
  const out = [];
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    const containerId = c.d.facet.getTabContainer(tab.id);
    if (only !== undefined && containerId !== only) continue;
    const container = containerId
      ? c.d.facet.containers.get(containerId)
      : undefined;
    out.push({
      tabId: tab.id,
      windowId: tab.windowId,
      index: tab.index,
      active: tab.active,
      pinned: tab.pinned,
      title: withoutAgentMark(tab.title ?? ""),
      url: tabUrl(tab) ?? "",
      status: tab.status,
      groupId: tab.groupId ?? -1,
      container: container ? { id: container.id, name: container.name } : null,
    });
  }
  return json(out);
};

const openInContainer: ToolHandler = async (c, a, meta) => {
  const url = checkUrl(a.url, ["http:", "https:"]);
  meta.host = url.host;
  const container = await c.container(a.container, a.createIfMissing);
  live(meta);
  const tabId = await c.d.facet.openInContainer(url.href, container.id, {
    active: a.active,
    ...(a.windowId !== undefined ? { windowId: a.windowId } : {}),
  });
  meta.tabId = tabId;
  await c.touch(tabId, "open_in_container");
  const loaded = a.wait ? await c.waitForLoad(tabId, meta) : undefined;
  if (loaded) await c.touch(tabId, "open_in_container");
  return c.summaryAfterLoad(tabId, loaded);
};

const openTab: ToolHandler = async (c, a, meta) => {
  const url = checkUrl(a.url, OPEN_SCHEMES);
  meta.host = url.host || undefined;
  const tab = await c.b.tabs.create({
    url: url.href,
    active: a.active,
    ...(a.windowId !== undefined ? { windowId: a.windowId } : {}),
  });
  if (tab.id === undefined)
    throw new ToolError("Chrome did not create the tab");
  meta.tabId = tab.id;
  await c.touch(tab.id, "open_tab");
  const loaded =
    a.wait && url.protocol !== "about:"
      ? await c.waitForLoad(tab.id, meta)
      : undefined;
  if (loaded) await c.touch(tab.id, "open_tab");
  return c.summaryAfterLoad(tab.id, loaded);
};

const navigate: ToolHandler = async (c, a, meta) => {
  const url = checkUrl(a.url, OPEN_SCHEMES);
  await c.tab(a.tabId, meta);
  meta.host = url.host || undefined;
  // Same as every navigation SplitSession starts itself: no service worker of the target may answer a container's request.
  if (
    c.d.facet.getTabContainer(a.tabId) !== null &&
    (url.protocol === "http:" || url.protocol === "https:")
  )
    await c.d.facet.prepareNavigation(url.href);
  live(meta);
  await c.b.tabs.update(a.tabId, { url: url.href });
  const loaded = a.wait ? await c.waitForLoad(a.tabId, meta) : undefined;
  if (loaded) await c.touch(a.tabId, "navigate"); // the new page has none of the old page's overlay
  return c.summaryAfterLoad(a.tabId, loaded);
};

const closeTab: ToolHandler = async (c, a, meta) => {
  await c.tab(a.tabId, meta);
  if (c.d.activity) await c.sleep(CLOSE_PAUSE_MS); // the user sees which tab is going
  live(meta);
  await c.b.tabs.remove(a.tabId);
  return json({ tabId: a.tabId, closed: true });
};

const activateTab: ToolHandler = async (c, a, meta) => {
  const tab = await c.tab(a.tabId, meta);
  await c.b.tabs.update(a.tabId, { active: true });
  await c.b.windows.update(tab.windowId, { focused: true }).catch(() => {});
  return json(await c.summary(a.tabId));
};

const assignTab: ToolHandler = async (c, a, meta) => {
  await c.tab(a.tabId, meta);
  let containerId: string | null = null;
  if (a.container !== null) {
    if (a.container.trim() === "")
      throw new ToolError(
        "container must be a name or ID, or null to leave the container",
      );
    containerId = (await c.container(a.container, a.createIfMissing)).id;
  }
  live(meta);
  await c.d.api.assignTab(a.tabId, containerId, { reload: a.reload });
  if (a.reload && (await c.waitForLoad(a.tabId, meta)))
    await c.touch(a.tabId, "assign_tab"); // the reloaded page starts clean
  return json(await c.summary(a.tabId));
};

/** `navigate_back` (step -1) and `navigate_forward` (step 1). */
async function history(
  c: ToolContext,
  a: Args,
  meta: ActionMeta,
  step: -1 | 1,
): Promise<ToolResult> {
  await c.tab(a.tabId, meta);
  const inContainer = c.d.facet.getTabContainer(a.tabId) !== null;
  const where = step < 0 ? "back" : "forward";
  type History = {
    currentIndex: number;
    entries: Array<{ id: number; url: string }>;
  };
  const go = async (s: TabSession) => {
    const h = await s.send<History>("Page.getNavigationHistory");
    const entry = h.entries[h.currentIndex + step];
    if (!entry)
      throw new ToolError(
        step < 0
          ? "there is no previous page in this tab's history"
          : "there is no next page in this tab's history",
      );
    meta.host = hostOf(entry.url) ?? meta.host;
    // Same as every navigation SplitSession starts: no service worker of the target may answer a container's request.
    if (inContainer && isWebUrl(entry.url))
      await c.d.facet.prepareNavigation(entry.url);
    live(meta);
    // The exact entry (the Back button would skip pages the user never interacted with).
    await s.send("Page.navigateToHistoryEntry", { entryId: entry.id });
  };
  // The exact history entry needs the debugger (`Page.getNavigationHistory`): Chrome's own Back skips pages nobody interacted
  // with, which is every page an agent has just opened, so `tabs.goBack` would often find "no previous page" where there is one.
  try {
    if (!c.d.cdp) throw new ToolError("no debugger");
    await c.onPage(a.tabId, meta, go, { dialogOk: true });
  } catch (error) {
    // Without the debugger (a page SplitSession may not debug): Chrome's own Back/Forward, never for a container tab.
    if (
      inContainer ||
      meta.signal?.aborted ||
      !(error instanceof ToolError) ||
      /no (previous|next) page/.test(error.message)
    )
      throw error;
    const tabs = c.b.tabs as unknown as {
      goBack(id: number): Promise<void>;
      goForward(id: number): Promise<void>;
    };
    live(meta);
    try {
      await (step < 0 ? tabs.goBack(a.tabId) : tabs.goForward(a.tabId));
    } catch (e) {
      throw new ToolError(`could not go ${where}: ${messageOf(e)}`);
    }
  }
  const loaded = a.wait ? await c.waitForLoad(a.tabId, meta) : undefined;
  if (loaded)
    await c.touch(a.tabId, step < 0 ? "navigate_back" : "navigate_forward");
  return c.summaryAfterLoad(a.tabId, loaded);
}

const reload: ToolHandler = async (c, a, meta) => {
  const tab = await c.tab(a.tabId, meta);
  const url = tabUrl(tab);
  if (c.d.facet.getTabContainer(a.tabId) !== null && url && isWebUrl(url))
    await c.d.facet.prepareNavigation(url);
  live(meta);
  await c.b.tabs.reload(a.tabId, { bypassCache: a.bypassCache });
  const loaded = a.wait ? await c.waitForLoad(a.tabId, meta) : undefined;
  if (loaded) await c.touch(a.tabId, "reload");
  return c.summaryAfterLoad(a.tabId, loaded);
};

/** Tools that find, open, move and navigate tabs and containers. */
export const TAB_TOOLS: Record<string, ToolHandler> = {
  bridge_info: bridgeInfo,
  list_containers: listContainers,
  list_tabs: listTabs,
  open_in_container: openInContainer,
  open_tab: openTab,
  navigate,
  navigate_back: (c, a, meta) => history(c, a, meta, -1),
  navigate_forward: (c, a, meta) => history(c, a, meta, 1),
  reload,
  close_tab: closeTab,
  activate_tab: activateTab,
  assign_tab: assignTab,
};
