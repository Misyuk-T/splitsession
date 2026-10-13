import type { ToolResult } from "../../../bridge/protocol";
import * as hands from "../cdp-tools";
import * as dom from "../dom-tools";
import { ToolError } from "../errors";
import { pageClick, type PageRect, pageScroll, pageType } from "../inject";
import type { Modifier } from "../keys";
import { tabUrl, type ToolContext, type ToolHandler } from "../tool-context";
import { type ActionMeta, type Args, json, live } from "../tool-kit";

/** Without the debugger (unit tests of the old paths): an injected click on a selector or a point. */
async function legacyClick(
  c: ToolContext,
  a: Args,
  meta: ActionMeta,
): Promise<ToolResult> {
  const hasPoint = a.x !== undefined && a.y !== undefined;
  if (a.selector === undefined && !hasPoint)
    throw new ToolError("click: give a selector, or both x and y");
  if (a.selector === undefined && (a.x === undefined) !== (a.y === undefined))
    throw new ToolError("click: x and y go together");
  const { rect, ...result } = (await c.inPage(
    a.tabId,
    pageClick,
    [a.selector ?? null, hasPoint ? a.x : null, hasPoint ? a.y : null],
    "ISOLATED",
    meta,
  )) as { clicked: string; rect: PageRect | null };
  await c.touch(a.tabId, "click", rect);
  return json(result);
}

const click: ToolHandler = async (c, a, meta) => {
  const tab = await c.tab(a.tabId, meta);
  if (!c.d.cdp) return legacyClick(c, a, meta);
  c.operable(tabUrl(tab));
  // Where to click is the page's own DOM work; the debugger is attached only for the click itself (and not at all for a mistake).
  c.noDialog(a.tabId);
  const p = await c.point(a.tabId, meta, a);
  await c.onPage(a.tabId, meta, async (s) => {
    live(meta);
    await hands.mouseClick(
      s,
      p,
      a.button,
      a.clickCount,
      (a.modifiers ?? []) as Modifier[],
    );
  });
  await c.touch(a.tabId, "click", p.rect); // the ring at the spot that was clicked
  return c.withDialogNote(a.tabId, json({ clicked: p.label }));
};

const hover: ToolHandler = async (c, a, meta) => {
  const tab = await c.tab(a.tabId, meta);
  c.operable(tabUrl(tab));
  c.noDialog(a.tabId);
  const p = await c.point(a.tabId, meta, a);
  await c.onPage(a.tabId, meta, async (s) => {
    live(meta);
    await hands.mouseMove(s, p);
  });
  await c.touch(a.tabId, "hover", p.rect);
  return c.withDialogNote(a.tabId, json({ hovered: p.label }));
};

const drag: ToolHandler = async (c, a, meta) => {
  const tab = await c.tab(a.tabId, meta);
  c.operable(tabUrl(tab));
  if (!c.target(a, "to") && (a.toX === undefined || a.toY === undefined))
    throw new ToolError(
      "drag: give where to drop: toRef, toSelector, or toX+toY",
    );
  c.noDialog(a.tabId);
  const from = await c.point(a.tabId, meta, a);
  const to = await c.point(a.tabId, meta, a, "to");
  await c.onPage(a.tabId, meta, async (s) => {
    live(meta);
    await hands.mouseDrag(s, from, to);
  });
  await c.touch(a.tabId, "drag", to.rect);
  return c.withDialogNote(a.tabId, json({ dragged: from.label, to: to.label }));
};

const type: ToolHandler = async (c, a, meta) => {
  await c.tab(a.tabId, meta);
  if (!c.d.cdp) {
    if (a.selector === undefined) throw new ToolError("type: give a selector");
    const { rect, ...result } = (await c.inPage(
      a.tabId,
      pageType,
      [a.selector, a.text, a.append, a.submit],
      "ISOLATED",
      meta,
    )) as { typed: number; rect: PageRect | null };
    await c.touch(a.tabId, "type", rect);
    return json(result);
  }
  const t = c.target(a);
  if (!t)
    throw new ToolError(
      "type: give a ref (from snapshot) or a selector of the field",
    );
  if (a.slowly && a.text.length > 2000)
    throw new ToolError(
      "slowly types at most 2000 characters; send longer text without slowly",
    );
  const rect = await c.onPage(a.tabId, meta, async (s) => {
    // The field gets the focus (and its text is selected) from the page's own side; the keys are the debugger's.
    const prepared = await c.onElement<{
      empty: boolean;
      rect: PageRect | null;
    }>(a.tabId, meta, t, (target) => ({
      op: "prepareType",
      target,
      append: a.append,
    }));
    live(meta);
    await hands.typeText(s, a.text, prepared, {
      append: a.append,
      slowly: a.slowly,
      submit: a.submit,
      isMac: !!c.d.isMac,
    });
    return prepared.rect;
  });
  await c.touch(a.tabId, "type", rect);
  return c.withDialogNote(a.tabId, json({ typed: a.text.length }));
};

const pressKey: ToolHandler = async (c, a, meta) => {
  await c.tab(a.tabId, meta);
  const t = c.target(a);
  const rect = await c.onPage(a.tabId, meta, async (s) => {
    let focused: PageRect | null = null;
    if (t)
      focused = (
        await c.onElement<{ rect: PageRect | null }>(
          a.tabId,
          meta,
          t,
          (target) => ({ op: "focus", target }),
        )
      ).rect;
    live(meta);
    await hands.pressShortcut(s, a.key, !!c.d.isMac, a.repeat);
    return focused;
  });
  await c.touch(a.tabId, "press_key", rect);
  return c.withDialogNote(a.tabId, json({ pressed: a.key, times: a.repeat }));
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
  await c.touch(a.tabId, "select_option", r.rect);
  return json({ selected: r.selected });
};

const uploadFile: ToolHandler = async (c, a, meta) => {
  await c.tab(a.tabId, meta);
  const t = c.target(a);
  if (!t)
    throw new ToolError(
      'upload_file: give a ref (from snapshot) or a selector of the <input type="file">',
    );
  const marker = `data-facet-up-${Math.random().toString(36).slice(2)}`;
  const rect = await c.onPage(a.tabId, meta, async (s) => {
    // The input is marked for a moment (an attribute no page has a reason to look for) so the debugger can take hold of it.
    const marked = await c.onElement<{
      multiple: boolean;
      rect: PageRect | null;
    }>(a.tabId, meta, t, (target) => ({ op: "mark", target, name: marker }));
    try {
      if ((a.paths as string[]).length > 1 && !marked.multiple)
        throw new ToolError(
          'this file input takes one file (it has no "multiple")',
        );
      live(meta);
      await hands.setFilesByMarker(s, marker, a.paths);
    } finally {
      await c
        .domHost(meta)
        .tryCall(a.tabId, dom.frameOf(c.refs.get(a.tabId), t), {
          op: "unmark",
          name: marker,
        });
    }
    return marked.rect;
  });
  await c.touch(a.tabId, "upload_file", rect);
  return c.withDialogNote(
    a.tabId,
    json({ uploaded: (a.paths as string[]).map((p) => p.split("/").pop()) }),
  );
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
  hover,
  drag,
  type,
  press_key: pressKey,
  select_option: selectOption,
  upload_file: uploadFile,
  scroll,
  wait_for: waitFor,
};
