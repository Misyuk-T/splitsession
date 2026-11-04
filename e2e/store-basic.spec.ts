import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type BrowserContext, chromium, expect, test } from "@playwright/test";

import { BRIDGE_CONSENT_VERSION } from "../src/core/bridge-consent";
import { TOOLS } from "../src/bridge/spec";
import { hostPids, installHost, type Mcp, startMcp } from "./bridge-helpers";
import { at, EXTENSION_ID } from "./env";
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
});
