import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type BrowserContext, chromium, expect, test } from "@playwright/test";

import { TOOLS } from "../src/bridge/spec";
import { BRIDGE_CONSENT_VERSION } from "../src/core/bridge-consent";
import { hostPids, installHost, type Mcp, startMcp } from "./bridge-helpers";
import { at, EXTENSION_ID, TEST_PORT } from "./env";
import { apiOf, extensionArgs, isOurWorker } from "./extension";
import type { Facet } from "./fixtures";

/**
 * The store build of Full in basic mode (docs/decisions.md, "The store item becomes Full"): no `debugger`, `nativeMessaging`
 * optional. Built here with the pinned key (FACET_TEST_KEY) so the native host's allowed origin matches, in two flavours:
 * the real store manifest (permission not granted: headless Chrome cannot accept a prompt), and the test hook
 * FACET_TEST_GRANT_NM=1 that makes `nativeMessaging` required, so the bridge can run through the real host and the MCP server.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLAIN_OUT = path.join(ROOT, ".output/store-basic-plain");
const GRANT_OUT = path.join(ROOT, ".output/store-basic-grant");
const PLAIN_PATH = path.join(PLAIN_OUT, "chrome-mv3");
const GRANT_PATH = path.join(GRANT_OUT, "chrome-mv3");

/** What a store build serves: the whole spec minus what needs the debugger. */
const UNSERVED = [
  "run_js",
  "handle_dialog",
  "watch",
  "console_messages",
  "network_requests",
  "resize_viewport",
  "hover",
  "drag",
  "press_key",
  "upload_file",
];
const SERVED = TOOLS.map((t) => t.name)
  .filter((n) => !UNSERVED.includes(n))
  .sort();

let buildError = "";
const dirs: string[] = [];
const contexts: BrowserContext[] = [];

test.beforeAll(() => {
  test.setTimeout(120_000);
  const key = readFileSync(path.join(ROOT, "extension-key.pub"), "utf8").trim();
  try {
    for (const [out, grant] of [
      [PLAIN_OUT, false],
      [GRANT_OUT, true],
    ] as const)
      execFileSync("pnpm", ["exec", "wxt", "build"], {
        cwd: ROOT,
        stdio: "ignore",
        env: {
          ...process.env,
          FACET_EDITION: "store",
          FACET_OUT_DIR: out,
          FACET_TEST_KEY: key,
          ...(grant ? { FACET_TEST_GRANT_NM: "1" } : {}),
        },
      });
  } catch (error) {
    buildError = String(error);
  }
});

test.afterAll(async () => {
  for (const c of contexts) await c.close().catch(() => {});
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  rmSync(PLAIN_OUT, { recursive: true, force: true });
  rmSync(GRANT_OUT, { recursive: true, force: true });
});

/** A profile of its own for one store build, shaped like the fixture's so the bridge helpers work on it. */
async function start(extensionPath: string) {
  const userDataDir = mkdtempSync(path.join(tmpdir(), "facet-store-basic-"));
  const socketDir = mkdtempSync(path.join("/tmp", "fb-"));
  dirs.push(userDataDir, socketDir);
  const nativeHostsDir = path.join(userDataDir, "NativeMessagingHosts");
  mkdirSync(nativeHostsDir);
  const profile = {
    userDataDir,
    nativeHostsDir,
    hostDir: path.join(userDataDir, "facet-host"),
    socketPath: path.join(socketDir, "bridge.sock"),
  };
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: !process.env.HEADED,
    args: extensionArgs(extensionPath),
    env: {
      ...(process.env as Record<string, string>),
      FACET_BRIDGE_SOCKET: profile.socketPath,
      SPLITSESSION_SITE_GAP_MS: "0",
    },
  });
  contexts.push(ctx);
  const worker =
    ctx.serviceWorkers().find(isOurWorker) ??
    (await ctx.waitForEvent("serviceworker", {
      predicate: isOurWorker,
      timeout: 15_000,
    }));
  const api = apiOf(worker);
  await api("listContainers"); // the worker is ready
  return { ctx, worker, api, facet: { profile, ctx } as unknown as Facet };
}

