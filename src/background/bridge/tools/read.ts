import type { ToolResult } from "../../../bridge/protocol";
import { withoutAgentMark } from "../../../core/indicators";
import * as hands from "../cdp-tools";
import * as dom from "../dom-tools";
import { ToolError } from "../errors";
import { pageHtml, pageText } from "../inject";
import { tabUrl, type ToolContext, type ToolHandler } from "../tool-context";
import { type ActionMeta, type Args, live, messageOf } from "../tool-kit";

/** The tool's JSON header and the page's text, as two content items. */
const headerAndBody = (head: unknown, body: string): ToolResult => ({
  content: [
    { type: "text", text: JSON.stringify(head) },
    { type: "text", text: body },
  ],
});

const getTabText: ToolHandler = async (c, a, meta) => {
  await c.tab(a.tabId, meta);
  c.noDialog(a.tabId);
  const r = await c.inPage(a.tabId, pageText, [a.maxChars], "ISOLATED", meta);
  return headerAndBody(
    {
      tabId: a.tabId,
      url: r.url,
      title: r.title,
      length: r.total,
      truncated: r.total > r.text.length,
    },
    r.text,
  );
};

const getTabHtml: ToolHandler = async (c, a, meta) => {
  await c.tab(a.tabId, meta);
  c.noDialog(a.tabId);
  const r = (await c.inPage(
    a.tabId,
    pageHtml,
    [a.selector ?? null, a.maxChars],
    "ISOLATED",
    meta,
  )) as { html: string; total: number; url: string; title: string };
  return headerAndBody(
    {
      tabId: a.tabId,
      url: r.url,
      title: r.title,
      selector: a.selector ?? null,
      length: r.total,
      truncated: r.total > r.html.length,
    },
    r.html,
  );
};

const snapshot: ToolHandler = async (c, a, meta) => {
  const tab = await c.tab(a.tabId, meta);
  const url = tabUrl(tab) ?? "";
  c.operable(url);
  c.noDialog(a.tabId);
  let origin: string | undefined;
  try {
    origin = new URL(url).origin;
  } catch {
    origin = undefined;
  }
  const { output: out, refs } = await dom.domSnapshot(
    c.domHost(meta),
    a.tabId,
    c.refs.get(a.tabId),
    { maxChars: a.maxChars, origin },
  );
  live(meta);
  c.refs.set(a.tabId, refs);
  const head = {
    tabId: a.tabId,
    url,
    title: out.title || withoutAgentMark(tab.title ?? ""),
    refs: out.refs,
    truncated: out.truncated,
  };
  return c.withDialogNote(
    a.tabId,
    headerAndBody(
      head,
      out.text === ""
        ? "(the page shows nothing that the accessibility tree reports)"
        : out.text,
    ),
  );
};

/** The tab is the one on show in a window that is not minimised: Chrome can capture it as it is, with no debugger and no tab switch. */
async function onShow(
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

async function cdpScreenshot(
  c: ToolContext,
  a: Args,
  meta: ActionMeta,
): Promise<ToolResult> {
  const tab = await c.tab(a.tabId, meta);
  if (await onShow(c, a, tab)) {
    try {
      return await takeScreenshot(c, a, meta, tab);
    } catch (error) {
      if (meta.signal?.aborted) throw error;
      // Chrome would not capture it (a window that is not drawn): the debugger can.
    }
  }
  const format: "png" | "jpeg" = a.format === "jpeg" ? "jpeg" : "png";
  let shot: hands.Shot;
  await c.d.activity?.hide(a.tabId); // the picture shows the page, not our frame and pill
  try {
    shot = await c.onPage(a.tabId, meta, (s) =>
      hands.capture(s, {
        format,
        quality: a.quality,
        fullPage: a.fullPage,
        activate: async () => {
          live(meta);
          const previous = tab.active
            ? undefined
            : (
                await c.b.tabs.query({
                  active: true,
                  windowId: tab.windowId,
                })
              )[0];
          if (!tab.active) await c.b.tabs.update(a.tabId, { active: true });
          return async () => {
            if (previous?.id !== undefined && previous.id !== a.tabId)
              await c.b.tabs
                .update(previous.id, { active: true })
                .catch(() => {});
          };
        },
      }),
    );
  } catch (error) {
    if (
      error instanceof ToolError &&
      /cannot operate this tab|busy/.test(error.message) &&
      !meta.signal?.aborted
    ) {
      await c.d.activity?.unhide(a.tabId);
      return await takeScreenshot(c, a, meta, tab); // a page SplitSession may not debug: the old way (activates the tab for a moment)
    }
    throw error;
  } finally {
    await c.d.activity?.unhide(a.tabId);
  }
  return c.withDialogNote(a.tabId, {
    content: [
      { type: "image", data: shot.data, mimeType: `image/${format}` },
      {
        type: "text",
        text: JSON.stringify({
          tabId: a.tabId,
          path: shot.path,
          fullPage: shot.fullPage,
          ...(shot.clipped ? { clipped: true } : {}),
        }),
      },
    ],
  });
}

async function takeScreenshot(
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

const screenshot: ToolHandler = (c, a, meta) =>
  c.oneShotAtATime(() =>
    c.d.cdp ? cdpScreenshot(c, a, meta) : takeScreenshot(c, a, meta),
  );

/** Tools that read a page: its text, HTML, accessibility snapshot, a screenshot. */
export const READ_TOOLS: Record<string, ToolHandler> = {
  get_tab_text: getTabText,
  get_tab_html: getTabHtml,
  snapshot,
  screenshot_tab: screenshot,
};
