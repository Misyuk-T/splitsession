import type { ToolResult } from "../../../bridge/protocol";
import { withoutAgentMark } from "../../../core/indicators";
import * as dom from "../dom-tools";
import { ToolError } from "../errors";
import { pageHtml, pageText } from "../inject";
import { tabUrl, type ToolContext, type ToolHandler } from "../tool-context";
import { type ActionMeta, type Args, live } from "../tool-kit";
import { takeScreenshot } from "./capture";
import * as hands from "./hands";

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

/** The picture of the visible part of the tab on show: all that basic mode (no debugger) can take. */
async function basicScreenshot(
  c: ToolContext,
  a: Args,
  meta: ActionMeta,
): Promise<ToolResult> {
  const tab = await c.tab(a.tabId, meta);
  if (a.fullPage)
    throw new ToolError(
      "screenshot_tab: fullPage needs full mode (the debugger); this build captures the visible part of the tab on show only",
    );
  if (!tab.active)
    throw new ToolError(
      "screenshot_tab: this tab is in the background; basic mode captures only the tab on show. Call activate_tab first, or use get_tab_text / snapshot, which need no picture",
    );
  return takeScreenshot(c, a, meta, tab);
}

const screenshot: ToolHandler = (c, a, meta) =>
  c.oneShotAtATime(() =>
    __CDP__ && c.d.cdp
      ? hands.cdpScreenshot(c, a, meta)
      : basicScreenshot(c, a, meta),
  );

/** Tools that read a page: its text, HTML, accessibility snapshot, a screenshot. */
export const READ_TOOLS: Record<string, ToolHandler> = {
  get_tab_text: getTabText,
  get_tab_html: getTabHtml,
  snapshot,
  screenshot_tab: screenshot,
};