test.describe("store build, basic mode", () => {
  test("the real store manifest: no debugger, no required nativeMessaging, no CDP in the worker; the bridge cannot be switched on without the permission", async () => {
    test.skip(buildError !== "", `build failed: ${buildError}`);
    const { worker, api } = await start(PLAIN_PATH);
    const manifest = await worker.evaluate(() =>
      (globalThis as any).chrome.runtime.getManifest(),
    );
    expect(manifest.permissions).not.toContain("debugger");
    expect(manifest.permissions).not.toContain("nativeMessaging");
    expect(manifest.optional_permissions).toEqual(["nativeMessaging"]);
    expect(
      await worker.evaluate(() => {
        const c = (globalThis as any).chrome;
        return [typeof c.debugger, typeof c.runtime.connectNative];
      }),
    ).toEqual(["undefined", "undefined"]); // Chrome leaves both out until the permission is granted
    expect(await worker.evaluate(() => "facetCdp" in globalThis)).toBe(false);
    expect(
      await worker.evaluate(() =>
        (globalThis as any).chrome.permissions.contains({
          permissions: ["nativeMessaging"],
        }),
      ),
    ).toBe(false);

    // Consent alone is not enough: the settings store refuses the switch without Chrome's permission.
    await api("grantBridgeConsent", BRIDGE_CONSENT_VERSION);
    await expect(api("updateSettings", { agentBridge: true })).rejects.toThrow(
      /permission to talk to a program on this computer/,
    );
    expect(await api("getSettings")).toMatchObject({ agentBridge: false });
    expect(await api("getBridgeState")).toMatchObject({ status: "off" });
  });

  test("the options switch asks Chrome for the permission; a refusal leaves the bridge off with a message (no native dialog)", async () => {
    test.skip(buildError !== "", `build failed: ${buildError}`);
    const { ctx, api } = await start(PLAIN_PATH);
    await api("grantBridgeConsent", BRIDGE_CONSENT_VERSION);
    const options = await ctx.newPage();
    await options.goto(`chrome-extension://${EXTENSION_ID}/options.html`);
    await options.bringToFront();
    const toggle = options.getByRole("switch", { name: /Agent bridge/ });
    await expect(toggle).toBeVisible();
    // Headless Chrome cannot accept or refuse a prompt (the request waits forever), so the page's answer is set by hand.
    await options.evaluate(() => {
      const p = (globalThis as any).chrome.permissions;
      (globalThis as any).__asked = [];
      p.request = async (req: unknown) => {
        (globalThis as any).__asked.push(req);
        return false;
      };
    });
    await toggle.click();
    // Chrome said no: the page says so, nothing is recorded, the bridge stays off.
    await expect(options.getByRole("alert")).toContainText(
      /did not give SplitSession permission/,
      { timeout: 20_000 },
    );
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(await options.evaluate(() => (globalThis as any).__asked)).toEqual([
      { permissions: ["nativeMessaging"] },
    ]);
    expect(await api("getSettings")).toMatchObject({ agentBridge: false });
    expect(await api("getBridgeState")).toMatchObject({ status: "off" });
  });

  test("with nativeMessaging granted: the real host serves the basic tools, lists no others, and says what is missing", async () => {
    test.skip(buildError !== "", `build failed: ${buildError}`);
    test.setTimeout(120_000);
    const { ctx, api, facet } = await start(GRANT_PATH);
    installHost(facet);
    await api("grantBridgeConsent", BRIDGE_CONSENT_VERSION);
    await api("updateSettings", { agentBridge: true });
    await expect
      .poll(
        async () => (await api<{ status: string }>("getBridgeState")).status,
        {
          timeout: 15_000,
        },
      )
      .toBe("connected");
    const mcp: Mcp = await startMcp(facet);
    try {
      // The tools/list follows what the extension serves.
      const { tools } = await mcp.client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(SERVED);

      const info = await mcp.json<{
        mode: string;
        notAvailable: string[];
        basicMode: string;
        extensionVersion: string;
      }>("bridge_info");
      expect(info.mode).toBe("basic");
      expect([...info.notAvailable].sort()).toEqual([...UNSERVED].sort());
      expect(info.basicMode).toMatch(/unpacked Full/);

      // Reading and acting on a page, by ref from the snapshot.
      const { tabId } = await mcp.json<{ tabId: number }>("open_tab", {
        url: at("a.localhost", "/agent"),
      });
      await mcp.json("activate_tab", { tabId });

      // A tool that is not served answers with a clear error (an older host lists it anyway).
      const runJs = await mcp.call("run_js", { tabId, code: "1" });
      expect(runJs.isError).toBe(true);
      expect(runJs.text).toMatch(/not available in basic mode/);

      const snap = await mcp.call("snapshot", { tabId });
      expect(snap.isError, snap.text).toBe(false);
      const refOf = (re: RegExp) => {
        const m = re.exec(snap.text);
        expect(m, `no ${re} in\n${snap.text}`).not.toBeNull();
        return m![1]!;
      };
      const goRef = refOf(/button "Go" \[ref=(e\d+)\]/);
      const nameRef = refOf(/textbox[^\n]*\[ref=(e\d+)\]/);
      const typed = await mcp.call("type", {
        tabId,
        ref: nameRef,
        text: "basic",
      });
      expect(typed.isError, typed.text).toBe(false);
      const clicked = await mcp.call("click", { tabId, ref: goRef });
      expect(clicked.isError, clicked.text).toBe(false);
      await expect
        .poll(async () => (await mcp.call("get_tab_text", { tabId })).text)
        .toContain("clicked:basic");
      expect((await mcp.call("get_tab_text", { tabId })).text).toContain(
        "input:basic",
      );
      const waited = await mcp.call("wait_for", { tabId, text: "bottom" });
      expect(waited.isError, waited.text).toBe(false);
      const scrolled = await mcp.json<{ y: number }>("scroll", {
        tabId,
        to: "bottom",
      });
      expect(scrolled.y).toBeGreaterThan(0);

      // A <select> on another page, by ref.
      await mcp.json("navigate", { tabId, url: at("a.localhost", "/cdp") });
      const cdpSnap = await mcp.call("snapshot", { tabId });
      const selectRef = /combobox[^\n]*\[ref=(e\d+)\]/.exec(cdpSnap.text)?.[1];
      expect(selectRef, cdpSnap.text).toBeTruthy();
      expect(
        await mcp.json("select_option", {
          tabId,
          ref: selectRef,
          values: ["m"],
        }),
      ).toEqual({ selected: ["m"] });

      // Screenshots: the tab on show only.
      const shot = await mcp.call("screenshot_tab", { tabId });
      expect(shot.isError, shot.text).toBe(false);
      expect(shot.images).toHaveLength(1);
      const full = await mcp.call("screenshot_tab", { tabId, fullPage: true });
      expect(full.isError).toBe(true);
      expect(full.text).toMatch(/fullPage needs full mode/);

      // Back on a container tab is refused (its target cannot be prepared without the debugger); navigate still works there.
      const inBox = await mcp.json<{ tabId: number }>("open_in_container", {
        url: at("a.localhost", "/agent"),
        container: "Basic",
        createIfMissing: true,
      });
      const back = await mcp.call("navigate_back", { tabId: inBox.tabId });
      expect(back.isError).toBe(true);
      expect(back.text).toMatch(/container tab needs full mode/);
      await mcp.json("navigate", {
        tabId: inBox.tabId,
        url: at("a.localhost", "/agent?again"),
      });

      // No debugger was ever attached.
      expect(
        await ctx
          .serviceWorkers()
          .find(isOurWorker)!
          .evaluate(() => typeof (globalThis as any).chrome.debugger),
      ).toBe("undefined");
    } finally {
      await mcp.close().catch(() => {});
      await api("updateSettings", { agentBridge: false });
    }
    await expect.poll(() => hostPids(facet), { timeout: 10_000 }).toEqual([]);
  });

  test("granted after the worker started (simulated): switching on asks for one restart of the extension, the next start reopens the options page at For AI agents, a second restart is never asked for, and the bridge connects once the API is there", async () => {
    test.skip(buildError !== "", `build failed: ${buildError}`);
    test.setTimeout(120_000);
    // Chromium cannot really reload a command-line extension (`runtime.reload()` unloads it for good, headless or not), so the
    // reload is counted instead and the next worker start is run by hand on the same worker (`facetNativeRestart`, test build only).
    const { ctx, worker, api, facet } = await start(GRANT_PATH);
    installHost(facet);
    await api("grantBridgeConsent", BRIDGE_CONSENT_VERSION);
    await worker.evaluate(() => {
      const g = globalThis as any;
      g.__reloads = 0;
      g.chrome.runtime.reload = () => void g.__reloads++;
      g.__facetTestNmHidden = true; // behaves like a worker that started before the grant
    });
    const reloads = () =>
      worker.evaluate(() => (globalThis as any).__reloads as number);
    const local = (key: string) =>
      worker.evaluate(
        async (k) =>
          ((await (globalThis as any).chrome.storage.local.get(k)) as any)[k],
        key,
      );

    // Switching on: consent and the setting are stored first, then the one restart is asked for, with an honest status.
    await api("updateSettings", { agentBridge: true });
    await expect.poll(reloads).toBe(1);
    expect(await api("getSettings")).toMatchObject({ agentBridge: true });
    expect(await api("getBridgeState")).toMatchObject({
      status: "error",
      error: expect.stringContaining("restarts once"),
    });
    expect(typeof (await local("bridgeNativeRestart"))).toBe("number");

    // The next worker: the marker is consumed and the options page opens at "For AI agents" (the reload closed the old one).
    await worker.evaluate(() => (globalThis as any).facetNativeRestart.start());
    expect(await local("bridgeNativeRestart")).toBeUndefined();
    await expect
      .poll(() => ctx.pages().map((p) => p.url()), { timeout: 10_000 })
      .toContain(`chrome-extension://${EXTENSION_ID}/options.html#agent`);

    // Still "missing" after the restart: no second reload, a clear message, and the diagnostics log says so.
    await api("retryBridge");
    await expect
      .poll(async () => (await api<{ error: string }>("getBridgeState")).error)
      .toContain("Quit and reopen Chrome");
    await api("retryBridge");
    expect(await reloads()).toBe(1);
    expect(
      (await api<Array<{ level: string; message: string }>>("getLog")).filter(
        (e) =>
          e.level === "error" &&
          /still missing after a restart/.test(e.message),
      ),
    ).toHaveLength(1);

    // The API is there (a Chrome restart): it connects, and the give-up is forgotten.
    await worker.evaluate(() => {
      (globalThis as any).__facetTestNmHidden = false;
    });
    await api("retryBridge");
    await expect
      .poll(
        async () => (await api<{ status: string }>("getBridgeState")).status,
        { timeout: 20_000 },
      )
      .toBe("connected");
    await expect.poll(() => local("bridgeNativeRestartFailed")).toBeUndefined();
    await api("updateSettings", { agentBridge: false });
    await expect.poll(() => hostPids(facet), { timeout: 10_000 }).toEqual([]);
  });

  test("the extension's own restart with 'Restore container tabs' off: the container tab is back in its container and sends the container's cookie, not the real one", async () => {
    test.skip(buildError !== "", `build failed: ${buildError}`);
    test.setTimeout(120_000);
    const { ctx, worker, api } = await start(GRANT_PATH);
    await api("updateSettings", { restoreTabs: false });
    const A = await api<{ id: string }>("createContainer", { name: "A" });
    const cookieUrl = (value: string) =>
      at(
        "a.localhost",
        `/set?c=${encodeURIComponent(`${value}; Max-Age=86400; Path=/`)}`,
      );
    const serverLog = async () =>
      (await (
        await fetch(`http://127.0.0.1:${TEST_PORT}/__log`)
      ).json()) as Array<{ path: string; cookie: string }>;
    // The real profile has its own cookie for the same site.
    const plain = await ctx.newPage();
    await plain.goto(cookieUrl("who=real"));

    const created = ctx.waitForEvent("page");
    const tabId = await api<number>(
      "openInContainer",
      cookieUrl("who=alice"),
      A.id,
    );
    const page = await created;
    await page.goto(at("a.localhost", "/whoami?t=own-reload"));
    await expect(page.locator("#cookies")).toHaveText("who=alice");
    await api("flushRestore");

    // What a reload leaves behind: `storage.local` (the backup of the tab map) stays; `storage.session` (the map) and the
    // session rules are gone, and the new worker's memory is empty. Chromium cannot reload a command-line extension, so the
    // wipe is done by hand on the same worker: the tab leaves its container, then the backup is put back.
    const backup = await worker.evaluate(
      async () =>
        (await (globalThis as any).chrome.storage.local.get("tabsBackup"))
          .tabsBackup,
    );
    expect(Object.keys(backup ?? {})).toContain(String(tabId));
    await api("assignTab", tabId, null, { reload: false });
    await worker.evaluate(async (saved) => {
      const c = (globalThis as any).chrome;
      await c.storage.session.remove("tabs");
      await c.storage.local.set({ tabsBackup: saved });
      const rules = await c.declarativeNetRequest.getSessionRules();
      await c.declarativeNetRequest.updateSessionRules({
        removeRuleIds: rules.map((r: { id: number }) => r.id),
      });
      // The marker the bridge writes just before its own reload.
      await c.storage.local.set({ bridgeNativeRestart: Date.now() });
    }, backup);
    expect(await api("getTabContainer", tabId)).toBeNull();

    // The next worker start: the marker is found, and the tab goes back before anything else.
    await fetch(`http://127.0.0.1:${TEST_PORT}/__log?clear=1`);
    await worker.evaluate(() => (globalThis as any).facetNativeRestart.start());
    await expect
      .poll(() => api("getTabContainer", tabId), { timeout: 10_000 })
      .toBe(A.id);
    await expect(page.locator("#cookies")).toHaveText("who=alice", {
      timeout: 10_000,
    });
    const sent = (await serverLog()).filter(
      (e) => e.path === "/whoami?t=own-reload",
    );
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((e) => e.cookie === "who=alice")).toBe(true);
  });
});
