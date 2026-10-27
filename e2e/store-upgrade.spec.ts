import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BrowserContext,
  chromium,
  expect,
  test,
  type Worker,
} from "@playwright/test";

import { TEST_PORT } from "./env";
import { apiOf } from "./extension";
import { at } from "./fixtures";

/**
 * The Chrome Web Store item is updated in place from Lite to the store build of Full (docs/decisions.md, "The store item
 * becomes Full"): one extension ID, so the Lite user's storage is what Full starts from. Both builds are made here with a
 * throwaway key (FACET_TEST_KEY, wxt.config.ts; the private half never leaves memory), so they load with one ID. One
 * persistent profile: Lite sets up containers, container tabs and settings; the browser closes; the store build starts
 * on the same profile and must find all of it, with the Full-only settings at their defaults and the bridge off.
 *
 * Then the extension is disabled and enabled again from chrome://extensions, which is what a user goes through while
 * Chrome holds the update for the new permissions (disabled until approved): the tabs survive and isolation returns.
 *
 * The store build gets a higher version (as every store update does) and is started with one `runtime.reload()`: loaded
 * from the command line, Chromium takes the new manifest but keeps the old service worker until the extension reloads.
 * Developer mode is switched on first: without it Chromium disables a reloaded or re-enabled unpacked extension.
 *
 * Unpacked loading cannot show Chrome's "disabled pending approval" state itself; that needs a packed update
 * (docs/release/upgrade-test.md).
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LITE_OUT = path.join(ROOT, ".output/upgrade-lite");
const STORE_OUT = path.join(ROOT, ".output/upgrade-store");
const LITE_PATH = path.join(LITE_OUT, "chrome-mv3");
const STORE_PATH = path.join(STORE_OUT, "chrome-mv3");

/** Chrome derives the ID from the first 16 bytes of SHA-256(SPKI DER), hex digits mapped 0-f -> a-p (scripts/keygen.mjs). */
const idOf = (spkiDer: Buffer): string =>
  [...createHash("sha256").update(spkiDer).digest("hex").slice(0, 32)]
    .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
    .join("");

/** `/set?c=<cookie>`: a persistent cookie (it survives a browser restart in the real profile and in a jar alike). */
const setCookie = (host: string, value: string) =>
  at(host, `/set?c=${encodeURIComponent(`${value}; Max-Age=86400; Path=/`)}`);

const serverLog = async (): Promise<Array<{ path: string; cookie: string }>> =>
  (await (await fetch(`http://127.0.0.1:${TEST_PORT}/__log`)).json()) as Array<{
    path: string;
    cookie: string;
  }>;
const cookiesFor = async (pathWithQuery: string): Promise<string[]> =>
  (await serverLog())
    .filter((e) => e.path === pathWithQuery)
    .map((e) => e.cookie);

test.describe.configure({ mode: "serial" });

let extId = "";
let buildError = "";
let userDataDir = "";
let ctx: BrowserContext | undefined;

test.beforeAll(() => {
  test.setTimeout(120_000);
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const der = publicKey.export({ type: "spki", format: "der" });
  extId = idOf(der);
  const env = { ...process.env, FACET_TEST_KEY: der.toString("base64") };
  try {
    for (const [edition, out] of [
      ["lite", LITE_OUT],
      ["store", STORE_OUT],
    ] as const)
      execFileSync("pnpm", ["exec", "wxt", "build"], {
        cwd: ROOT,
        stdio: "ignore",
        env: { ...env, FACET_EDITION: edition, FACET_OUT_DIR: out },
      });
    // A store update always has a higher version, and Chrome re-registers an extension's service worker only when the
    // version changes (with the same version it kept running Lite's worker code here).
    const manifestPath = path.join(STORE_PATH, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      version: string;
    };
    manifest.version = `${manifest.version}.1`;
    writeFileSync(manifestPath, JSON.stringify(manifest));
  } catch (error) {
    buildError = String(error);
  }
  userDataDir = mkdtempSync(path.join(tmpdir(), "splitsession-upgrade-e2e-"));
});

