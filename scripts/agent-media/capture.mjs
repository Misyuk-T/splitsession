// The real pictures behind docs/media/agent-bridge.png (see ../agent-media.mjs): the REAL Full extension with the agent
// bridge on, driven by a REAL MCP client that starts the bridge's stdio server the way an AI client would. The demo
// social network (Loop) runs in two containers, and the tool calls the terminal panel shows are the calls made here.
/* eslint-disable import/extensions -- local .mjs modules, run directly by node */
/* global chrome -- the callbacks of worker.evaluate run inside the extension's service worker */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chromium } from "@playwright/test";

import { RASTER } from "../readme-media/capture.mjs";
import { startDemoSite } from "../store-assets/demo-site.mjs";

const PORT = 47403;
/** The page area of the drawn window (CSS pixels): the viewport of the captured tab. */
export const VIEWPORT = { width: 870, height: 550 };
const HANDLE = { brand: "northwind_studio", personal: "dana" };
export const REPLY =
  "@priya_n Thanks! Good catch, the empty state will say what to do next.";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {string} root repository root
 * @param {object} [options]
 * @param {string} [options.extension] built extension folder (default: the Full build, `.output/chrome-mv3`)
 * @param {{width: number, height: number}} [options.viewport] page area of the captured tab, CSS pixels
 * @param {boolean} [options.consent] grant the bridge's consent first (the store build asks for it)
 * @param {number} [options.scale] device scale factor of the pictures (default 2)
 * @param {boolean} [options.frames] also return `frames`: the brand tab after each tool call (png, the pill's verb, the
 *   tab strip and the toolbar dot at that moment), for scripts/agent-gif.mjs
 * @returns the 2x picture of the brand tab while the agent works in it, the tab strip as Chrome has it, the toolbar dot,
 *   the favicon the extension drew, and the answers of the tool calls
 */
