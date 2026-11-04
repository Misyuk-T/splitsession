import type { ToolResult } from "../../../bridge/protocol";
import type { TabSession } from "../cdp";
import * as hands from "../cdp-tools";
import * as dom from "../dom-tools";
import { ToolError } from "../errors";
import type { PageRect } from "../inject";
import type { Modifier } from "../keys";
import { tabUrl, type ToolContext, type ToolHandler } from "../tool-context";
import {
  type ActionMeta,
  type Args,
  hostOf,
  isWebUrl,
  json,
  live,
} from "../tool-kit";
import { onShow,takeScreenshot } from "./capture";

/**
 * The tools and tool paths that need the DevTools protocol ("full hands"). Reached only through `if (__CDP__)` branches, so
 * the store build (basic mode: no `debugger` permission) does not contain this module or `cdp-tools.ts`
 * (scripts/check-store.mjs fails it if it does).
 */

export async function cdpClick(
  c: ToolContext,
  a: Args,
  meta: ActionMeta,
): Promise<ToolResult> {
  const tab = await c.tab(a.tabId, meta);
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
  await c.touch(a.tabId, "click", p.rect, meta); // the ring at the spot that was clicked
  return c.withDialogNote(a.tabId, json({ clicked: p.label }));
}

export async function cdpType(
  c: ToolContext,
  a: Args,
  meta: ActionMeta,
): Promise<ToolResult> {
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
  await c.touch(a.tabId, "type", rect, meta);
  return c.withDialogNote(a.tabId, json({ typed: a.text.length }));
}

const hover: ToolHandler = async (c, a, meta) => {
  const tab = await c.tab(a.tabId, meta);
  c.operable(tabUrl(tab));
  c.noDialog(a.tabId);
  const p = await c.point(a.tabId, meta, a);
  await c.onPage(a.tabId, meta, async (s) => {
    live(meta);
    await hands.mouseMove(s, p);
  });
  await c.touch(a.tabId, "hover", p.rect, meta);
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
  await c.touch(a.tabId, "drag", to.rect, meta);
  return c.withDialogNote(a.tabId, json({ dragged: from.label, to: to.label }));
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
  await c.touch(a.tabId, "press_key", rect, meta);
  return c.withDialogNote(a.tabId, json({ pressed: a.key, times: a.repeat }));
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
  await c.touch(a.tabId, "upload_file", rect, meta);
  return c.withDialogNote(
    a.tabId,
    json({ uploaded: (a.paths as string[]).map((p) => p.split("/").pop()) }),
  );
};

/** The input tools of the debugger only (the others in input.ts have a path without it). */
export const HANDS_INPUT_TOOLS: Record<string, ToolHandler> = {
  hover,
  drag,
  press_key: pressKey,
  upload_file: uploadFile,
};

/** `navigate_back` / `navigate_forward` to the exact history entry (the Back button would skip pages the user never interacted with). */
export async function goToHistoryEntry(
  c: ToolContext,
  a: Args,
  meta: ActionMeta,
  step: -1 | 1,
  inContainer: boolean,
): Promise<void> {
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
    await s.send("Page.navigateToHistoryEntry", { entryId: entry.id });
  };
  await c.onPage(a.tabId, meta, go, { dialogOk: true });
}

/** `screenshot_tab` with the debugger: full page, background tabs in place, a pinned viewport, an open dialog. */
export async function cdpScreenshot(
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