test.afterAll(async () => {
  await ctx?.close().catch(() => {});
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
  rmSync(LITE_OUT, { recursive: true, force: true });
  rmSync(STORE_OUT, { recursive: true, force: true });
});

const isOurs = (w: { url(): string }) =>
  w.url().startsWith(`chrome-extension://${extId}/`);

async function launch(extensionPath: string): Promise<BrowserContext> {
  return chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: !process.env.HEADED,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      // "Continue where you left off": the container tabs come back after the restart.
      "--restore-last-session",
    ],
  });
}

async function workerOf(context: BrowserContext): Promise<Worker> {
  return (
    context.serviceWorkers().find(isOurs) ??
    context.waitForEvent("serviceworker", {
      predicate: isOurs,
      timeout: 15_000,
    })
  );
}

/** Runs in the worker: waits until the tab has loaded an address containing `part`. */
async function loaded(sw: Worker, tabId: number, part: string): Promise<void> {
  await sw.evaluate(
    async ([id, p]) => {
      const c = (globalThis as any).chrome;
      for (let i = 0; i < 200; i++) {
        const tab = await c.tabs.get(id);
        if (tab.status === "complete" && (tab.url ?? "").includes(p)) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`tab ${id} did not load ${p}`);
    },
    [tabId, part] as const,
  );
}

/** The tab IDs of the extension's container tabs by the `?w=` of their address, and their tab group titles. */
async function containerTabs(
  sw: Worker,
): Promise<
  Record<string, { tabId: number; containerId: string; group: string }>
> {
  const tabs =
    await apiOf(sw)<Array<{ tabId: number; containerId: string }>>("listTabs");
  const out: Record<
    string,
    { tabId: number; containerId: string; group: string }
  > = {};
  for (const t of tabs) {
    const info = await sw.evaluate(async (id) => {
      const c = (globalThis as any).chrome;
      const tab = await c.tabs.get(id);
      const group =
        tab.groupId >= 0 ? (await c.tabGroups.get(tab.groupId)).title : "";
      return { url: (tab.url ?? "") as string, group: group as string };
    }, t.tabId);
    const w = new URL(info.url).searchParams.get("w");
    if (w) out[w] = { ...t, group: info.group };
  }
  return out;
}

/** A request from the tab itself (fetch from the page's main world), as the server logs it under `/echo?<tag>`. */
async function echoFrom(sw: Worker, tabId: number, tag: string): Promise<void> {
  await sw.evaluate(
    async ([id, t]) => {
      const c = (globalThis as any).chrome;
      await c.scripting.executeScript({
        target: { tabId: id },
        world: "MAIN",
        func: (u: string) => fetch(u).then((r) => r.text()),
        args: [`/echo?${t}`],
      });
    },
    [tabId, tag] as const,
  );
}

let A = { id: "", name: "Work", color: "blue" };
let B = { id: "", name: "Home", color: "orange" };

test("Lite: containers, container tabs and settings set up, then the browser closes", async () => {
  test.skip(buildError !== "", `builds failed: ${buildError}`);
  test.setTimeout(90_000);
  ctx = await launch(LITE_PATH);
  const sw = await workerOf(ctx);
  const api = apiOf(sw);
  await api("listContainers");
  const manifest = await sw.evaluate(() =>
    (globalThis as any).chrome.runtime.getManifest(),
  );
  expect(manifest.permissions).not.toContain("debugger"); // it is the Lite build
  // Developer mode on (a profile setting): Chromium disables an unpacked extension that is reloaded or switched back on
  // without it ("Turn on developer mode to use this extension").
  const extensions = await ctx.newPage();
  await extensions.goto("chrome://extensions/");
  const devMode = extensions.locator("#devMode");
  if ((await devMode.getAttribute("aria-checked")) !== "true")
    await devMode.click();
  await expect(devMode).toHaveAttribute("aria-checked", "true");
  await extensions.close();
  A = await api("createContainer", { name: A.name, color: A.color });
  B = await api("createContainer", { name: B.name, color: B.color });
  // Lite's own settings, away from their defaults where that keeps the test meaningful: tab groups and restore stay on
  // (the groups and the returning tabs are what is checked after the update).
  await api("updateSettings", {
    strictMode: true,
    markOutsideGroup: false,
    rememberTabs: false,
  });

  const real = await ctx.newPage();
  await real.goto(setCookie("a.localhost", "who=real"));
  await real.close();

  const inContainer = async (
    containerId: string,
    cookie: string,
    w: string,
  ) => {
    const id = await api<number>(
      "openInContainer",
      setCookie("a.localhost", cookie),
      containerId,
      { active: false },
    );
    await loaded(sw, id, "/set");
    await sw.evaluate(
      ([t, u]) => (globalThis as any).chrome.tabs.update(t, { url: u }),
      [id, at("a.localhost", `/whoami?w=${w}`)] as const,
    );
    await loaded(sw, id, `?w=${w}`);
    return id;
  };
  await inContainer(A.id, "who=alice", "work");
  await inContainer(B.id, "who=bob", "home");
  const before = await containerTabs(sw);
  expect(before.work?.containerId).toBe(A.id);
  expect(before.home?.containerId).toBe(B.id);
  await expect
    .poll(async () => (await containerTabs(sw)).work?.group)
    .toContain(A.name);
  await api("flushRestore");
  await ctx.close();
  ctx = undefined;
});

