import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";

import {
  hostPids,
  installHost,
  type Mcp,
  openPopup,
  startMcp,
} from "./bridge-helpers";
import { at, expect, ext, type Facet, test } from "./fixtures";

/**
 * The agent bridge's "full hands": snapshot with refs (read from the DOM, no debugger), trusted input, dialogs, console and
 * network, background screenshots (chrome.debugger / CDP), and the isolation checks that make sure the debugger is not a
 * way around containers. Chrome shows "started debugging this browser" (and moves the page) while SplitSession is attached, so
 * the debugger is used only where nothing else can do the job, and one attach serves a whole burst of actions.
 *
 * Playwright drives this Chromium over CDP itself, and Chrome lets several debugger clients share a tab, so the
 * extension's own `chrome.debugger.attach` works next to it. Playwright dismisses JavaScript dialogs that nobody listens
 * for, so the dialog test registers a listener that leaves them open for the extension to answer.
 */

async function turnOn(facet: Facet): Promise<Page> {
  await facet.api("updateSettings", { agentBridge: true }); // the switch lives in Settings; the popup row appears once it is on
  const { page: popup } = await openPopup(facet);
  await expect(popup.getByTestId("bridge-card")).toHaveAttribute(
    "data-status",
    "connected",
    { timeout: 15_000 },
  );
  return popup;
}

const openPlain = async (mcp: Mcp, url: string): Promise<number> =>
  (await mcp.json<{ tabId: number }>("open_tab", { url })).tabId;
const js = async (mcp: Mcp, tabId: number, code: string): Promise<string> => {
  const r = await mcp.call("run_js", { tabId, code });
  expect(r.isError, r.text).toBe(false);
  return r.texts[0]!;
};
const textOf = (mcp: Mcp, tabId: number, id: string) =>
  js(
    mcp,
    tabId,
    `return document.getElementById(${JSON.stringify(id)}).textContent;`,
  ).then((t) => JSON.parse(t) as string);
const snap = async (
  mcp: Mcp,
  tabId: number,
): Promise<{
  head: {
    tabId: number;
    url: string;
    title: string;
    refs: number;
    truncated: boolean;
  };
  body: string;
}> => {
  const r = await mcp.call("snapshot", { tabId });
  expect(r.isError, r.text).toBe(false);
  return { head: JSON.parse(r.texts[0]!), body: r.texts[1]! };
};
const refOf = (body: string, line: RegExp): string => {
  const m = new RegExp(`${line.source}.*?\\[ref=(e\\d+)\\]`, "u").exec(body);
  if (!m) throw new Error(`no line matching ${line} in:\n${body}`);
  return m[1]!;
};
/** Is the extension attached to the tab? Chrome refuses a second attach by the same extension, so try one. */
const extensionAttached = (facet: Facet, tabId: number) =>
  facet.inWorker(async (id: number) => {
    const d = (globalThis as any).chrome.debugger;
    try {
      await d.attach({ tabId: id }, "1.3");
    } catch (e) {
      return /already attached/i.test(String(e));
    }
    await d.detach({ tabId: id });
    return false;
  }, tabId);

/** The idle window of the debugger session: a minute by default; the tests that wait for the detach shorten it. */
const setIdle = (facet: Facet, ms: number) =>
  facet.inWorker(
    async (n: number) => (globalThis as any).facetCdp.setIdleMs(n),
    ms,
  );
const isAttached = (facet: Facet, tabId: number) =>
  facet.inWorker(
    async (id: number) =>
      (globalThis as any).facetCdp.isAttached(id) as boolean,
    tabId,
  );
/** Counts how often the extension attaches the debugger (every `chrome.debugger.attach` of the worker) from now on. */
const countAttaches = (facet: Facet) =>
  facet.inWorker(async () => {
    const d = (globalThis as any).chrome.debugger;
    const g = globalThis as any;
    g.__attaches = 0;
    if (!g.__attachPatched) {
      g.__attachPatched = true;
      const original = d.attach.bind(d);
      d.attach = (...args: unknown[]) => {
        g.__attaches++;
        return original(...args);
      };
    }
  }, undefined);
const attaches = (facet: Facet) =>
  facet.inWorker(
    async () => (globalThis as any).__attaches as number,
    undefined,
  );

