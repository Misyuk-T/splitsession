import { execFileSync } from "node:child_process";
import type { Page } from "@playwright/test";

import {
  hostPids,
  installHost,
  installOldHost,
  type Mcp,
  openPopup,
  type SecondProfile,
  startMcp,
  startSecondProfile,
  uninstallHost,
} from "./bridge-helpers";
import { at, expect, ext, type Facet, test } from "./fixtures";

interface TabRow {
  tabId: number;
  windowId: number;
  index: number;
  active: boolean;
  pinned: boolean;
  title: string;
  url: string;
  groupId: number;
  container: { id: string; name: string } | null;
}

/** Popup with the agent bridge switched on and connected. */
async function turnOn(
  facet: Facet,
): Promise<{ popup: Page; card: ReturnType<Page["getByTestId"]> }> {
  await facet.api("updateSettings", { agentBridge: true }); // the switch lives in Settings; the popup row appears once it is on
  const { page: popup } = await openPopup(facet);
  const card = popup.getByTestId("bridge-card");
  await expect(card).toHaveAttribute("data-status", "connected", {
    timeout: 15_000,
  });
  return { popup, card };
}

const tabsOf = (mcp: Mcp, args: Record<string, unknown> = {}) =>
  mcp.json<TabRow[]>("list_tabs", args);

/** A plain tab opened by the bridge itself. */
async function openPlain(mcp: Mcp, url: string): Promise<number> {
  const opened = await mcp.json<{ tabId: number }>("open_tab", { url });
  return opened.tabId;
}