test("the store build of Full on the same ID finds Lite's containers, tabs, groups, isolation and settings; the bridge stays off", async () => {
  test.skip(buildError !== "", `builds failed: ${buildError}`);
  test.setTimeout(90_000);
  await fetch(`http://127.0.0.1:${TEST_PORT}/__log?clear=1`);
  ctx = await launch(STORE_PATH);
  // Chromium loads the new manifest from the command line but keeps running the service worker it had registered for
  // this ID (Lite's code). A store update installs through the extension updater, which reloads the extension and
  // registers the new worker; one `runtime.reload()` does the same here.
  const stale = await workerOf(ctx);
  const isFull = (w: Worker) =>
    w
      .evaluate(
        () => typeof (globalThis as any).facet?.getBridgeState === "function",
      )
      .catch(() => false);
  if (!(await isFull(stale))) {
    await stale
      .evaluate(() => (globalThis as any).chrome.runtime.reload())
      .catch(() => {});
    await expect
      .poll(
        async () => {
          for (const w of ctx!.serviceWorkers().filter(isOurs))
            if (await isFull(w)) return true;
          return false;
        },
        { timeout: 15_000 },
      )
      .toBe(true);
  }
  let sw = stale;
  for (const w of ctx.serviceWorkers().filter(isOurs))
    if (await isFull(w)) sw = w;
  const api = apiOf(sw);
  expect(new URL(sw.url()).host).toBe(extId);
  const manifest = await sw.evaluate(() =>
    (globalThis as any).chrome.runtime.getManifest(),
  );
  expect(manifest.permissions).toEqual(
    expect.arrayContaining(["nativeMessaging", "debugger"]),
  );
  expect(manifest.name).toBe("SplitSession: Multiple Logins per Site");

  const containers =
    await api<Array<{ id: string; name: string; color: string }>>(
      "listContainers",
    );
  expect(
    containers
      .map(({ id, name, color }) => ({ id, name, color }))
      .sort((x, y) => x.name.localeCompare(y.name)),
  ).toEqual([
    { id: B.id, name: "Home", color: "orange" },
    { id: A.id, name: "Work", color: "blue" },
  ]);

  // The tabs came back in their containers and in their containers' tab groups.
  await expect
    .poll(
      async () => {
        const t = await containerTabs(sw);
        return [t.work?.containerId, t.home?.containerId];
      },
      { timeout: 15_000 },
    )
    .toEqual([A.id, B.id]);
  await expect
    .poll(
      async () => {
        const t = await containerTabs(sw);
        return [t.work?.group ?? "", t.home?.group ?? ""];
      },
      { timeout: 15_000 },
    )
    .toEqual([
      expect.stringContaining("Work"),
      expect.stringContaining("Home"),
    ]);
  const tabs = await containerTabs(sw);

  // Isolation: each container's jar, and the real profile's cookie never in a container tab.
  await expect
    .poll(async () => (await cookiesFor("/whoami?w=work")).at(-1), {
      timeout: 10_000,
    })
    .toBe("who=alice");
  // Each tab's own requests carry its container's cookie once the new worker has taken the tabs over (it re-applies
  // their rules after the update); none ever carries the real profile's.
  await api("flushRestore");
  for (const [w, cookie] of [
    ["work", "who=alice"],
    ["home", "who=bob"],
  ] as const) {
    let n = 0;
    await expect
      .poll(
        async () => {
          const tag = `after-update-${w}-${n++}`;
          await echoFrom(sw, tabs[w]!.tabId, tag);
          return (await cookiesFor(`/echo?${tag}`)).at(-1);
        },
        { timeout: 15_000 },
      )
      .toBe(cookie);
  }
  expect(
    (await serverLog()).filter(
      (e) =>
        e.path.startsWith("/echo?after-update") && e.cookie.includes("real"),
    ),
  ).toEqual([]);
  const plain = await ctx.newPage();
  await plain.goto(at("a.localhost", "/whoami?plain"));
  await expect(plain.locator("#cookies")).toHaveText("who=real");
  await plain.close();

  // Settings: Lite's choices kept, every Full-only setting at its default, the bridge off and never consented to.
  expect(await api("getSettings")).toEqual({
    tabGroups: true,
    titlePrefix: true,
    strictMode: true,
    showNameToPages: false,
    agentBridge: false,
    agentActivity: true,
    agentWindow: false,
    restoreTabs: true,
    markOutsideGroup: false,
    rememberTabs: false,
  });
  const stored = await sw.evaluate(() =>
    (globalThis as any).chrome.storage.local.get(null),
  );
  expect(stored).not.toHaveProperty("agentBridgeConsent");
  expect(((await api("getBridgeState")) as { status: string }).status).toBe(
    "off",
  );
});

