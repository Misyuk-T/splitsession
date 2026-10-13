import * as hands from "../cdp-tools";
import { ToolError } from "../errors";
import type { ToolContext, ToolHandler } from "../tool-context";
import { json, live, messageOf } from "../tool-kit";

const runJs: ToolHandler = async (c, a, meta) => {
  await c.tab(a.tabId, meta);
  if (a.world === "ISOLATED") {
    throw new ToolError(
      "run_js runs only in the page's own (MAIN) world. An isolated world would read the regular profile's cookies of a container tab's site (SplitSession's cookie shim lives in the MAIN world), so SplitSession does not offer it.",
    );
  }
  // `Runtime.evaluate` through the debugger: it works under any page Content-Security-Policy. No fallback: when the
  // debugger cannot attach (a tab SplitSession may not debug, or one that is busy) the error says so.
  const outcome = await c.onPage(a.tabId, meta, (s) =>
    hands.evaluate(s, a.code, {
      awaitPromise: a.awaitPromise,
      returnByValue: a.returnByValue,
      maxChars: a.maxChars,
    }),
  );
  if (!outcome.ok) throw new ToolError(`${outcome.name}: ${outcome.message}`);
  return c.withDialogNote(a.tabId, {
    content: [
      {
        type: "text",
        text: outcome.json === null ? "undefined" : outcome.json,
      },
      ...(outcome.truncated
        ? [
            {
              type: "text" as const,
              text: `(result truncated to ${a.maxChars} characters)`,
            },
          ]
        : []),
    ],
  });
};

const handleDialog: ToolHandler = async (c, a, meta) => {
  await c.tab(a.tabId, meta);
  const session = c.cdp.current(a.tabId);
  const dialog = session?.dialog;
  if (!session || !dialog) {
    throw new ToolError(
      "no JavaScript dialog that SplitSession saw is open on this tab (SplitSession sees dialogs that open while it works on the tab; one that was already open must be answered by the user)",
    );
  }
  live(meta);
  try {
    await session.send("Page.handleJavaScriptDialog", {
      accept: a.accept,
      ...(a.promptText !== undefined ? { promptText: a.promptText } : {}),
    });
  } catch (error) {
    throw new ToolError(`could not answer the dialog: ${messageOf(error)}`);
  }
  session.dialog = null;
  return json({
    tabId: a.tabId,
    answered: dialog.type,
    message: dialog.message,
    accepted: a.accept,
  });
};

/** Until when `watch` records the tab (ISO time), or false. */
function watchInfo(c: ToolContext, tabId: number): string | false {
  const until = c.cdp.watchingUntil(tabId);
  return until ? new Date(until).toISOString() : false;
}

/** The newest `limit` of `entries`, and how many older ones were left out. */
function newest<T>(entries: T[], limit: number) {
  const shown = entries.slice(-limit);
  return {
    shown,
    omitted:
      entries.length > shown.length
        ? { omitted: entries.length - shown.length }
        : {},
  };
}

const consoleMessages: ToolHandler = async (c, a, meta) => {
  await c.tab(a.tabId, meta);
  const record = c.cdp.record(a.tabId);
  const entries = record.console.filter(
    (e) => e.seq > a.since && (a.level === "all" || e.level === a.level),
  );
  const { shown, omitted } = newest(entries, a.limit);
  return json({
    tabId: a.tabId,
    watching: watchInfo(c, a.tabId),
    next: record.seq,
    ...omitted,
    ...(c.cdp.watchingUntil(a.tabId)
      ? {}
      : {
          note: "console.log output is recorded only while watch runs on this tab; browser messages are recorded whenever SplitSession is attached",
        }),
    messages: shown.map((e) => ({ ...e, at: new Date(e.at).toISOString() })),
  });
};

const networkRequests: ToolHandler = async (c, a, meta) => {
  await c.tab(a.tabId, meta);
  const record = c.cdp.record(a.tabId);
  const entries = record.network.filter(
    (e) =>
      e.seq > a.since && (a.filter === undefined || e.url.includes(a.filter)),
  );
  const { shown, omitted } = newest(entries, a.limit);
  return json({
    tabId: a.tabId,
    watching: watchInfo(c, a.tabId),
    next: record.seq,
    ...omitted,
    requests: shown.map(({ requestHeaders, responseHeaders, ...e }) => ({
      ...e,
      at: new Date(e.at).toISOString(),
      ...(a.includeHeaders
        ? {
            requestHeaders: requestHeaders ?? {},
            responseHeaders: responseHeaders ?? {},
          }
        : {}),
    })),
  });
};

const watch: ToolHandler = async (c, a, meta) => {
  await c.tab(a.tabId, meta);
  live(meta);
  try {
    const until = await c.cdp.watch(a.tabId, a.stop ? 0 : a.minutes);
    live(meta);
    return json({
      tabId: a.tabId,
      watchingUntil: until ? new Date(until).toISOString() : null,
    });
  } catch (error) {
    throw c.cdpFailure(error, meta);
  }
};

const resizeViewport: ToolHandler = async (c, a, meta) => {
  await c.tab(a.tabId, meta);
  if (a.clear) {
    const s = c.cdp.current(a.tabId);
    if (s) await s.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
    c.cdp.pin(a.tabId, false);
    return json({ tabId: a.tabId, cleared: true });
  }
  if (a.width === undefined || a.height === undefined)
    throw new ToolError(
      "resize_viewport: give width and height, or clear: true",
    );
  const size = await c.onPage(a.tabId, meta, async (s) => {
    await s.send("Emulation.setDeviceMetricsOverride", {
      width: a.width,
      height: a.height,
      deviceScaleFactor: 0,
      mobile: false,
    });
    c.cdp.pin(a.tabId, true); // the override lives as long as the session
    const r = await s.send<{ result: { value: { w: number; h: number } } }>(
      "Runtime.evaluate",
      {
        expression: "({ w: innerWidth, h: innerHeight })",
        returnByValue: true,
      },
    );
    return r.result.value;
  });
  return json({ tabId: a.tabId, width: size.w, height: size.h });
};

/** Tools of the debugger only: scripts, dialogs, console and network records, the viewport. */
export const DEVTOOLS_TOOLS: Record<string, ToolHandler> = {
  run_js: runJs,
  handle_dialog: handleDialog,
  console_messages: consoleMessages,
  network_requests: networkRequests,
  watch,
  resize_viewport: resizeViewport,
};