test.describe("agent bridge", () => {
  let mcp: Mcp | null = null;
  let second: SecondProfile | null = null;

  test.beforeEach(({ facet }) => {
    installHost(facet); // the host manifest goes into this run's browser profile only
  });
  test.afterEach(async ({ facet }) => {
    await mcp?.close().catch(() => {});
    mcp = null;
    await second?.close();
    second = null;
    await facet.api("setBridgeProfileLabel", "");
    // Leave nothing behind for the other specs: bridge off, and no page of ours polling the worker awake.
    await facet.api("updateSettings", { agentBridge: false });
    await facet.inWorker(async () => {
      const c = (globalThis as any).chrome;
      const stray: Array<{ id: number; url?: string }> = (
        await c.tabs.query({})
      ).filter((t: { url?: string }) =>
        /^(https?:|chrome-extension:)/.test(t.url ?? ""),
      );
      await c.tabs.remove(stray.map((t) => t.id));
    }, undefined);
    await expect.poll(() => hostPids(facet), { timeout: 10_000 }).toEqual([]);
  });

  test("is off by default: no host process, and the MCP server says so", async ({
    facet,
  }) => {
    const { page: popup, toggle } = await openPopup(facet);
    await expect(toggle).toHaveCount(0); // a fresh Full install: the popup is about containers, no agent UI at all
    await expect(popup.getByTestId("bridge-card")).toHaveCount(0);
    await expect(popup.getByText(/agent|pnpm/i)).toHaveCount(0);
    // The one agent entry point: a quiet "MCP" pill in the header, no status dot while the bridge is off.
    await expect(popup.getByTestId("mcp-button")).toHaveText("MCP");
    await expect(popup.getByTestId("mcp-button")).toHaveAttribute(
      "data-status",
      "off",
    );
    await expect(popup.locator(".fx-mcp__dot")).toHaveCount(0);
    expect(
      await facet.api<{ agentBridge: boolean }>("getSettings"),
    ).toMatchObject({ agentBridge: false });
    expect(hostPids(facet)).toEqual([]);

    mcp = await startMcp(facet);
    const off = await mcp.call("list_tabs");
    expect(off.isError).toBe(true);
    expect(off.text).toMatch(
      /bridge is off — turn it on in SplitSession Settings/,
    );

    const empty = await startMcp(facet, "/nonexistent-native-hosts");
    const missing = await empty.call("list_tabs");
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(
      /host is not installed — run `npx splitsession-bridge install`/,
    );
    await empty.close();

    const { tools } = await mcp.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "activate_tab",
      "assign_tab",
      "bridge_info",
      "click",
      "close_tab",
      "console_messages",
      "drag",
      "extension_log",
      "get_tab_html",
      "get_tab_text",
      "handle_dialog",
      "hover",
      "list_containers",
      "list_tabs",
      "navigate",
      "navigate_back",
      "navigate_forward",
      "network_requests",
      "open_in_container",
      "open_tab",
      "press_key",
      "reload",
      "resize_viewport",
      "run_js",
      "screenshot_tab",
      "scroll",
      "select_option",
      "snapshot",
      "type",
      "upload_file",
      "wait_for",
      "watch",
    ]);
    expect(
      tools.find((t) => t.name === "list_tabs")?.annotations?.readOnlyHint,
    ).toBe(true);
    expect(
      tools.find((t) => t.name === "get_tab_text")?.inputSchema,
    ).toMatchObject({
      required: ["tabId"],
      properties: { maxChars: { default: 20_000 } },
    });
  });

  test('the MCP pill in the popup header opens Settings at "For AI agents" and shows the bridge status', async ({
    facet,
  }) => {
    const { page: popup } = await openPopup(facet);
    const pill = popup.getByRole("button", { name: /^MCP/ });
    await expect(pill).toBeVisible();
    await expect(pill).toHaveAttribute("title", "AI agents (MCP)");

    const [options] = await Promise.all([
      facet.ctx.waitForEvent("page"),
      pill.click(),
    ]);
    await expect(options).toHaveURL(ext("options.html#agent"));
    const heading = options.getByRole("heading", { name: "For AI agents" });
    await expect(heading).toBeFocused();
    await expect(heading).toBeInViewport();

    // A second press reuses the open Settings tab (and scrolls it back), it does not open another.
    await options.evaluate(() => window.scrollTo(0, 0));
    await options.getByRole("link", { name: "General" }).click();
    await expect.poll(() => popup.isClosed()).toBe(true); // pressing it closes the popup
    const { page: again } = await openPopup(facet);
    const before = facet.ctx.pages().length;
    await again.getByRole("button", { name: /^MCP/ }).click();
    await expect(heading).toBeFocused();
    await expect(heading).toBeInViewport();
    await expect.poll(() => facet.ctx.pages().length).toBe(before - 1); // the popup closed, no second Settings tab

    // Bridge on: a dot appears (purple once connected, amber before). Off: none.
    const { page: view } = await openPopup(facet);
    const pill2 = view.getByRole("button", { name: /^MCP/ });
    await facet.api("updateSettings", { agentBridge: true });
    await expect(view.locator(".fx-mcp__dot")).toHaveCount(1);
    await expect(pill2).toHaveAttribute("data-status", "connected", {
      timeout: 15_000,
    });
    await expect(view.locator(".fx-mcp__dot--on")).toHaveCount(1);
    await expect(pill2).toHaveAccessibleName(/connected/);
    await facet.api("updateSettings", { agentBridge: false });
    await expect(view.locator(".fx-mcp__dot")).toHaveCount(0);
  });

  test('Settings, "For AI agents", turns it on; the popup then shows one row with a counter, and its switch turns it off', async ({
    facet,
  }) => {
    const { page: popup, toggle } = await openPopup(facet);
    await expect(popup.getByTestId("bridge-card")).toHaveCount(0); // off: no agent row

    const options = await facet.ctx.newPage();
    await options.goto(ext("options.html"));
    await expect(
      options.getByRole("heading", { name: "For AI agents" }),
    ).toBeVisible();
    await expect(
      options.getByText(
        "Lets an AI agent on this computer see and use your tabs.",
      ),
    ).toBeVisible();
    const optionsSwitch = options.getByRole("switch", { name: /Agent bridge/ });
    await expect(optionsSwitch).toHaveAttribute("aria-checked", "false");
    await optionsSwitch.click();
    await expect(options.getByTestId("bridge-card")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 15_000 },
    );
    await expect(options.getByTestId("bridge-status")).toContainText(
      "Connected",
    );

    // The popup row appears by itself (it polls) and is one compact line.
    const card = popup.getByTestId("bridge-card");
    await expect(card).toHaveAttribute("data-status", "connected", {
      timeout: 15_000,
    });
    await expect(card).toHaveClass(/fx-bridge--on/);
    await expect(popup.getByTestId("bridge-status")).toContainText(
      "Agent connected — full access",
    );
    await expect(popup.getByTestId("bridge-actions")).toHaveText("0");
    await expect(popup.getByText(/pnpm/)).toHaveCount(0);
    expect(hostPids(facet)).toHaveLength(1);

    mcp = await startMcp(facet);
    await mcp.json("list_containers");
    await mcp.json("list_tabs");
    await expect(popup.getByTestId("bridge-actions")).toHaveText("2");

    // The "what an agent can do" text is one disclosure away.
    const can = options.getByRole("button", { name: /What an agent can do/ });
    await expect(can).toHaveAttribute("aria-expanded", "false");
    await can.click();
    await expect(can).toHaveAttribute("aria-expanded", "true");
    await expect(
      options.getByText(/click, type, scroll and run JavaScript in any tab/),
    ).toBeVisible();

    // Off again, from the popup: connection closed, host gone, tools refuse, the popup row is gone.
    await toggle.click();
    await expect(popup.getByTestId("bridge-card")).toHaveCount(0);
    await expect.poll(() => hostPids(facet), { timeout: 10_000 }).toEqual([]);
    await expect(optionsSwitch).toHaveAttribute("aria-checked", "false");
    const refused = await mcp.call("list_tabs");
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/bridge is off/);
    expect(
      await facet.api<{ agentBridge: boolean }>("getSettings"),
    ).toMatchObject({ agentBridge: false });
    await options.close();
  });

  test("list_tabs shows the tabs of every window with their containers", async ({
    facet,
  }) => {
    const c = await facet.container("Agent");
    const inContainer = await facet.openIn(c.name, at("a.localhost", "/blank"));
    const plain = await facet.plain(at("b.localhost", "/blank"));
    const containerTabId = await facet.tabIdOf(inContainer);
    const plainTabId = await facet.tabIdOf(plain);
    // A second window.
    const second = await facet.inWorker(
      async (url: string) => {
        const w = await (globalThis as any).chrome.windows.create({ url });
        return { windowId: w.id as number, tabId: w.tabs[0].id as number };
      },
      at("sso.localhost", "/blank"),
    );

    await turnOn(facet);
    mcp = await startMcp(facet);

    const all = await tabsOf(mcp);
    const byId = new Map(all.map((t) => [t.tabId, t]));
    const container = byId.get(containerTabId)!;
    expect(container.container).toEqual({ id: c.id, name: c.name });
    expect(container.url).toBe(at("a.localhost", "/blank"));
    expect(container.title).toContain("a.localhost blank");
    expect(typeof container.windowId).toBe("number");
    expect(typeof container.groupId).toBe("number");
    expect(byId.get(plainTabId)!.container).toBeNull();
    const other = byId.get(second.tabId)!;
    expect(other.windowId).toBe(second.windowId);
    expect(other.windowId).not.toBe(container.windowId);
    expect(new Set(all.map((t) => t.windowId)).size).toBeGreaterThanOrEqual(2);

    const inSecond = await tabsOf(mcp, { windowId: second.windowId });
    expect(inSecond.map((t) => t.tabId)).toContain(second.tabId); // (Playwright may have put the popup in that window too)
    expect(inSecond.every((t) => t.windowId === second.windowId)).toBe(true);
    expect(inSecond.length).toBeLessThan(all.length);
    expect(
      (await tabsOf(mcp, { containerId: c.name })).map((t) => t.tabId),
    ).toEqual([containerTabId]);
    expect(
      (await tabsOf(mcp, { containerId: c.id })).map((t) => t.tabId),
    ).toEqual([containerTabId]);
    expect((await mcp.call("list_tabs", { containerId: "nope" })).text).toMatch(
      /no container "nope"/,
    );

    const containers =
      await mcp.json<Array<{ id: string; name: string; tabCount: number }>>(
        "list_containers",
      );
    expect(containers.find((x) => x.id === c.id)).toMatchObject({
      name: c.name,
      tabCount: 1,
    });
  });

  test("open_in_container opens the page in the container: its cookies are on the first request", async ({
    facet,
  }) => {
    const c = await facet.container("Login");
    const login = await facet.openIn(
      c.name,
      at("a.localhost", "/login?user=alice"),
    );
    await expect(login.locator("#user")).toHaveText("alice");
    await turnOn(facet);
    mcp = await startMcp(facet);

    await facet.clearLog();
    const opened = await mcp.json<{
      tabId: number;
      container: { name: string };
      url: string;
      loaded: boolean;
    }>("open_in_container", {
      url: at("a.localhost", "/whoami"),
      container: c.name.toUpperCase(), // names are case-insensitive
    });
    expect(opened.container).toEqual({ id: c.id, name: c.name });
    expect(opened.loaded).toBe(true);
    facet.adopt(await pageFor(facet, opened.tabId));

    const first = (await facet.serverLog()).find(
      (r) => r.host === "a.localhost" && r.path === "/whoami",
    );
    expect(first?.cookie).toMatch(/\bsid=/); // the container's session, already on the very first request
    const text = await mcp.call("get_tab_text", { tabId: opened.tabId });
    expect(text.texts[1]).toContain("alice");

    // A plain tab of the same site has no session.
    const plainId = await openPlain(mcp, at("a.localhost", "/whoami"));
    expect(
      (await mcp.call("get_tab_text", { tabId: plainId })).texts[1],
    ).toContain("anonymous");

    // Unknown container: an error that lists the existing ones, unless it may be created.
    const unknown = await mcp.call("open_in_container", {
      url: at("a.localhost", "/blank"),
      container: "Nowhere",
    });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toMatch(
      /no container "Nowhere".*existing:.*createIfMissing/,
    );
    const made = await mcp.json<{ container: { name: string } }>(
      "open_in_container",
      {
        url: at("a.localhost", "/blank"),
        container: "Made-by-agent",
        createIfMissing: true,
      },
    );
    expect(made.container.name).toBe("Made-by-agent");
    expect(
      (await mcp.json<Array<{ name: string }>>("list_containers")).map(
        (x) => x.name,
      ),
    ).toContain("Made-by-agent");

    expect(
      (
        await mcp.call("open_in_container", {
          url: "ftp://x.test/",
          container: c.name,
        })
      ).text,
    ).toMatch(/not allowed/);
    expect(
      (
        await mcp.call("open_in_container", {
          url: "not a url",
          container: c.name,
        })
      ).text,
    ).toMatch(/not a valid address/);
  });

  test("reads and operates a page: text, html, type, click, submit, scroll, run_js", async ({
    facet,
  }) => {
    await turnOn(facet);
    mcp = await startMcp(facet);
    const tabId = await openPlain(mcp, at("a.localhost", "/agent"));

    const text = await mcp.call("get_tab_text", { tabId });
    expect(JSON.parse(text.texts[0]!)).toMatchObject({
      tabId,
      url: at("a.localhost", "/agent"),
      title: "Agent page",
      truncated: false,
    });
    expect(text.texts[1]).toContain("Agent page");
    expect(text.texts[1]).toContain("bottom");
    const cut = await mcp.call("get_tab_html", { tabId, maxChars: 100 });
    expect(JSON.parse(cut.texts[0]!)).toMatchObject({
      truncated: true,
      selector: null,
    });
    expect(cut.texts[1]!.length).toBe(100);

    const html = await mcp.call("get_tab_html", { tabId, selector: "#title" });
    expect(html.texts[1]).toBe('<h1 id="title">Agent page</h1>');
    expect(
      (await mcp.call("get_tab_html", { tabId, selector: "#nope" })).text,
    ).toMatch(/no element matches "#nope"/);
    expect(
      (await mcp.call("get_tab_html", { tabId, selector: "!!" })).text,
    ).toMatch(/invalid selector/);

    // type: native value setter + input/change events (the page listens to both), click, and the page reacts.
    expect(
      await mcp.json("type", { tabId, selector: "#name", text: "hello" }),
    ).toEqual({ typed: 5 });
    expect(
      await mcp.json("type", {
        tabId,
        selector: "#name",
        text: " world",
        append: true,
      }),
    ).toEqual({ typed: 6 });
    expect(await mcp.json("click", { tabId, selector: "#go" })).toEqual({
      clicked: "<button#go>",
    });
    const after = (await mcp.call("get_tab_text", { tabId })).texts[1]!;
    expect(after).toContain("clicked:hello world");
    expect(after).toContain("input:hello world|change");

    // Coordinates: whatever is at the point.
    const rect = await mcp.json<unknown>("run_js", {
      tabId,
      code: 'const r = document.getElementById("go").getBoundingClientRect(); return [r.x + 2, r.y + 2];',
    });
    const [x, y] = rect as [number, number];
    await mcp.json("type", { tabId, selector: "#name", text: "by-point" });
    await mcp.json("click", { tabId, x, y });
    expect((await mcp.call("get_tab_text", { tabId })).texts[1]).toContain(
      "clicked:by-point",
    );
    expect(
      (await mcp.call("click", { tabId, x: 100000, y: 100000 })).text,
    ).toMatch(/no element at/);
    expect((await mcp.call("click", { tabId })).text).toMatch(
      /selector, or both x and y/,
    );
    expect(
      (await mcp.call("click", { tabId, selector: "#absent" })).text,
    ).toMatch(/no element matches "#absent"/);
    expect(
      (await mcp.call("type", { tabId, selector: "#title", text: "x" })).text,
    ).toMatch(/not a text field/);

    // Scroll.
    const bottom = await mcp.json<{ y: number; maxY: number }>("scroll", {
      tabId,
      to: "bottom",
    });
    expect(bottom.y).toBeGreaterThan(1000);
    expect(
      (await mcp.json<{ y: number }>("scroll", { tabId, to: "top" })).y,
    ).toBe(0);
    expect(
      (await mcp.json<{ y: number }>("scroll", { tabId, dy: 300 })).y,
    ).toBe(300);
    expect(
      (await mcp.json<{ y: number }>("scroll", { tabId, selector: "#bottom" }))
        .y,
    ).toBeGreaterThan(1000);
    expect((await mcp.call("scroll", { tabId })).text).toMatch(
      /give ref, selector, to, or dx\/dy/,
    );

    // run_js: MAIN world sees the page's own variables, async code works, errors come back as errors.
    expect(
      (await mcp.call("run_js", { tabId, code: "return window.pageVar;" }))
        .text,
    ).toBe("42");
    // (run_js never sees an agent-activity mark in document.title: tools that can change the app leave the title alone, see agent-activity.spec.ts)
    expect(
      (
        await mcp.call("run_js", {
          tabId,
          code: 'await new Promise(r => setTimeout(r, 50)); return {a: [1, "two"], t: document.title};',
        })
      ).text,
    ).toBe('{"a":[1,"two"],"t":"Agent page"}');
    expect(
      (await mcp.call("run_js", { tabId, code: 'document.title = "changed";' }))
        .text,
    ).toBe('"changed"'); // an assignment is an expression: its value comes back
    expect(
      (
        await mcp.call("run_js", {
          tabId,
          code: 'document.title = "changed again"; void 0',
        })
      ).text,
    ).toBe("undefined"); // statements, no return: a body
    const thrown = await mcp.call("run_js", {
      tabId,
      code: 'throw new TypeError("boom");',
    });
    expect(thrown.isError).toBe(true);
    expect(thrown.text).toBe("TypeError: boom");
    expect(
      (await mcp.call("run_js", { tabId, code: "return (" })).text,
    ).toMatch(/SyntaxError/);
    const cutJs = await mcp.call("run_js", {
      tabId,
      code: 'return "y".repeat(5000);',
      maxChars: 200,
    });
    expect(cutJs.texts[0]!.length).toBe(200);
    expect(cutJs.texts[1]).toMatch(/truncated to 200/);

    // Submit through the form with Enter semantics.
    await mcp.json("type", {
      tabId,
      selector: "#q",
      text: "cats",
      submit: true,
    });
    await expect
      .poll(
        async () => (await tabsOf(mcp!)).find((t) => t.tabId === tabId)?.url,
        { timeout: 10_000 },
      )
      .toBe(at("a.localhost", "/agent-submit?q=cats"));
    expect((await mcp.call("get_tab_text", { tabId })).texts[1]).toContain(
      "cats",
    );
  });

  test("run_js works on a page that forbids eval (through the debugger); the ISOLATED world is refused", async ({
    facet,
  }) => {
    await turnOn(facet);
    mcp = await startMcp(facet);
    const tabId = await openPlain(mcp, at("a.localhost", "/agent-csp"));
    expect(
      (await mcp.call("run_js", { tabId, code: "return window.pageVar + 1;" }))
        .text,
    ).toBe("43");
    // The other tools do not need eval and still work there.
    expect((await mcp.call("get_tab_text", { tabId })).texts[1]).toContain(
      "Agent page",
    );
    expect(await mcp.json("click", { tabId, selector: "#go" })).toEqual({
      clicked: "<button#go>",
    });
    const isolated = await mcp.call("run_js", {
      tabId,
      code: "return 1;",
      world: "ISOLATED",
    });
    expect(isolated.isError).toBe(true);
    expect(isolated.text).toMatch(/only in the page's own \(MAIN\) world/);
  });

  test("screenshot_tab returns an image of a background tab and puts the active tab back", async ({
    facet,
  }) => {
    await turnOn(facet);
    mcp = await startMcp(facet);
    const first = await openPlain(mcp, at("a.localhost", "/agent"));
    const second = await mcp.json<{ tabId: number; windowId: number }>(
      "open_tab",
      { url: at("b.localhost", "/blank"), active: true },
    );
    expect(
      (await tabsOf(mcp)).find((t) => t.tabId === second.tabId)!.active,
    ).toBe(true);

    const shot = await mcp.call("screenshot_tab", { tabId: first });
    expect(shot.isError).toBe(false);
    expect(shot.images).toHaveLength(1);
    expect(shot.images[0]!.mimeType).toBe("image/png");
    const png = Buffer.from(shot.images[0]!.data, "base64");
    expect([...png.subarray(0, 8)]).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    expect(png.length).toBeGreaterThan(1000);

    const after = await tabsOf(mcp, { windowId: second.windowId });
    expect(after.find((t) => t.tabId === second.tabId)!.active).toBe(true); // restored
    expect(after.find((t) => t.tabId === first)!.active).toBe(false);

    const jpeg = await mcp.call("screenshot_tab", {
      tabId: second.tabId,
      format: "jpeg",
      quality: 50,
    });
    expect(jpeg.images[0]!.mimeType).toBe("image/jpeg");
    expect([
      ...Buffer.from(jpeg.images[0]!.data, "base64").subarray(0, 2),
    ]).toEqual([0xff, 0xd8]);
    expect((await mcp.call("screenshot_tab", { tabId: 999999 })).text).toMatch(
      /no tab with id 999999/,
    );
  });

  test("navigate, activate, assign and close tabs", async ({ facet }) => {
    const c = await facet.container("Move");
    await turnOn(facet);
    mcp = await startMcp(facet);

    const tabId = await openPlain(mcp, at("a.localhost", "/blank"));
    const nav = await mcp.json<{ url: string; title: string; loaded: boolean }>(
      "navigate",
      { tabId, url: at("b.localhost", "/blank") },
    );
    expect(nav).toMatchObject({
      url: at("b.localhost", "/blank"),
      loaded: true,
    });
    expect(
      (await mcp.call("navigate", { tabId, url: "javascript:alert(1)" })).text,
    ).toMatch(/not allowed/);

    // Into the container and out again; the page reloads each time.
    const moved = await mcp.json<{ container: { name: string } | null }>(
      "assign_tab",
      { tabId, container: c.name },
    );
    expect(moved.container).toEqual({ id: c.id, name: c.name });
    expect(
      (await tabsOf(mcp)).find((t) => t.tabId === tabId)!.container,
    ).toEqual({ id: c.id, name: c.name });
    expect(
      (
        await mcp.json<{ container: unknown }>("assign_tab", {
          tabId,
          container: null,
        })
      ).container,
    ).toBeNull();
    expect(
      (await mcp.call("assign_tab", { tabId, container: "Ghost" })).text,
    ).toMatch(/no container "Ghost"/);

    const act = await mcp.json<{ tabId: number }>("activate_tab", { tabId });
    expect(act.tabId).toBe(tabId);
    expect((await tabsOf(mcp)).find((t) => t.tabId === tabId)!.active).toBe(
      true,
    );

    expect(await mcp.json("close_tab", { tabId })).toEqual({
      tabId,
      closed: true,
    });
    expect((await tabsOf(mcp)).some((t) => t.tabId === tabId)).toBe(false);
    expect((await mcp.call("close_tab", { tabId })).text).toMatch(
      /no tab with id/,
    );
  });

  test("validates arguments and answers many clients at once", async ({
    facet,
  }) => {
    await turnOn(facet);
    mcp = await startMcp(facet);
    const other = await startMcp(facet);
    const bad = await mcp.call("close_tab", { tabId: -1 });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/tabId: must be at least 0/);
    expect(
      (await mcp.call("get_tab_text", { tabId: 1, maxChars: 5 })).text,
    ).toMatch(/maxChars: must be at least 100/);
    expect((await mcp.call("type", { tabId: 1, selector: "a" })).text).toMatch(
      /missing required argument "text"/,
    );
    const [a, b] = await Promise.all([
      mcp.json("list_tabs"),
      other.json("list_tabs"),
    ]);
    expect(a).toEqual(b);
    await other.close();
  });

  test("run_js can hand back more than 1 MiB (Chrome only caps what the host sends to the extension)", async ({
    facet,
  }) => {
    await turnOn(facet);
    mcp = await startMcp(facet);
    const tabId = await openPlain(mcp, at("a.localhost", "/blank"));
    const big = await mcp.call("run_js", {
      tabId,
      code: 'return "z".repeat(1500000);',
      maxChars: 2_000_000,
    });
    expect(big.isError).toBe(false);
    expect(big.texts[0]!.length).toBe(1_500_002);
  });

  test('without the host installed the popup says "not connected" with no install text; Settings has the steps and "Check again"', async ({
    facet,
  }) => {
    uninstallHost(facet);
    await facet.api("updateSettings", { agentBridge: true });
    const { page: popup } = await openPopup(facet);
    const card = popup.getByTestId("bridge-card");
    await expect(card).toHaveAttribute("data-status", "host-missing", {
      timeout: 15_000,
    });
    await expect(card).toHaveClass(/fx-bridge--on/); // the switch is still visibly ON
    await expect(card).toContainText("Agent");
    await expect(card).toContainText("not connected");
    await expect(popup.getByText(/pnpm|bridge:install|source/i)).toHaveCount(0);
    await expect(popup.getByTestId("bridge-install")).toHaveCount(0);
    await expect(
      popup.getByRole("button", { name: "Check again" }),
    ).toHaveCount(0);
    await expect(popup.getByTestId("bridge-status")).toContainText(
      "not installed",
    );

    // The gear of the row opens Settings at the agent section.
    const [options] = await Promise.all([
      facet.ctx.waitForEvent("page"),
      popup.getByRole("button", { name: "Agent settings" }).click(),
    ]);
    await options.waitForLoadState();
    expect(options.url()).toBe(`${ext("options.html")}#agent`);
    await expect(
      options.getByRole("heading", { name: "For AI agents" }),
    ).toBeVisible();
    await expect(options.getByTestId("bridge-card")).toHaveAttribute(
      "data-status",
      "host-missing",
    );
    const how = options.getByRole("button", { name: "How to connect" });
    await expect(how).toHaveAttribute("aria-expanded", "false");
    await expect(options.getByTestId("bridge-install-command")).toHaveCount(0);
    await how.click();
    await expect(how).toHaveAttribute("aria-expanded", "true");
    await expect(options.getByTestId("bridge-install-command")).toContainText(
      "npx splitsession-bridge install",
    );
    await expect(options.getByText(/--client codex/).first()).toBeVisible();
    await expect(options.getByText(/Needs Node\.js 20 or newer/)).toBeVisible();
    await expect(
      options.getByRole("link", { name: /full guide on GitHub/ }),
    ).toHaveAttribute(
      "href",
      "https://github.com/Misyuk-T/splitsession/blob/main/docs/agents.md",
    );
    await expect(options.getByTestId("bridge-guide-status")).toContainText(
      "not installed",
    );

    installHost(facet);
    await options.getByRole("button", { name: "Check again" }).click();
    await expect(options.getByTestId("bridge-card")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 15_000 },
    );
    await expect(card).toHaveAttribute("data-status", "connected", {
      timeout: 15_000,
    });
    await expect(
      options.getByRole("button", { name: "Check again" }),
    ).toHaveCount(0);
  });

  test("reconnects when the host process dies, and after the extension worker restarts", async ({
    facet,
  }) => {
    const { popup, card } = await turnOn(facet);
    mcp = await startMcp(facet);
    await mcp.json("list_containers");
    const [pid] = hostPids(facet);
    expect(pid).toBeGreaterThan(0);

    execFileSync("kill", ["-9", String(pid)]);
    await expect
      .poll(() => hostPids(facet).filter((p) => p !== pid).length, {
        timeout: 20_000,
      })
      .toBe(1);
    await expect(card).toHaveAttribute("data-status", "connected", {
      timeout: 20_000,
    });
    await mcp.json("list_containers");

    // The worker stops (Chrome does this when idle; here forced). The popup's next request wakes it, and it reconnects.
    const [pid2] = hostPids(facet);
    await facet.stopServiceWorker(popup);
    await expect
      .poll(() => hostPids(facet).filter((p) => p === pid2).length, {
        timeout: 15_000,
      })
      .toBe(0);
    await expect
      .poll(() => hostPids(facet).filter((p) => p !== pid2).length, {
        timeout: 20_000,
      })
      .toBe(1); // a new host
    await expect(card).toHaveAttribute("data-status", "connected", {
      timeout: 20_000,
    });
    await mcp.json("list_containers");
  });

  test("switching it off while a tool is still running: the action that was already received is not performed", async ({
    facet,
  }) => {
    const { popup } = await turnOn(facet);
    mcp = await startMcp(facet);
    const tabId = await openPlain(mcp, at("a.localhost", "/agent"));
    const page = await pageFor(facet, tabId);
    const out = page.locator("#out");

    // Make the tab lookup that every tool starts with slow, once: the tool is then "received, not yet acting" for 2.5 s.
    const slowOnce = () =>
      facet.inWorker(async (id: number) => {
        const tabs = (globalThis as any).chrome.tabs;
        const real = tabs.get;
        const state = { hit: false };
        (globalThis as any).__slowLookup = {
          state,
          restore: () => (tabs.get = real),
        };
        tabs.get = function (tid: number, ...rest: unknown[]) {
          if (tid !== id || state.hit) return real.call(tabs, tid, ...rest);
          state.hit = true;
          tabs.get = real;
          return new Promise((r) => setTimeout(r, 2500)).then(() =>
            real.call(tabs, tid, ...rest),
          );
        };
      }, tabId);
    const lookupStarted = () =>
      facet.inWorker(
        async () => (globalThis as any).__slowLookup.state.hit as boolean,
        undefined,
      );
    try {
      // Control: the same slow click, switch left on, does happen.
      await slowOnce();
      const slow = await mcp.json("click", { tabId, selector: "#go" });
      expect(slow).toEqual({ clicked: "<button#go>" });
      await expect(out).toHaveText("clicked:");

      // Now switch it off while the click is waiting for its lookup.
      await page.reload();
      await expect(out).toHaveText("");
      await slowOnce();
      const pending = mcp.call("click", { tabId, selector: "#go" });
      await expect.poll(lookupStarted, { timeout: 10_000 }).toBe(true);
      await popup.getByRole("switch", { name: /Agent bridge/ }).click();
      await expect(popup.getByTestId("bridge-card")).toHaveCount(0);
      const answer = await pending;
      expect(answer.isError).toBe(true);
      expect(answer.text).toMatch(/switched off/);

      // The lookup finishes after 2.5 s; the click must not follow it.
      await page.waitForTimeout(3500);
      await expect(out).toHaveText("");
      const log =
        await facet.api<
          Array<{ message: string; data?: Record<string, unknown> }>
        >("getLog");
      const clicks = log.filter(
        (e) => e.message === "agent action" && e.data!.tool === "click",
      );
      expect(clicks.at(-1)!.data).toMatchObject({
        ok: false,
        error: expect.stringMatching(/not performed/),
      });
    } finally {
      await facet
        .inWorker(
          async () => (globalThis as any).__slowLookup?.restore(),
          undefined,
        )
        .catch(() => {});
    }
  });

  test("two Chrome profiles at once: the agent sees both, a tab tool goes to the tab's profile, a new tab needs a profile, and a profile switched off is gone", async ({
    facet,
  }) => {
    const { card } = await turnOn(facet);
    mcp = await startMcp(facet);
    const [firstHost] = hostPids(facet);
    expect(firstHost).toBeGreaterThan(0);

    second = await startSecondProfile(facet);
    await second.api("setBridgeProfileLabel", "Second");
    await second.api("updateSettings", { agentBridge: true });
    const popup2 = await second.popup();
    const card2 = popup2.getByTestId("bridge-card");
    await expect(card2).toHaveAttribute("data-status", "connected", {
      timeout: 20_000,
    });
    await expect(popup2.getByTestId("bridge-status")).toContainText(
      "Agent connected as “Second”",
    );
    // Nobody waits and nobody is taken over: both are connected, each with a host of its own.
    await expect(card).toHaveAttribute("data-status", "connected");
    await expect.poll(() => hostPids(facet).length).toBe(2);
    expect(hostPids(facet)).toContain(firstHost);

    // The first profile has no name yet: with two profiles on, its settings suggest one, and the button leads to the field.
    const options = await facet.ctx.newPage();
    await options.goto(ext("options.html"));
    const hint = options.getByTestId("bridge-name-hint");
    await expect(hint).toContainText("2 Chrome profiles have the bridge on", {
      timeout: 10_000,
    });
    await hint.getByRole("button", { name: "Name this profile" }).click();
    const field = options.getByRole("textbox", { name: "Profile name" });
    await expect(field).toBeFocused();
    await field.fill("First");
    await field.press("Enter");
    await expect(hint).toHaveCount(0);
    await expect(options.getByTestId("bridge-status")).toContainText(
      "Connected as “First”",
    );
    await options.close();

    type Info = {
      profiles: Array<{ profileKey: string; label: string | null }>;
      profileLabel?: string;
    };
    const info = await mcp.json<Info>("bridge_info");
    expect(info.profiles.map((p) => p.label).sort()).toEqual([
      "First",
      "Second",
    ]);
    expect(info.profileLabel).toBeUndefined(); // the one-profile shape is only for one profile

    // A new tab with two profiles on: the agent must say where.
    const ambiguous = await mcp.call("open_in_container", {
      url: at("a.localhost", "/agent"),
      container: "work",
      createIfMissing: true,
    });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.text).toMatch(/Several Chrome profiles/);
    expect(ambiguous.text).toContain('"First"');
    expect(ambiguous.text).toContain('"Second"');
    const { tabId } = await mcp.json<{ tabId: number }>("open_tab", {
      url: at("a.localhost", "/agent"),
      profile: "second",
    });

    type Row = TabRow & { profile: { key: string; label: string | null } };
    const rows = await mcp.json<Row[]>("list_tabs");
    expect(new Set(rows.map((r) => r.profile.label))).toEqual(
      new Set(["First", "Second"]),
    );
    const mine = rows.filter((r) => r.tabId === tabId);
    expect(mine.map((r) => r.profile.label)).toContain("Second");

    // A click on that tab reaches the second profile. Two Chromium processes number their tabs independently, so the
    // first profile may have a tab with the same ID: then the agent is told to name the profile.
    let clicked = await mcp.call("click", { tabId, selector: "#go" });
    if (mine.length > 1) {
      expect(clicked.text).toMatch(/exists in several Chrome profiles/);
      clicked = await mcp.call("click", {
        tabId,
        selector: "#go",
        profile: "Second",
      });
    }
    expect(clicked.isError, clicked.text).toBe(false);
    const page2 = second.ctx.pages().find((p) => p.url().includes("/agent"));
    expect(page2).toBeTruthy();
    await expect(page2!.locator("body")).toContainText("clicked:");
    expect(facet.ctx.pages().some((p) => p.url().includes("/agent"))).toBe(
      false,
    );

    // The second profile switches off: it is gone from the agent's view, and the first is again the only one.
    await popup2.getByRole("switch", { name: /Agent bridge/ }).click();
    await expect(card2).toHaveCount(0);
    await expect
      .poll(async () =>
        (await mcp!.json<Row[]>("list_tabs")).some(
          (r) => r.profile.label === "Second",
        ),
      )
      .toBe(false);
    await expect.poll(() => hostPids(facet)).toEqual([firstHost]);
    const alone = await mcp.json<Info>("bridge_info");
    expect(alone.profiles).toHaveLength(1);
    expect(alone.profileLabel).toBe("First");
    // One profile: opening a tab needs no profile again.
    const plain = await mcp.call("open_tab", { url: "about:blank" });
    expect(plain.isError, plain.text).toBe(false);
    await expect(card).toHaveAttribute("data-status", "connected");
  });

  test("with a bridge program older than the extension it still connects, and Settings asks for an update", async ({
    facet,
  }) => {
    installOldHost(facet);
    await facet.api("updateSettings", { agentBridge: true });
    const options = await facet.ctx.newPage();
    await options.goto(ext("options.html"));
    const card = options.getByTestId("bridge-card");
    await expect(card).toHaveAttribute("data-status", "connected", {
      timeout: 15_000,
    });
    await expect(options.getByTestId("bridge-status")).toContainText(
      "One Chrome profile at a time",
    );
    await expect(options.getByTestId("bridge-update-command")).toContainText(
      "npx splitsession-bridge@latest install",
    );
    await options.close();
  });

  test("the profile name from the options page is what bridge_info reports", async ({
    facet,
  }) => {
    await turnOn(facet);
    mcp = await startMcp(facet);
    expect(
      (await mcp.json<{ profileLabel: string | null }>("bridge_info"))
        .profileLabel,
    ).toBeNull();
    const options = await facet.ctx.newPage();
    await options.goto(ext("options.html"));
    await options.getByRole("button", { name: "Advanced" }).click(); // the profile name is under "Advanced"
    const field = options.getByRole("textbox", { name: "Profile name" });
    await field.fill("Work");
    await field.press("Enter");
    await expect
      .poll(
        async () =>
          (await mcp!.json<{ profileLabel: string | null }>("bridge_info"))
            .profileLabel,
      )
      .toBe("Work");
    await field.fill("");
    await field.blur();
    await expect
      .poll(
        async () =>
          (await mcp!.json<{ profileLabel: string | null }>("bridge_info"))
            .profileLabel,
      )
      .toBeNull();
    await options.close();
  });

  test("the action log records what was done to which site, never what the page said", async ({
    facet,
  }) => {
    await turnOn(facet);
    mcp = await startMcp(facet);
    const tabId = await openPlain(mcp, at("a.localhost", "/agent"));
    await mcp.json("type", {
      tabId,
      selector: "#name",
      text: "secret-typed-text",
    });
    await mcp.call("get_tab_text", { tabId });
    await mcp.call("click", { tabId, selector: "#absent" });

    const log = await facet.api<
      Array<{
        message: string;
        level: string;
        data?: Record<string, unknown>;
      }>
    >("getLog");
    const actions = log.filter((e) => e.message === "agent action");
    const tools = actions.map((e) => e.data!.tool);
    expect(tools).toEqual(
      expect.arrayContaining(["open_tab", "type", "get_tab_text", "click"]),
    );
    const click = actions.find(
      (e) => e.data!.tool === "click" && e.data!.tabId === tabId,
    )!;
    expect(click.data).toMatchObject({
      tabId,
      host: `a.localhost:${new URL(at("a.localhost")).port}`,
      ok: false,
    });
    expect(click.level).toBe("warn");
    const serialized = JSON.stringify(log);
    expect(serialized).not.toContain("secret-typed-text");
    expect(serialized).not.toContain("Agent page");

    // extension_log hands an agent the same entries (read-only, filterable, newest last).
    const seen = await mcp.json<
      Array<{ time: string; level: string; message: string; data?: string }>
    >("extension_log", { contains: "agent action", level: "warn" });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((e) => e.level === "warn")).toBe(true);
    expect(seen.at(-1)).toMatchObject({ message: "agent action" });
    expect(seen.at(-1)!.data).toContain('"tool":"click"');
    expect(Number.isNaN(Date.parse(seen[0]!.time))).toBe(false);
    const one = await mcp.json<unknown[]>("extension_log", {
      contains: "agent action",
      limit: 1,
    });
    expect(one).toHaveLength(1);
    expect(JSON.stringify(seen)).not.toContain("secret-typed-text");
  });

  test("tabs the agent opens go to the agents' window (one window, reused, rebuilt after the user closes it); an explicit windowId wins; with the setting off they open in the current window", async ({
    facet,
  }) => {
    await turnOn(facet);
    mcp = await startMcp(facet);
    const c = await facet.container("agentwin");
    const userWindow = await facet.inWorker(
      async () =>
        (await (globalThis as any).chrome.windows.getAll())[0].id as number,
      undefined,
    );
    await facet.api("updateSettings", { agentWindow: true });

    const first = await mcp.json<{ tabId: number; windowId: number }>(
      "open_tab",
      { url: at("a.localhost", "/agent") },
    );
    expect(first.windowId).not.toBe(userWindow);
    const second = await mcp.json<{
      tabId: number;
      windowId: number;
      container: { name: string } | null;
    }>("open_in_container", {
      url: at("a.localhost", "/agent"),
      container: c.name,
    });
    expect(second.windowId).toBe(first.windowId); // one window, reused
    expect(second.container?.name).toBe(c.name);

    // The window holds just the agent's two tabs (the blank tab a new window starts with is gone), and the container's
    // tab group is in that window.
    await expect
      .poll(
        async () => (await tabsOf(mcp!, { windowId: first.windowId })).length,
      )
      .toBe(2);
    const inAgentWindow = await tabsOf(mcp, { windowId: first.windowId });
    const containerTab = inAgentWindow.find((t) => t.tabId === second.tabId)!;
    expect(containerTab.groupId).not.toBe(-1);
    expect(await facet.groupInfo(containerTab.groupId)).toMatchObject({
      windowId: first.windowId,
    });

    // An explicit windowId always wins.
    const explicit = await mcp.json<{ windowId: number }>("open_tab", {
      url: at("a.localhost", "/agent"),
      windowId: userWindow,
    });
    expect(explicit.windowId).toBe(userWindow);

    // The user closes the agents' window: the next open makes a new one.
    await facet.inWorker(
      (id: number) => (globalThis as any).chrome.windows.remove(id),
      first.windowId,
    );
    const rebuilt = await mcp.json<{ windowId: number }>("open_tab", {
      url: at("a.localhost", "/agent"),
    });
    expect(rebuilt.windowId).not.toBe(first.windowId);
    expect(rebuilt.windowId).not.toBe(userWindow);

    // Off: today's behaviour, the current window.
    await facet.api("updateSettings", { agentWindow: false });
    const off = await mcp.json<{ windowId: number }>("open_tab", {
      url: at("a.localhost", "/agent"),
    });
    expect(off.windowId).toBe(userWindow);
    const offContainer = await mcp.json<{ windowId: number }>(
      "open_in_container",
      { url: at("a.localhost", "/agent"), container: c.name },
    );
    expect(offContainer.windowId).toBe(userWindow);
  });

  test("list_tabs marks the tab the user looks at (focused) whichever of the user's and the agents' window has the focus, and tags the agents' window's tabs", async ({
    facet,
  }) => {
    await turnOn(facet);
    mcp = await startMcp(facet);
    await facet.api("updateSettings", { agentWindow: true });
    const userWindow = await facet.inWorker(
      async () =>
        (await (globalThis as any).chrome.windows.getAll())[0].id as number,
      undefined,
    );
    const opened = await mcp.json<{ tabId: number; windowId: number }>(
      "open_tab",
      { url: at("a.localhost", "/agent") },
    );
    expect(opened.windowId).not.toBe(userWindow);
    const focusWindow = (id: number) =>
      facet.inWorker(
        (w: number) =>
          (globalThis as any).chrome.windows.update(w, { focused: true }),
        id,
      );
    const m = mcp;
    for (const win of [userWindow, opened.windowId, userWindow]) {
      await focusWindow(win);
      await expect
        .poll(async () => {
          const rows = (await tabsOf(m)) as Array<
            TabRow & { focused?: boolean; agentWindow?: boolean }
          >;
          const focused = rows.filter((t) => t.focused);
          return {
            n: focused.length,
            inUser: focused[0]?.windowId === userWindow,
            active: focused[0]?.active,
            agentTagged: rows
              .filter((t) => t.agentWindow)
              .every((t) => t.windowId === opened.windowId),
          };
        })
        .toEqual({ n: 1, inUser: true, active: true, agentTagged: true });
    }
    await facet.api("updateSettings", { agentWindow: false });
  });

  test("actions on one site are spaced 1.5 s apart across the whole profile, other sites and reads do not wait", async ({
    facet,
  }) => {
    // The main profile runs its host without pacing (fixtures); a second profile's host has the default gap.
    second = await startSecondProfile(facet);
    await second.api("updateSettings", { agentBridge: true });
    await expect(
      (await second.popup()).getByTestId("bridge-card"),
    ).toHaveAttribute("data-status", "connected", { timeout: 20_000 });
    mcp = await startMcp(facet);
    const opened = await mcp.json<{ tabId: number }>("open_tab", {
      url: at("a.localhost", "/agent"),
    });
    const other = await mcp.json<{ tabId: number }>("open_tab", {
      url: at("b.localhost", "/agent"),
    });
    const timed = async (tool: string, args: Record<string, unknown>) => {
      const r = await mcp!.call(tool, args);
      expect(r.isError, r.text).toBe(false);
      return Date.now();
    };
    const [n1, n2, n3, otherSite, read] = await Promise.all([
      timed("navigate", {
        tabId: opened.tabId,
        url: at("a.localhost", "/agent?1"),
        wait: false,
      }),
      timed("navigate", {
        tabId: opened.tabId,
        url: at("a.localhost", "/agent?2"),
        wait: false,
      }),
      timed("reload", { tabId: opened.tabId, wait: false }),
      timed("navigate", {
        tabId: other.tabId,
        url: at("b.localhost", "/agent?1"),
        wait: false,
      }),
      timed("get_tab_text", { tabId: opened.tabId }),
    ]);
    const sameSite = [n1, n2, n3].sort((x, y) => x - y);
    expect(sameSite[1]! - sameSite[0]!).toBeGreaterThanOrEqual(1400);
    expect(sameSite[2]! - sameSite[1]!).toBeGreaterThanOrEqual(1400);
    expect(otherSite).toBeLessThan(sameSite[2]! - 1000); // not queued behind the other site
    expect(read).toBeLessThan(sameSite[2]! - 1000);
  });
});

/** The Playwright page of a tab that SplitSession or the bridge opened (so the test closes it afterwards). */
async function pageFor(facet: Facet, tabId: number): Promise<Page> {
  for (let i = 0; i < 50; i++) {
    for (const page of facet.ctx.pages()) {
      if (page.isClosed()) continue;
      if (
        /^http/.test(page.url()) &&
        (await facet.tabIdOf(page).catch(() => -1)) === tabId
      )
        return page;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no page for tab ${tabId}`);
}
