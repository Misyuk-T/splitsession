import type { ToolResult } from "../../../bridge/protocol";
import * as dom from "../dom-tools";
import { ToolError } from "../errors";
import { pageClick, type PageRect, pageScroll, pageType } from "../inject";
import { tabUrl, type ToolContext, type ToolHandler } from "../tool-context";
import { type ActionMeta, type Args, json, live } from "../tool-kit";
import * as hands from "./hands";

/**
 * Basic mode (no debugger) click: events a page script could send, on a ref from snapshot, a selector (top frame) or a point.
 * Pages that check `isTrusted` ignore it; full mode (the unpacked Full from GitHub) clicks with the browser's own input.
 */
async function basicClick(
  c: ToolContext,
  a: Args,
  meta: ActionMeta,
  url: string | undefined,
): Promise<ToolResult> {
  const t = c.target(a);
  if (t?.ref !== undefined) {
    if (a.x !== undefined || a.y !== undefined)
      throw new ToolError("click: give a ref, a selector or x+y, not several");
    c.operable(url);
    const r = await c.onElement<{ label: string; rect: PageRect | null }>(
      a.tabId,
      meta,
      t,
      (target) => ({ op: "click", target }),
    );
    await c.touch(a.tabId, "click", r.rect, meta);
    return json({ clicked: r.label });
  }
  const hasPoint = a.x !== undefined && a.y !== undefined;
  if (a.selector === undefined && !hasPoint)
    throw new ToolError("click: give a ref, a selector, or both x and y");
  if (a.selector === undefined && (a.x === undefined) !== (a.y === undefined))
    throw new ToolError("click: x and y go together");
  const { rect, ...result } = (await c.inPage(
    a.tabId,
    pageClick,
    [a.selector ?? null, hasPoint ? a.x : null, hasPoint ? a.y : null],
    "ISOLATED",
    meta,
  )) as { clicked: string; rect: PageRect | null };
  await c.touch(a.tabId, "click", rect, meta);
  return json(result);
}

const click: ToolHandler = async (c, a, meta) => {
  if (__CDP__ && c.d.cdp) return hands.cdpClick(c, a, meta);
  return basicClick(c, a, meta, tabUrl(await c.tab(a.tabId, meta)));
};

const type: ToolHandler = async (c, a, meta) => {
  const tab = await c.tab(a.tabId, meta);
  if (__CDP__ && c.d.cdp) return hands.cdpType(c, a, meta);
  // Basic mode (no debugger): the value is set the way a page script would (the page's own setter, input and change events).
  // `slowly` (one key press per character) is the browser's input and is not available.
  if (a.slowly)
    throw new ToolError(
      "type: slowly needs full mode (the debugger); send the text without it",
    );
  const t = c.target(a);
  if (!t)
    throw new ToolError(
      "type: give a ref (from snapshot) or a selector of the field",
    );
  let rect: PageRect | null;
  let typed: number;
  if (t.ref === undefined) {
    const r = (await c.inPage(
      a.tabId,
      pageType,
      [a.selector, a.text, a.append, a.submit],
      "ISOLATED",
      meta,
    )) as { typed: number; rect: PageRect | null };
    ({ rect, typed } = r);
  } else {
    c.operable(tabUrl(tab));
    const r = await c.onElement<{ typed: number; rect: PageRect | null }>(
      a.tabId,
      meta,
      t,
      (target) => ({
        op: "typeInto",
        target,
        text: a.text,
        append: a.append,
        submit: a.submit,
      }),
    );
    ({ rect, typed } = r);
  }
  await c.touch(a.tabId, "type", rect, meta);
  return json({ typed });
};

/** Choosing an option is the page's own DOM work (the same events a script would send); no debugger. */
const selectOption: ToolHandler = async (c, a, meta) => {
  const tab = await c.tab(a.tabId, meta);
  c.operable(tabUrl(tab));
  c.noDialog(a.tabId);
  const t = c.target(a);
  if (!t)
    throw new ToolError(
      "select_option: give a ref (from snapshot) or a selector of the <select>",
    );
  const r = await c.onElement<{
    selected: string[];
    rect: PageRect | null;
  }>(a.tabId, meta, t, (target) => ({
    op: "select",
    target,
    values: a.values,
  }));
  await c.touch(a.tabId, "select_option", r.rect, meta);
  return json({ selected: r.selected });
};

const scroll: ToolHandler = async (c, a, meta) => {
  const tab = await c.tab(a.tabId, meta);
  const t = c.target(a);
  if (t?.ref !== undefined) {
    if (a.to !== undefined || a.dx !== undefined || a.dy !== undefined)
      throw new ToolError(
        "scroll: give ref, selector, to, or dx/dy, not several",
      );
    c.operable(tabUrl(tab));
    c.noDialog(a.tabId);
    return json(
      await c.onElement(a.tabId, meta, t, (target) => ({
        op: "scrollTo",
        target,
      })),
    );
  }
  if (
    a.selector === undefined &&
    a.to === undefined &&
    a.dx === undefined &&
    a.dy === undefined
  )
    throw new ToolError("scroll: give ref, selector, to, or dx/dy");
  return json(
    await c.inPage(
      a.tabId,
      pageScroll,
      [a.selector ?? null, a.to ?? null, a.dx ?? 0, a.dy ?? 0],
      "ISOLATED",
      meta,
    ),
  );
};

const waitFor: ToolHandler = async (c, a, meta) => {
  const tab = await c.tab(a.tabId, meta);
  const t = c.target(a);
  const given = [
    a.text !== undefined,
    a.textGone !== undefined,
    t !== null,
  ].filter(Boolean).length;
  if (given !== 1)
    throw new ToolError(
      "wait_for: give exactly one of text, textGone, or an element (ref or selector)",
    );
  c.operable(tabUrl(tab));
  const r = await dom.waitFor(
    c.domHost(meta),
    a.tabId,
    c.refs.get(a.tabId),
    {
      ...(a.text !== undefined ? { text: a.text } : {}),
      ...(a.textGone !== undefined ? { textGone: a.textGone } : {}),
      ...(t ? { target: t } : {}),
      state: a.state,
      timeout: a.timeout,
    },
    {
      isLive: () => live(meta),
      blocked: () => c.noDialog(a.tabId),
      sleep: (ms) => c.sleep(ms),
    },
  );
  return json({ ok: true, waitedMs: r.waitedMs });
};

/** Tools that act on a page as a user would: pointer, keyboard, form fields, scrolling, waiting. */
export const INPUT_TOOLS: Record<string, ToolHandler> = {
  click,
  type,
  select_option: selectOption,
  scroll,
  wait_for: waitFor,
  // Hover, drag, key presses and uploads are the browser's own input: the debugger.
  ...(__CDP__ ? hands.HANDS_INPUT_TOOLS : {}),
};