test.describe("agent bridge: full hands (CDP)", () => {
  let mcp: Mcp | null = null;
  const tmp: string[] = [];

  test.beforeEach(({ facet }) => {
    installHost(facet);
  });
  test.afterEach(async ({ facet }) => {
    await mcp?.close().catch(() => {});
    mcp = null;
    await facet.api("updateSettings", { agentBridge: false });
    await setIdle(facet, 60_000);
    await facet.inWorker(async () => {
      const c = (globalThis as any).chrome;
      const stray: Array<{ id: number; url?: string }> = (
        await c.tabs.query({})
      ).filter((t: { url?: string }) =>
        /^(https?:|chrome-extension:|chrome:)/.test(t.url ?? ""),
      );
      await c.tabs.remove(stray.map((t) => t.id));
    }, undefined);
    await expect.poll(() => hostPids(facet), { timeout: 10_000 }).toEqual([]);
    for (const dir of tmp.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  test('reading and locating never attach the debugger (no "started debugging" bar); the first trusted input attaches once and a burst reuses it', async ({
    facet,
  }) => {
    test.setTimeout(60_000);
    await turnOn(facet);
    mcp = await startMcp(facet);
    const tabId = await openPlain(mcp, at("a.localhost", "/cdp"));
    await countAttaches(facet);

    const trail: string[] = [];
    const mark = async (what: string) =>
      trail.push(`${what}=${await attaches(facet)}`);
    // Reading: the accessibility-style snapshot (from the DOM), text and HTML.
    const { body } = await snap(mcp, tabId);
    await mark("snapshot");
    await mcp.call("get_tab_text", { tabId });
    await mark("text");
    await mcp.call("get_tab_html", { tabId, selector: "h1" });
    await mark("html");
    // Focus-only and DOM-only tools: choosing an option, scrolling to a ref, waiting, navigating.
    const size = refOf(body, /- combobox "Size"/);
    expect(
      await mcp.json("select_option", { tabId, ref: size, values: ["Medium"] }),
    ).toEqual({ selected: ["m"] });
    await mark("select");
    const later = refOf(body, /- button "Later"/);
    await mcp.json("scroll", { tabId, ref: later });
    await mark("scroll");
    await mcp.json("wait_for", { tabId, text: "Log things" });
    await mark("wait");
    await mcp.json("navigate", { tabId, url: at("a.localhost", "/blank") });
    await mark("navigate");
    expect(trail.join(" ")).toBe(
      "snapshot=0 text=0 html=0 select=0 scroll=0 wait=0 navigate=0",
    );
    expect(await isAttached(facet, tabId)).toBe(false);
    expect(await extensionAttached(facet, tabId)).toBe(false);

    // A burst of five clicks, 3 s apart (an agent thinking between steps): ONE attach, kept for the whole burst.
    await mcp.json("navigate", { tabId, url: at("a.localhost", "/cdp") });
    await countAttaches(facet);
    const join = refOf((await snap(mcp, tabId)).body, /- button "Join"/);
    for (let i = 0; i < 5; i++) {
      await mcp.json("click", { tabId, ref: join });
      expect(await isAttached(facet, tabId)).toBe(true);
      if (i < 4) await new Promise((r) => setTimeout(r, 3_000));
    }
    expect(await attaches(facet)).toBe(1);
    expect(
      (await textOf(mcp, tabId, "log")).match(/click trusted=true/g),
    ).toHaveLength(5);
    // Reads inside the burst do not end it and do not start another one.
    await snap(mcp, tabId);
    await mcp.call("get_tab_text", { tabId });
    expect(await attaches(facet)).toBe(1);
    expect(await isAttached(facet, tabId)).toBe(true);
  });

  test("the debugger lets go a minute after the last tool that needed it (shortened here), not after 5 s", async ({
    facet,
  }) => {
    await turnOn(facet);
    mcp = await startMcp(facet);
    const tabId = await openPlain(mcp, at("a.localhost", "/cdp"));
    expect(
      await facet.inWorker(
        async () => (globalThis as any).facetCdp.idleMs as number,
        undefined,
      ),
    ).toBe(60_000);
    await setIdle(facet, 8_000);
    await mcp.json("click", { tabId, selector: "#trusted" });
    await new Promise((r) => setTimeout(r, 6_500)); // longer than the old 5 s window
    expect(await isAttached(facet, tabId)).toBe(true);
    await expect
      .poll(() => isAttached(facet, tabId), { timeout: 8_000 })
      .toBe(false);
    expect(await extensionAttached(facet, tabId)).toBe(false);
  });

  test("a screenshot of the tab that is on show in its window needs no debugger; a background tab does", async ({
    facet,
  }) => {
    await turnOn(facet);
    mcp = await startMcp(facet);
    const shown = (
      await mcp.json<{ tabId: number }>("open_tab", {
        url: at("a.localhost", "/agent"),
        active: true,
      })
    ).tabId;
    await countAttaches(facet);
    const shot = await mcp.call("screenshot_tab", { tabId: shown });
    expect(shot.isError, shot.text).toBe(false);
    expect(shot.images).toHaveLength(1);
    expect(JSON.parse(shot.texts[0]!)).toMatchObject({
      tabId: shown,
      path: "visible",
      fullPage: false,
    });
    expect(await attaches(facet)).toBe(0);
    expect(await isAttached(facet, shown)).toBe(false);
    const back = await openPlain(mcp, at("b.localhost", "/blank"));
    await mcp.json("open_tab", {
      url: at("b.localhost", "/blank"),
      active: true,
    });
    const other = await mcp.call("screenshot_tab", { tabId: back });
    expect(other.isError, other.text).toBe(false);
    expect(JSON.parse(other.texts[0]!).path).toMatch(
      /^(background|screencast)$/,
    );
    expect(await isAttached(facet, back)).toBe(true);
  });

  test("snapshot shows the page with refs; a click by ref is a real, trusted click (double, right, with modifiers)", async ({
    facet,
  }) => {
    await turnOn(facet);
    mcp = await startMcp(facet);
    const tabId = await openPlain(mcp, at("a.localhost", "/cdp"));

    const { head, body } = await snap(mcp, tabId);
    expect(head).toMatchObject({
      tabId,
      url: at("a.localhost", "/cdp"),
      title: "CDP page",
      truncated: false,
    });
    expect(head.refs).toBeGreaterThan(10);
    expect(body).toMatch(/^- heading "CDP page" \[level=1\] \[ref=e\d+\]$/mu);
    expect(body).toMatch(/^- button "Join" \[ref=e\d+\]$/mu);
    expect(body).toMatch(/^- textbox "Controlled" \[ref=e\d+\]$/mu);
    expect(body).toMatch(
      /^- combobox "Size" \[collapsed\] \[ref=e\d+\]: Small$/mu,
    );
    expect(body).toMatch(/^- label \[ref=e\d+\]: Controlled$/mu);
    expect(body).toMatch(/^- button "Attachment" \[ref=e\d+\]/mu); // the file input
    const join = refOf(body, /- button "Join"/);

    expect(await mcp.json("click", { tabId, ref: join })).toEqual({
      clicked: "<button#trusted>",
    });
    expect(await textOf(mcp, tabId, "log")).toContain(
      "click trusted=true detail=1 shift=false",
    );
    await mcp.json("click", { tabId, ref: join, clickCount: 2 });
    expect(await textOf(mcp, tabId, "log")).toContain("dblclick trusted=true");
    await mcp.json("click", { tabId, ref: join, button: "right" });
    expect(await textOf(mcp, tabId, "log")).toContain(
      "contextmenu trusted=true",
    );
    await mcp.json("click", {
      tabId,
      selector: "#trusted",
      modifiers: ["Shift"],
    });
    expect(await textOf(mcp, tabId, "log")).toContain(
      "click trusted=true detail=1 shift=true",
    );
    // Coordinates: whatever is there.
    const [x, y] = JSON.parse(
      await js(
        mcp,
        tabId,
        'const r = document.getElementById("trusted").getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2];',
      ),
    ) as [number, number];
    expect(await mcp.json("click", { tabId, x, y })).toEqual({
      clicked: "<button#trusted>",
    });
    expect((await mcp.call("click", { tabId, x: 100000, y: 5 })).text).toMatch(
      /no element at \(100000, 5\); the viewport is \d+x\d+/,
    );

    // The same element keeps its ref in the next snapshot, and our overlay is not part of the page.
    const again = await snap(mcp, tabId);
    expect(refOf(again.body, /- button "Join"/)).toBe(join);
    expect(again.body).not.toContain("Agent:");
    // Mistakes are explained.
    expect((await mcp.call("click", { tabId, ref: "e99999" })).text).toMatch(
      /unknown ref e99999: the page has changed/,
    );
    expect(
      (await mcp.call("click", { tabId, ref: join, selector: "#trusted" }))
        .text,
    ).toMatch(/give ref or selector, not both/);
    expect((await mcp.call("click", { tabId })).text).toMatch(
      /give a ref \(from snapshot\), a selector, or both x and y/,
    );
    expect(
      (await mcp.call("click", { tabId, selector: "#absent" })).text,
    ).toMatch(/no element matches "#absent"/);
    // A new document: old refs are refused instead of hitting something else.
    await mcp.json("navigate", {
      tabId,
      url: at("a.localhost", "/cdp?again=1"),
    });
    expect((await mcp.call("click", { tabId, ref: join })).text).toMatch(
      /unknown ref/,
    );
  });

  test("type into a React-like controlled input, keys and shortcuts, Enter submits", async ({
    facet,
  }) => {
    await turnOn(facet);
    mcp = await startMcp(facet);
    const tabId = await openPlain(mcp, at("a.localhost", "/cdp"));
    const { body } = await snap(mcp, tabId);
    const field = refOf(body, /- textbox "Controlled"/);

    expect(
      await mcp.json("type", { tabId, ref: field, text: "hello" }),
    ).toEqual({ typed: 5 });
    expect(await textOf(mcp, tabId, "ctl-state")).toBe(
      "state=hello trusted=true",
    );
    await mcp.json("type", { tabId, ref: field, text: "world" }); // replaces
    expect(await textOf(mcp, tabId, "ctl-state")).toBe(
      "state=world trusted=true",
    );
    await mcp.json("type", { tabId, ref: field, text: "!!", append: true });
    expect(await textOf(mcp, tabId, "ctl-state")).toBe(
      "state=world!! trusted=true",
    );
    expect((await snap(mcp, tabId)).body).toMatch(
      /- textbox "Controlled" \[focused\] \[ref=e\d+\]: world!!/,
    );

    // One key press per character, then shortcuts: select all (Meta+A on macOS, Control+A elsewhere) and delete.
    await mcp.json("type", {
      tabId,
      selector: "#keys",
      text: "xy",
      append: true,
      slowly: true,
    });
    expect(
      JSON.parse(
        await js(mcp, tabId, 'return document.getElementById("keys").value'),
      ),
    ).toBe("abcxy");
    expect(await textOf(mcp, tabId, "keys-out")).toContain(
      "x trusted=true\ny trusted=true",
    );
    await mcp.json("press_key", {
      tabId,
      selector: "#keys",
      key: "ControlOrMeta+A",
    });
    await mcp.json("press_key", { tabId, key: "Backspace" });
    expect(
      JSON.parse(
        await js(mcp, tabId, 'return document.getElementById("keys").value'),
      ),
    ).toBe("");
    expect(await textOf(mcp, tabId, "keys-out")).toMatch(
      /Backspace trusted=true/,
    );
    expect(
      (await mcp.call("press_key", { tabId, key: "Hyper+K" })).text,
    ).toMatch(/"Hyper" is not a modifier/);
    expect(
      (await mcp.call("type", { tabId, selector: "h1", text: "x" })).text,
    ).toMatch(/not a text field/);

    // Enter in a form field submits the form, like a user pressing it.
    await mcp.json("type", { tabId, selector: "#kq", text: "cats" });
    expect(await mcp.json("press_key", { tabId, key: "Enter" })).toEqual({
      pressed: "Enter",
      times: 1,
    });
    await expect
      .poll(
        async () =>
          (
            await mcp!.json<Array<{ tabId: number; url: string }>>("list_tabs")
          ).find((t) => t.tabId === tabId)?.url,
        { timeout: 10_000 },
      )
      .toBe(at("a.localhost", "/agent-submit?q=cats"));
  });

  test("hover, select_option, upload_file and drag", async ({ facet }) => {
    await turnOn(facet);
    mcp = await startMcp(facet);
    const tabId = await openPlain(mcp, at("a.localhost", "/cdp"));
    const { body } = await snap(mcp, tabId);

    expect(await mcp.json("hover", { tabId, selector: "#hov" })).toEqual({
      hovered: "<div#hov>",
    });
    expect(await textOf(mcp, tabId, "hov-out")).toBe("entered trusted=true");
    expect(
      await js(
        mcp,
        tabId,
        'return document.getElementById("hov").matches(":hover")',
      ),
    ).toBe("true");
    expect(
      await js(
        mcp,
        tabId,
        'return getComputedStyle(document.getElementById("hov")).backgroundColor',
      ),
    ).toBe('"rgb(255, 200, 0)"');

    const size = refOf(body, /- combobox "Size"/);
    expect(
      await mcp.json("select_option", { tabId, ref: size, values: ["Large"] }),
    ).toEqual({ selected: ["l"] });
    expect(await textOf(mcp, tabId, "size-out")).toBe("size=l");
    expect(
      await mcp.json("select_option", { tabId, ref: size, values: ["m"] }),
    ).toEqual({ selected: ["m"] });
    expect(
      (await mcp.call("select_option", { tabId, ref: size, values: ["XL"] }))
        .text,
    ).toMatch(
      /no option "XL"; the options are "s" \(Small\), "m" \(Medium\), "l" \(Large\)/,
    );
    expect(
      (
        await mcp.call("select_option", {
          tabId,
          selector: "#ctl",
          values: ["a"],
        })
      ).text,
    ).toMatch(/is not a <select>/);

    const dir = mkdtempSync(path.join(tmpdir(), "facet-upload-"));
    tmp.push(dir);
    writeFileSync(path.join(dir, "a.txt"), "hello");
    writeFileSync(path.join(dir, "b.txt"), "abc");
    const file = refOf(body, /- button "Attachment"/);
    expect(
      await mcp.json("upload_file", {
        tabId,
        ref: file,
        paths: [path.join(dir, "a.txt"), path.join(dir, "b.txt")],
      }),
    ).toEqual({ uploaded: ["a.txt", "b.txt"] });
    expect(await textOf(mcp, tabId, "file-out")).toBe("a.txt:5,b.txt:3");
    expect(
      (
        await mcp.call("upload_file", {
          tabId,
          ref: file,
          paths: [path.join(dir, "missing.txt")],
        })
      ).text,
    ).toMatch(/missing\.txt is not a file on this computer/);
    expect(
      (
        await mcp.call("upload_file", {
          tabId,
          selector: "#ctl",
          paths: [path.join(dir, "a.txt")],
        })
      ).text,
    ).toMatch(/not a file input/);

    // A mouse drag (the page follows mousedown/mousemove/mouseup) and an HTML5 drag and drop.
    const dragged = await mcp.json("drag", {
      tabId,
      selector: "#handle",
      toSelector: "#track",
    });
    expect(dragged).toEqual({ dragged: "<div#handle>", to: "<div#track>" });
    expect(await textOf(mcp, tabId, "drag-out")).toMatch(
      /^moved=1[23]\d trusted=true$/,
    );
    await mcp.json("drag", {
      tabId,
      selector: "#dragsrc",
      toSelector: "#drop",
    });
    await expect
      .poll(() => textOf(mcp!, tabId, "drop-out"))
      .toBe("dropped=payload-42");
  });

  test("run_js works under a strict Content-Security-Policy (no eval, no inline scripts)", async ({
    facet,
  }) => {
    await turnOn(facet);
    mcp = await startMcp(facet);
    const tabId = await openPlain(mcp, at("a.localhost", "/cdp-csp"));
    // Control: the page's own script cannot eval (it tried while loading).
    expect(await js(mcp, tabId, "return window.pageEval;")).toBe('"EvalError"');
    expect(await js(mcp, tabId, "return window.cspVar * 6;")).toBe("42");
    expect(
      await js(
        mcp,
        tabId,
        "await new Promise((r) => setTimeout(r, 20)); return { t: document.title, n: [1, 2n, NaN] };",
      ),
    ).toBe('{"t":"Strict page","n":[1,"2n",null]}');
    const thrown = await mcp.call("run_js", {
      tabId,
      code: 'throw new TypeError("boom")',
    });
    expect(thrown).toMatchObject({ isError: true, text: "TypeError: boom" });
    expect(
      (await mcp.call("run_js", { tabId, code: "return (" })).text,
    ).toMatch(/^SyntaxError: /);
    expect(
      (
        await mcp.call("run_js", {
          tabId,
          code: "return document.body",
          returnByValue: false,
        })
      ).text,
    ).toBe('"body"');
    expect(
      (
        await mcp.call("run_js", {
          tabId,
          code: "return 5",
          awaitPromise: false,
        })
      ).text,
    ).toBe("5");
    expect(
      (
        await mcp.call("run_js", {
          tabId,
          code: "const a = {}; a.self = a; return a;",
        })
      ).text,
    ).toBe('{"self":"[Circular]"}');
    // A bare expression gives its value back as well (under the same strict CSP), with or without a trailing semicolon.
    expect(await js(mcp, tabId, "document.title")).toBe('"Strict page"');
    expect(await js(mcp, tabId, "({ a: 1, t: document.title });")).toBe(
      '{"a":1,"t":"Strict page"}',
    );
    expect(await js(mcp, tabId, "await Promise.resolve(window.cspVar)")).toBe(
      "7",
    );
    expect(
      (
        await mcp.call("run_js", {
          tabId,
          code: "window.cspVar = 8; window.cspVar + 1",
        })
      ).text,
    ).toBe("undefined"); // statements without `return`: still a body
    expect((await mcp.call("run_js", { tabId, code: "1 +" })).text).toMatch(
      /^SyntaxError: /,
    );
  });

  test("screenshot of a background tab leaves the active tab alone; full page", async ({
    facet,
  }) => {
    await turnOn(facet);
    mcp = await startMcp(facet);
    const background = await openPlain(mcp, at("a.localhost", "/agent"));
    const front = await mcp.json<{ tabId: number; windowId: number }>(
      "open_tab",
      { url: at("b.localhost", "/blank"), active: true },
    );
    // Count every tab switch in that window while the screenshot is taken.
    await facet.inWorker(async () => {
      (globalThis as any).__switches = 0;
      (globalThis as any).__onSwitch = () =>
        ((globalThis as any).__switches += 1);
      (globalThis as any).chrome.tabs.onActivated.addListener(
        (globalThis as any).__onSwitch,
      );
    }, undefined);
    try {
      const shot = await mcp.call("screenshot_tab", { tabId: background });
      expect(shot.isError, shot.text).toBe(false);
      expect(shot.images[0]!.mimeType).toBe("image/png");
      expect(JSON.parse(shot.texts[0]!)).toMatchObject({
        tabId: background,
        fullPage: false,
        path: expect.stringMatching(/^(background|screencast)$/),
      });
      const png = Buffer.from(shot.images[0]!.data, "base64");
      const height = png.readUInt32BE(20);
      const full = await mcp.call("screenshot_tab", {
        tabId: background,
        fullPage: true,
        format: "jpeg",
        quality: 60,
      });
      expect(full.images[0]!.mimeType).toBe("image/jpeg");
      expect(JSON.parse(full.texts[0]!)).toMatchObject({
        fullPage: true,
        path: "background",
      });
      expect(await jpegHeight(facet, full.images[0]!.data)).toBeGreaterThan(
        height * 1.5,
      ); // the 3000 px page, not the viewport
      expect(
        await facet.inWorker(
          async () => (globalThis as any).__switches as number,
          undefined,
        ),
      ).toBe(0);
      expect(
        (
          await mcp.json<Array<{ tabId: number; active: boolean }>>(
            "list_tabs",
            { windowId: front.windowId },
          )
        ).find((t) => t.tabId === front.tabId)!.active,
      ).toBe(true);
    } finally {
      await facet.inWorker(
        async () =>
          (globalThis as any).chrome.tabs.onActivated.removeListener(
            (globalThis as any).__onSwitch,
          ),
        undefined,
      );
    }
  });

  test("JavaScript dialogs are reported and answered", async ({ facet }) => {
    const leaveOpen = () => {}; // with a listener, Playwright leaves dialogs to whoever answers them
    facet.ctx.on("dialog", leaveOpen);
    try {
      await turnOn(facet);
      mcp = await startMcp(facet);
      const tabId = await openPlain(mcp, at("a.localhost", "/cdp"));

      const alerted = await mcp.call("click", { tabId, selector: "#alert" });
      expect(alerted.isError, alerted.text).toBe(false);
      expect(alerted.text).toMatch(
        /a JavaScript alert is open on this tab: "hello from the page"\. Answer it with handle_dialog/,
      );
      const blocked = await mcp.call("snapshot", { tabId });
      expect(blocked).toMatchObject({
        isError: true,
        text: expect.stringMatching(/alert is open.*handle_dialog/),
      });
      expect(await mcp.json("handle_dialog", { tabId, accept: true })).toEqual({
        tabId,
        answered: "alert",
        message: "hello from the page",
        accepted: true,
      });
      await expect
        .poll(() => textOf(mcp!, tabId, "dialog-out"))
        .toContain("alert closed");

      await mcp.call("click", { tabId, selector: "#confirm" });
      await mcp.json("handle_dialog", { tabId, accept: false });
      await expect
        .poll(() => textOf(mcp!, tabId, "dialog-out"))
        .toContain("confirm=false");
      await mcp.call("click", { tabId, selector: "#prompt" });
      await mcp.json("handle_dialog", {
        tabId,
        accept: true,
        promptText: "Taras",
      });
      await expect
        .poll(() => textOf(mcp!, tabId, "dialog-out"))
        .toContain("prompt=Taras");
      expect(
        (await mcp.call("handle_dialog", { tabId, accept: true })).text,
      ).toMatch(/no JavaScript dialog that SplitSession saw is open/);
    } finally {
      facet.ctx.off("dialog", leaveOpen);
    }
  });

  test("an open JavaScript dialog is still answerable after the agent paused longer than the idle window", async ({
    facet,
  }) => {
    test.setTimeout(60_000);
    const leaveOpen = () => {};
    facet.ctx.on("dialog", leaveOpen);
    try {
      await turnOn(facet);
      mcp = await startMcp(facet);
      const tabId = await openPlain(mcp, at("a.localhost", "/cdp"));
      await setIdle(facet, 5_000);
      const attached = () => isAttached(facet, tabId);
      const alerted = await mcp.call("click", { tabId, selector: "#alert" });
      expect(alerted.isError, alerted.text).toBe(false);
      expect(alerted.text).toMatch(/a JavaScript alert is open/);
      await new Promise((r) => setTimeout(r, 7_000)); // longer than the 5 s idle window
      expect(await attached()).toBe(true); // the session was kept for the dialog
      expect(await mcp.json("handle_dialog", { tabId, accept: true })).toEqual({
        tabId,
        answered: "alert",
        message: "hello from the page",
        accepted: true,
      });
      await expect
        .poll(() => textOf(mcp!, tabId, "dialog-out"))
        .toContain("alert closed");
      const shot = await snap(mcp, tabId);
      expect(shot.head.tabId).toBe(tabId);
      // Answered: the normal idle window applies again and the debugger goes.
      await expect.poll(attached, { timeout: 12_000 }).toBe(false);
    } finally {
      facet.ctx.off("dialog", leaveOpen);
    }
  });

  test("resize_viewport does not pin the debugger forever: it is released shortly after the MCP client is gone", async ({
    facet,
  }) => {
    test.setTimeout(90_000);
    await turnOn(facet);
    mcp = await startMcp(facet);
    const tabId = await openPlain(mcp, at("a.localhost", "/agent"));
    const state = () =>
      facet.inWorker(
        async (id: number) => ({
          attached: (globalThis as any).facetCdp.isAttached(id) as boolean,
          pinned: (globalThis as any).facetCdp.isPinned(id) as boolean,
        }),
        tabId,
      );
    await mcp.json("resize_viewport", { tabId, width: 500, height: 400 });
    expect(await state()).toEqual({ attached: true, pinned: true });
    // The agent is still there and thinking (longer than the release grace): nothing is taken back.
    await new Promise((r) => setTimeout(r, 13_000));
    expect(await state()).toEqual({ attached: true, pinned: true });
    expect(await js(mcp, tabId, "return [innerWidth, innerHeight]")).toBe(
      "[500,400]",
    );

    // The MCP process goes away (Claude Code quit): after the grace the override is cleared and the debugger detached.
    await mcp.close();
    mcp = null;
    await expect
      .poll(state, { timeout: 25_000 })
      .toEqual({ attached: false, pinned: false });
    expect(await extensionAttached(facet, tabId)).toBe(false);
  });

  test("console and network are recorded while watching; credentials never show", async ({
    facet,
  }) => {
    await turnOn(facet);
    mcp = await startMcp(facet);
    const tabId = await openPlain(mcp, at("a.localhost", "/cdp"));
    const watching = await mcp.json<{ watchingUntil: string }>("watch", {
      tabId,
      minutes: 2,
    });
    expect(Date.parse(watching.watchingUntil)).toBeGreaterThan(
      Date.now() + 60_000,
    );
    await mcp.json("click", { tabId, selector: "#logs" });

    type Msg = { seq: number; level: string; source: string; text: string };
    await expect
      .poll(
        async () =>
          (
            await mcp!.json<{ messages: Msg[] }>("console_messages", { tabId })
          ).messages.map((m) => `${m.level}:${m.source}:${m.text}`),
        { timeout: 10_000 },
      )
      .toEqual(
        expect.arrayContaining([
          "log:console:hello console {a: 1}",
          "error:console:bad thing",
          expect.stringMatching(/^error:exception:.*thrown later/),
        ]),
      );
    const errors = await mcp.json<{ messages: Msg[]; next: number }>(
      "console_messages",
      { tabId, level: "error" },
    );
    expect(errors.messages.every((m) => m.level === "error")).toBe(true);
    expect(
      (
        await mcp.json<{ messages: Msg[] }>("console_messages", {
          tabId,
          since: errors.next,
        })
      ).messages,
    ).toEqual([]);

    type Req = {
      method: string;
      url: string;
      type: string;
      status: number;
      requestHeaders?: Record<string, string>;
    };
    await expect
      .poll(
        async () =>
          (
            await mcp!.json<{ requests: Req[] }>("network_requests", {
              tabId,
              filter: "/api/ping",
            })
          ).requests.map((r) => r.status),
        { timeout: 10_000 },
      )
      .toEqual([200]);
    const net = await mcp.json<{ requests: Req[] }>("network_requests", {
      tabId,
      filter: "/api/ping",
      includeHeaders: true,
    });
    expect(net.requests[0]).toMatchObject({
      method: "GET",
      url: at("a.localhost", "/api/ping?n=1"),
      type: "Fetch",
    });
    expect(net.requests[0]!.requestHeaders).toBeDefined();
    expect(
      (
        await mcp.json<{ requests: Req[] }>("network_requests", {
          tabId,
          filter: "/api/ping",
        })
      ).requests[0]!.requestHeaders,
    ).toBeUndefined();

    expect(await mcp.json("watch", { tabId, stop: true })).toEqual({
      tabId,
      watchingUntil: null,
    });
    const other = await openPlain(mcp, at("b.localhost", "/blank"));
    expect(
      (
        await mcp.json<{ note?: string; watching: unknown }>(
          "console_messages",
          { tabId: other },
        )
      ).note,
    ).toMatch(/only while watch runs/);
  });

  test("a container tab with the debugger attached still gets only its container's cookies, from the first request on", async ({
    facet,
  }) => {
    const c = await facet.container("Debugged");
    const alice = await facet.openIn(
      c.name,
      at("a.localhost", "/login?user=alice"),
    );
    await expect(alice.locator("#user")).toHaveText("alice");
    await facet.openIn(
      c.name,
      at("a.localhost", "/set?c=vis%3Dcontainer%3B%20Path%3D%2F"),
    );
    // The regular profile is logged in as someone else and has a script-visible cookie of its own.
    const bob = await facet.plain(at("a.localhost", "/login?user=bob"));
    await expect(bob.locator("#user")).toHaveText("bob");
    await facet.ctx.addCookies([
      { name: "vis", value: "profile", url: at("a.localhost", "/") },
    ]);
    const bobSid = (await facet.realCookies(at("a.localhost", "/"))).find(
      (x) => x.name === "sid",
    )!.value;
    expect(bobSid).toBeTruthy();

    await turnOn(facet);
    mcp = await startMcp(facet);
    const opened = await mcp.json<{ tabId: number }>("open_in_container", {
      url: at("a.localhost", "/cdp"),
      container: c.name,
    });
    const tabId = opened.tabId;
    await mcp.json("watch", { tabId, minutes: 1 }); // stays attached through everything below
    expect(await extensionAttached(facet, tabId)).toBe(true);

    const firstRequests = async (
      action: () => Promise<unknown>,
      pathPrefix: string,
    ) => {
      await facet.clearLog();
      await action();
      const first = (await facet.serverLog()).find(
        (r) => r.host === "a.localhost" && r.path.startsWith(pathPrefix),
      );
      expect(first, `no request to ${pathPrefix}`).toBeDefined();
      return first!.cookie;
    };
    for (const cookie of [
      await firstRequests(() => mcp!.json("reload", { tabId }), "/cdp"),
      await firstRequests(
        () =>
          mcp!.json("navigate", {
            tabId,
            url: at("a.localhost", "/whoami?step=2"),
          }),
        "/whoami",
      ),
      await firstRequests(() => mcp!.json("navigate_back", { tabId }), "/cdp"),
      await firstRequests(
        () => mcp!.json("navigate_forward", { tabId }),
        "/whoami",
      ),
    ]) {
      expect(cookie).toMatch(/\bsid=/);
      expect(cookie).not.toContain(bobSid);
      expect(cookie).toContain("vis=container");
      expect(cookie).not.toContain("vis=profile");
    }
    expect((await mcp.call("get_tab_text", { tabId })).texts[1]).toContain(
      "alice",
    );
    expect((await snap(mcp, tabId)).body).toContain("alice");
    // The page's own script world (the shim) and the agent's run_js see the container's cookies only.
    expect(await js(mcp, tabId, "return document.cookie")).toBe(
      '"vis=container"',
    );
    // The request list never carries cookies, either way.
    const net = await mcp.json<{
      requests: Array<{
        requestHeaders?: Record<string, string>;
        responseHeaders?: Record<string, string>;
      }>;
    }>("network_requests", { tabId, includeHeaders: true });
    const dump = JSON.stringify(net);
    expect(net.requests.length).toBeGreaterThan(0);
    expect(dump).not.toContain(bobSid);
    expect(dump).not.toMatch(/sid=[A-Za-z0-9_-]{6,}/);
    expect(dump).not.toContain("vis=");
    await mcp.json("watch", { tabId, stop: true });
  });

  test("switching the bridge off detaches the debugger at once; SplitSession takes back a session it forgot", async ({
    facet,
  }) => {
    const popup = await turnOn(facet);
    mcp = await startMcp(facet);
    const tabId = await openPlain(mcp, at("a.localhost", "/cdp"));
    await mcp.json("watch", { tabId, minutes: 5 });
    expect(await extensionAttached(facet, tabId)).toBe(true);
    expect(
      await facet.inWorker(
        async (id: number) => (globalThis as any).facetCdp.isAttached(id),
        tabId,
      ),
    ).toBe(true);

    await popup.getByRole("switch", { name: /Agent bridge/ }).click();
    await expect(popup.getByTestId("bridge-card")).toHaveCount(0); // off: the popup has no agent row at all
    await expect.poll(() => extensionAttached(facet, tabId)).toBe(false);
    expect(
      await facet.inWorker(
        async (id: number) => (globalThis as any).facetCdp.isAttached(id),
        tabId,
      ),
    ).toBe(false);

    // On again. The extension holds a session the bridge does not know about (as after a worker restart): Chrome
    // refuses a second attach by the same extension, SplitSession detaches its own and goes on.
    await facet.api("updateSettings", { agentBridge: true }); // (back on from Settings: the popup has no switch while it is off)
    await expect(popup.getByTestId("bridge-card")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 15_000 },
    );
    await setIdle(facet, 5_000);
    await facet.inWorker(
      async (id: number) =>
        (globalThis as any).chrome.debugger.attach({ tabId: id }, "1.3"),
      tabId,
    );
    expect(await mcp.json("click", { tabId, selector: "#trusted" })).toEqual({
      clicked: "<button#trusted>",
    });
    expect(await textOf(mcp, tabId, "log")).toContain("click trusted=true");
    // Idle: detached again a few seconds after the last action.
    await expect
      .poll(
        () =>
          facet.inWorker(
            async (id: number) => (globalThis as any).facetCdp.isAttached(id),
            tabId,
          ),
        { timeout: 12_000 },
      )
      .toBe(false);
  });

  test("pages SplitSession does not debug: browser pages, extension pages", async ({
    facet,
  }) => {
    await turnOn(facet);
    mcp = await startMcp(facet);
    const chromePage = await openPlain(mcp, "chrome://version/");
    expect((await mcp.call("snapshot", { tabId: chromePage })).text).toMatch(
      /cannot operate this tab: chrome:\/\/ pages belong to the browser/,
    );
    const own = await openPlain(mcp, ext("options.html"));
    expect(
      (await mcp.call("click", { tabId: own, selector: "body" })).text,
    ).toMatch(
      /extension pages \(SplitSession's own included\) are not operated by the agent/,
    );
  });

  test("wait_for, history, reload, viewport size, and frames", async ({
    facet,
  }) => {
    await turnOn(facet);
    mcp = await startMcp(facet);
    const tabId = await openPlain(mcp, at("a.localhost", "/cdp"));

    await mcp.json("click", { tabId, selector: "#later" });
    const waited = await mcp.json<{ ok: boolean; waitedMs: number }>(
      "wait_for",
      { tabId, text: "Ready now" },
    );
    expect(waited.ok).toBe(true);
    expect(
      (await mcp.call("wait_for", { tabId, text: "never there", timeout: 300 }))
        .text,
    ).toMatch(/the text "never there" did not appear within 0\.3 s/);
    expect(
      (
        await mcp.json<{ ok: boolean }>("wait_for", {
          tabId,
          selector: "#later-out",
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await mcp.json<{ ok: boolean }>("wait_for", {
          tabId,
          textGone: "not on the page",
        })
      ).ok,
    ).toBe(true);
    expect((await mcp.call("wait_for", { tabId })).text).toMatch(
      /give exactly one of/,
    );

    await mcp.json("navigate", { tabId, url: at("a.localhost", "/blank") });
    expect(await mcp.json("navigate_back", { tabId })).toMatchObject({
      url: at("a.localhost", "/cdp"),
      loaded: true,
    });
    expect(await mcp.json("navigate_forward", { tabId })).toMatchObject({
      url: at("a.localhost", "/blank"),
      loaded: true,
    });
    expect((await mcp.call("navigate_forward", { tabId })).text).toMatch(
      /no next page/,
    );
    expect(await mcp.json("reload", { tabId })).toMatchObject({
      url: at("a.localhost", "/blank"),
      loaded: true,
    });

    expect(
      await mcp.json("resize_viewport", { tabId, width: 500, height: 400 }),
    ).toEqual({ tabId, width: 500, height: 400 });
    expect(await js(mcp, tabId, "return [innerWidth, innerHeight]")).toBe(
      "[500,400]",
    );
    expect(await mcp.json("resize_viewport", { tabId, clear: true })).toEqual({
      tabId,
      cleared: true,
    });
    // The override no longer keeps SplitSession attached. (That the page gets its real size back is checked against plain
    // Chromium in docs/decisions.md: under Playwright, whose own viewport emulation sits on the same tab, it keeps 500.)
    expect(
      await facet.inWorker(
        async (id: number) => (globalThis as any).facetCdp.isPinned(id),
        tabId,
      ),
    ).toBe(false);

    // Frames: the same-site one and the cross-site one (another process) are both in the snapshot and clickable.
    await mcp.json("navigate", {
      tabId,
      url: at("a.localhost", "/cdp-frames"),
    });
    const { body } = await snap(mcp, tabId);
    expect(body).toMatch(
      /- iframe "Same site" \[ref=e\d+\]:\n {2}- button "Inside a\.localhost" \[ref=e\d+\]/u,
    );
    expect(body).toMatch(
      /- iframe "Other site" \[ref=e\d+\]:\n {2}- button "Inside b\.localhost" \[ref=e\d+\]/u,
    );
    await mcp.json("click", {
      tabId,
      ref: refOf(body, /- button "Inside a\.localhost"/),
    });
    await mcp.json("click", {
      tabId,
      ref: refOf(body, /- button "Inside b\.localhost"/),
    });
    await expect
      .poll(
        async () =>
          (
            (await snap(mcp!, tabId)).body.match(
              /inside clicked trusted=true/g,
            ) ?? []
          ).length,
      )
      .toBe(2);
  });
});

/** Height of a JPEG (SOF marker), decoded in Node. */
async function jpegHeight(_facet: Facet, base64: string): Promise<number> {
  const b = Buffer.from(base64, "base64");
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) return 0;
    const marker = b[i + 1]!;
    const len = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3) return b.readUInt16BE(i + 5);
    i += 2 + len;
  }
  return 0;
}
