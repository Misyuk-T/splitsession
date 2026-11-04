import type { ToolResult } from "../../../bridge/protocol";
import { ToolError } from "../errors";
import type { ToolContext } from "../tool-context";
import { type ActionMeta, type Args, live, messageOf } from "../tool-kit";

/**
 * Screenshots through `tabs.captureVisibleTab` (no debugger): the one way in basic mode, and the way full mode takes first
 * for a tab that is on show.
 */

/** The tab is the one on show in a window that is not minimised: Chrome can capture it as it is, with no debugger and no tab switch. */
export async function onShow(
  c: ToolContext,
  a: Args,
  tab: { active: boolean; windowId: number },
): Promise<boolean> {
  if (a.fullPage || !tab.active) return false;
  if (c.d.cdp?.isPinned(a.tabId) || c.d.cdp?.current(a.tabId)?.dialog)
    return false; // a viewport override or a dialog: the debugger sees what the page does
  try {
    const w = await c.b.windows.get(tab.windowId);
    return !!w && w.state !== "minimized";
  } catch {
    return false;
  }
}

export async function takeScreenshot(
  c: ToolContext,
  a: Args,
  meta: ActionMeta,
  known?: { id?: number; active: boolean; windowId: number },
): Promise<ToolResult> {
  const tab = known ?? (await c.tab(a.tabId, meta));
  const previous = tab.active
    ? undefined
    : (await c.b.tabs.query({ active: true, windowId: tab.windowId }))[0];
  if (!tab.active) {
    await c.b.tabs.update(a.tabId, { active: true });
    await c.sleep(250); // let the compositor present the tab before it is captured
  }
  try {
    live(meta); // after the 250 ms pause: nothing is captured once the switch is off
    const format = a.format === "jpeg" ? "jpeg" : "png";
    await c.d.activity?.hide(a.tabId); // the picture shows the page, not our frame and pill
    let dataUrl: string;
    try {
      dataUrl = await c.b.tabs.captureVisibleTab(tab.windowId, {
        format,
        ...(format === "jpeg" ? { quality: a.quality } : {}),
      });
    } finally {
      await c.d.activity?.unhide(a.tabId);
    }
    const match = /^data:(image\/[a-z+]+);base64,(.*)$/s.exec(dataUrl);
    if (!match)
      throw new ToolError("Chrome returned an unexpected screenshot format");
    return {
      content: [
        { type: "image", data: match[2]!, mimeType: match[1]! },
        ...(c.d.cdp
          ? [
              {
                type: "text" as const,
                text: JSON.stringify({
                  tabId: a.tabId,
                  path: known?.active ? "visible" : "activated",
                  fullPage: false,
                }),
              },
            ]
          : []),
      ],
    };
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError(
      `could not capture the tab: ${messageOf(error)} (a minimised window cannot be captured)`,
    );
  } finally {
    if (previous?.id !== undefined && previous.id !== a.tabId)
      await c.b.tabs.update(previous.id, { active: true }).catch(() => {});
  }
}