export async function captureAgent(root, options = {}) {
  const extension = options.extension ?? resolve(root, ".output/chrome-mv3");
  const viewport = options.viewport ?? VIEWPORT;
  const bridge = resolve(root, "bridge/dist/splitsession-bridge.mjs");
  const server = await startDemoSite(PORT);
  const profile = mkdtempSync(resolve(tmpdir(), "splitsession-agent-"));
  const nativeHosts = resolve(profile, "NativeMessagingHosts");
  mkdirSync(nativeHosts);
  // Unix socket paths are short on macOS: a short folder directly under /tmp.
  const socketDir = mkdtempSync("/tmp/fb-");
  const socket = resolve(socketDir, "bridge.sock");
  // The host manifest goes into this run's browser profile only: nothing in the user's own Chrome is touched.
  execFileSync(
    process.execPath,
    [
      resolve(root, "scripts/bridge-install.mjs"),
      "--dir",
      nativeHosts,
      "--host-dir",
      resolve(profile, "facet-host"),
      "--no-build",
    ],
    { stdio: "pipe" },
  );
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    deviceScaleFactor: options.scale ?? 2,
    viewport,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      `--host-resolver-rules=MAP *.example 127.0.0.1:${PORT}`,
      ...RASTER,
    ],
    env: { ...process.env, FACET_BRIDGE_SOCKET: socket },
  });
  let mcp = null;
  try {
    const worker =
      ctx.serviceWorkers()[0] ??
      (await ctx.waitForEvent("serviceworker", { timeout: 15_000 }));
    const api = (method, ...args) =>
      worker.evaluate(([m, a]) => globalThis.facet[m](...a), [method, args]);
    await api("listContainers");

    const personal = await api("createContainer", {
      name: "Personal",
      color: "green",
    });
    const brand = await api("createContainer", {
      name: "Brand",
      color: "blue",
    });
    const open = async (user, container) => {
      const created = ctx.waitForEvent("page");
      const tabId = await api(
        "openInContainer",
        `http://loop.example/login?user=${HANDLE[user]}`,
        container.id,
        { active: user === "brand" },
      );
      const page = await created;
      await page.waitForURL((u) => u.href === "http://loop.example/", {
        timeout: 15_000,
      });
      await page.waitForLoadState("load");
      return { tabId, page };
    };
    await open("personal", personal);
    const brandTab = await open("brand", brand);
    // The ordinary tab (no container) of the story's tab list.
    const plain = await ctx.newPage();
    await plain.goto("http://notes.example/");
    for (const p of ctx.pages()) if (p.url() === "about:blank") await p.close();
    await brandTab.page.bringToFront();
    // The bridge: the setting (Settings, "Agent bridge"), then the MCP server connects.
    if (options.consent) {
      // The version of the disclosure text, read from its source (node cannot import the .ts file).
      const version = Number(
        /BRIDGE_CONSENT_VERSION = (\d+)/.exec(
          readFileSync(resolve(root, "src/core/bridge-consent.ts"), "utf8"),
        )?.[1],
      );
      if (!version) throw new Error("BRIDGE_CONSENT_VERSION not found");
      await api("grantBridgeConsent", version);
    }
    await api("updateSettings", { agentBridge: true, agentActivity: true });
    const client = new Client({ name: "agent", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [bridge, "mcp"],
        env: {
          ...process.env,
          FACET_BRIDGE_SOCKET: socket,
          FACET_BRIDGE_MANIFEST_DIRS: nativeHosts,
        },
        stderr: "pipe",
      }),
    );
    mcp = client;
    const call = async (name, args = {}) => {
      const r = await client.callTool({ name, arguments: args });
      const text = r.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      if (r.isError) throw new Error(`${name}: ${text}`);
      return text;
    };
    for (let i = 0; ; i++) {
      try {
        await call("list_tabs");
        break;
      } catch (e) {
        if (i > 40) throw e;
        await sleep(500);
      }
    }
    await sleep(1500); // no activity of the setup may linger on the tabs

    const calls = [];
    const frames = []; // options.frames: the brand tab after each step (the animation's pictures)
    const verbOf = (text) =>
      /(?:Agent|-[0-9a-f]{4}): (.+)$/.exec(text)?.[1] ?? "";
    // The glow breathes (35 % to 100 % opacity, 2.8 s a cycle, on the wall clock): a picture is taken at the top of a
    // breath, once the pill has faded in (about 0.5 s) and well before the action layer goes (about 3.5 s after the action).
    const glow = (id) =>
      worker.evaluate(async (tid) => {
        const [r] = await chrome.scripting.executeScript({
          target: { tabId: tid, frameIds: [0] },
          world: "ISOLATED",
          func: () => {
            const s = globalThis.__facetAgentActivity;
            return s?.steady?.isConnected
              ? Number(getComputedStyle(s.steady).opacity)
              : 0;
          },
        });
        return r.result;
      }, id);
    const overlayOf = (id) =>
      worker.evaluate(async (tid) => {
        const [r] = await chrome.scripting.executeScript({
          target: { tabId: tid, frameIds: [0] },
          world: "ISOLATED",
          func: () => {
            const s = globalThis.__facetAgentActivity;
            return {
              text: s?.shadow?.textContent ?? "",
              boosted: !!s?.boosted,
            };
          },
        });
        return r.result;
      }, id);
    const atFullGlow = async (id) => {
      await sleep(300);
      const until = Date.now() + 2900;
      while (Date.now() < until) {
        if ((await glow(id)) < 0.94) {
          await sleep(30);
          continue;
        }
        const taken = await brandTab.page
          .screenshot({ timeout: 3000 })
          .catch(() => null);
        if (taken && (await glow(id)) > 0.88) return taken;
      }
      throw new Error("no screenshot of the brand tab at a full glow");
    };
    // What Chrome has in the tab strip and on the toolbar button right now.
    const chromeNow = async (id, needFavicon) => {
      const favicon = await brandTab.page.evaluate(
        () => document.querySelector('link[rel~="icon"]')?.href ?? null,
      );
      if (needFavicon && !favicon)
        throw new Error("no favicon on the brand tab");
      const state = await worker.evaluate(async (tid) => {
        const webTabs = (await chrome.tabs.query({})).filter((t) =>
          t.url.startsWith("http"),
        );
        const groups = await chrome.tabGroups.query({});
        return {
          tabs: webTabs,
          groups,
          badge: {
            text: await chrome.action.getBadgeText({ tabId: tid }),
            color: await chrome.action.getBadgeBackgroundColor({ tabId: tid }),
          },
        };
      }, id);
      const strip = [
        ...state.groups.map((g) => {
          const ts = state.tabs
            .filter((t) => t.groupId === g.id)
            .sort((x, y) => x.index - y.index);
          return {
            type: "group",
            title: g.title ?? "",
            color: g.color,
            index: Math.min(...ts.map((t) => t.index)),
            tabs: ts.map((t) => ({
              title: t.title,
              host: new URL(t.url).host,
              active: t.id === id,
              icon: t.id === id ? favicon : null,
            })),
          };
        }),
        ...state.tabs
          .filter((t) => t.groupId < 0)
          .map((t) => ({
            type: "tab",
            index: t.index,
            title: t.title,
            host: new URL(t.url).host,
            active: false,
          })),
      ]
        .filter((g) => g.type === "tab" || g.tabs.length > 0)
        .sort((x, y) => x.index - y.index);
      return { strip, badge: state.badge };
    };
    const grab = async (name, id, active) => {
      const png = active
        ? await atFullGlow(id)
        : await brandTab.page.screenshot({ timeout: 3000 });
      const overlay = await overlayOf(id);
      frames.push({
        name,
        png,
        pill: verbOf(overlay.text),
        ...(await chromeNow(id, active)),
      });
      return { png, overlay };
    };

    const step = async (label, name, args) => {
      const text = await call(name, args);
      calls.push({ label, name, args, text });
      return text;
    };
    if (options.frames) await grab("idle", brandTab.tabId, false);
    const tabs = JSON.parse(await step("list", "list_tabs"));
    const brandRow = tabs.find((t) => t.container?.name === "Brand");
    const tabId = brandRow.tabId;
    if (tabId !== brandTab.tabId) throw new Error("list_tabs: wrong Brand tab");
    if (options.frames) await grab("list_tabs", tabId, false);
    const snap = await step("snapshot", "snapshot", { tabId });
    if (options.frames) await grab("snapshot", tabId, true);
    const ref = (re) => snap.match(re)?.[1];
    const box = ref(/textbox "What's new\?" \[ref=(e\d+)\]/);
    const post = ref(/button "Post" \[ref=(e\d+)\]/);
    if (!box || !post) throw new Error(`composer not found:\n${snap}`);
    await step("type", "type", { tabId, ref: box, text: REPLY });
    if (options.frames) await grab("type", tabId, true);
    await step("click", "click", { tabId, ref: post });
    // The click posts a form: wait until the new feed (with the reply in it) is there, so the next tool lands on that page.
    await brandTab.page.waitForFunction(
      (text) =>
        document.body.innerText.includes(text) &&
        document.readyState === "complete",
      REPLY.slice(0, 30),
    );
    if (options.frames) await grab("click", tabId, true);
    // The last step is a read: the pill says "Agent: reading", with the eye.
    await step("verify", "get_tab_text", { tabId });
    const last = await grab("get_tab_text", tabId, true);
    if (
      !last.overlay.boosted ||
      !/^[\w .-]*(Agent|-[0-9a-f]{4}): reading$/.test(last.overlay.text)
    )
      throw new Error(
        `the overlay is not showing: ${JSON.stringify(last.overlay)}`,
      );
    const now = frames[frames.length - 1];
    return {
      shot: last.png,
      strip: now.strip,
      badge: now.badge,
      calls,
      tabs,
      frames,
    };
  } finally {
    await mcp?.close().catch(() => undefined);
    await api0(ctx).catch(() => undefined);
    await ctx.close().catch(() => undefined);
    server.close();
    rmSync(profile, { recursive: true, force: true });
    rmSync(socketDir, { recursive: true, force: true });
  }
}

async function api0(ctx) {
  const worker = ctx.serviceWorkers()[0];
  if (worker)
    await worker.evaluate(() =>
      globalThis.facet.updateSettings({ agentBridge: false }),
    );
}