test("disabled and enabled again (the wait for the permission prompt): tabs survive, isolation comes back", async () => {
  test.skip(buildError !== "" || !ctx, `builds failed: ${buildError}`);
  test.setTimeout(90_000);
  const context = ctx!;
  let sw = await workerOf(context);
  const tabs = await containerTabs(sw);
  const workTab = tabs.work!.tabId;
  const homeTab = tabs.home!.tabId;

  const extensions = await context.newPage();
  await extensions.goto(`chrome://extensions/?id=${extId}`);
  const toggle = extensions.locator("extensions-detail-view #enableToggle");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect
    .poll(() => context.serviceWorkers().filter(isOurs).length)
    .toBe(0);

  // While it is off the container tabs are ordinary tabs: what they send now is the real profile's cookie (the gap the
  // Lite release's notice warns about). Recorded here so a change in that behaviour is noticed.
  const pages = context.pages();
  const workPage = pages.find((p) => p.url().includes("?w=work"))!;
  expect(workPage).toBeTruthy();
  await workPage.evaluate(() =>
    fetch("/echo?while-disabled").then((r) => r.text()),
  );
  await expect
    .poll(() => cookiesFor("/echo?while-disabled"))
    .toEqual(["who=real"]);

  const started = context.waitForEvent("serviceworker", {
    predicate: isOurs,
    timeout: 15_000,
  });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  sw = context.serviceWorkers().find(isOurs) ?? (await started);
  await apiOf(sw)("listContainers");
  await extensions.close();

  // The same tabs, back in their containers, and their requests carry the containers' cookies again.
  await expect
    .poll(
      async () => {
        const t = await containerTabs(sw);
        return [
          t.work?.tabId,
          t.work?.containerId,
          t.home?.tabId,
          t.home?.containerId,
        ];
      },
      { timeout: 15_000 },
    )
    .toEqual([workTab, A.id, homeTab, B.id]);
  for (const [tabId, cookie] of [
    [workTab, "who=alice"],
    [homeTab, "who=bob"],
  ] as const) {
    let n = 0;
    await expect
      .poll(
        async () => {
          const tag = `after-enable-${tabId}-${n++}`;
          await echoFrom(sw, tabId, tag);
          return (await cookiesFor(`/echo?${tag}`)).at(-1);
        },
        { timeout: 15_000 },
      )
      .toBe(cookie);
  }
});
