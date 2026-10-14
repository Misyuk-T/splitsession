// Regenerates the Chrome Web Store pictures of SplitSession Lite into docs/release/assets/:
//
//   pnpm store:assets [outDir]        (builds the Lite edition first; needs `pnpm exec playwright install chromium` once)
//
//   screenshot-1-two-accounts.png   1280x800   a personal and a brand account in two tab groups of one window, popup open
//   screenshot-2-popup.png          1280x800   the popup close-up and the tab groups it makes
//   screenshot-3-split-view.png     1280x800   the two accounts as the halves of Chrome's split view (outside the groups)
//   screenshot-4-settings.png       1280x800   Settings: tab groups, restore after restart, strict mode
//   screenshot-5-restart.png        1280x800   after a browser restart: groups are back, an unsure tab waits for a choice
//   promo-small-440x280.png         440x280    small promo tile
//   promo-marquee-1400x560.png      1400x560   marquee promo tile
//
// How: Playwright's Chromium loads the built Lite extension (.output/lite/chrome-mv3) and a small demo server
// (scripts/store-assets/demo-site.mjs: fake sites on *.example names; the demo social network is "Loop",
// loop-site.mjs). The real extension makes the containers and tab groups, two demo accounts (personal and brand) sign in
// to Loop in two containers, and the REAL popup, settings page, held-tab page and Loop pages are photographed at 2x. The
// split-view pair is the README's capture (scripts/readme-media/capture.mjs): Chrome's split view cannot be driven from
// Playwright, so two real container tabs are taken out of their groups (which is what Chrome does with a split pair,
// and what puts the mark in their titles) and composed as a pair. scripts/store-assets/frames.mjs then composes
// marketing frames (brand background, headline, a drawn browser window whose tab strip comes from the real group and
// title data) and every PNG is flattened to 24-bit RGB (the Store refuses alpha). Everything is fixed (demo data,
// ports, sizes, software rasterising), nothing leaves the machine, and only a temporary profile is touched.
/* eslint-disable import/extensions -- local .mjs modules, run directly by node */
/* global chrome -- the callbacks of worker.evaluate run inside the extension's service worker */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

import { captureSplitView, RASTER } from "./readme-media/capture.mjs";
import { startDemoSite } from "./store-assets/demo-site.mjs";
import {
  marquee,
  PAGE,
  promoTile,
  shotGroups,
  shotPopup,
  shotRestart,
  shotSettings,
  shotSplit,
} from "./store-assets/frames.mjs";
import { flattenPng, pngInfo } from "./store-assets/png.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(process.argv[2] ?? resolve(root, "docs/release/assets"));
const extension = resolve(root, ".output/lite/chrome-mv3");
const PORT = 47401;
const SETTINGS = { width: 880, height: 520 };
mkdirSync(out, { recursive: true });

/** Demo accounts of Loop (loop-site.mjs), by the container they sign in to. */
const HANDLE = { work: "northwind_studio", personal: "dana" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Tabs per tab group as Chrome has them (waits until every web tab is in a group), in strip order. */
async function readGroups(worker) {
  let state;
  for (let i = 0; i < 40; i++) {
    state = await worker.evaluate(async () => {
      const tabs = (await chrome.tabs.query({})).filter((t) =>
        t.url.startsWith("http"),
      );
      return { tabs, groups: await chrome.tabGroups.query({}) };
    });
    if (state.tabs.every((t) => t.groupId >= 0)) break;
    await sleep(250);
  }
  return state.groups
    .map((g) => {
      const tabs = state.tabs
        .filter((t) => t.groupId === g.id)
        .sort((a, b) => a.index - b.index);
      return {
        title: g.title ?? "",
        color: g.color,
        index: Math.min(...tabs.map((t) => t.index)),
        tabs: tabs.map((t) => ({
          title: t.title,
          host: new URL(t.url).host,
          id: t.id,
        })),
      };
    })
    .filter((g) => g.tabs.length > 0)
    .sort((a, b) => a.index - b.index);
}

/** Opens the real extension, sets the demo up and photographs it. Returns the raw 2x pictures and the strip data. */
async function capture() {
  const server = await startDemoSite(PORT);
  const profile = mkdtempSync(resolve(tmpdir(), "splitsession-store-"));
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    deviceScaleFactor: 2,
    viewport: { width: PAGE.w, height: PAGE.h },
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      `--host-resolver-rules=MAP *.example 127.0.0.1:${PORT}`,
      ...RASTER,
    ],
  });
  try {
    const worker =
      ctx.serviceWorkers()[0] ??
      (await ctx.waitForEvent("serviceworker", { timeout: 15_000 }));
    const extId = new URL(worker.url()).host;
    const api = (method, ...args) =>
      worker.evaluate(([m, a]) => globalThis.facet[m](...a), [method, args]);
    await api("listContainers");

    const personal = await api("createContainer", {
      name: "Personal",
      color: "green",
    });
    const work = await api("createContainer", { name: "Work", color: "blue" });
    await api("createContainer", { name: "Side project", color: "purple" });
    /** A Loop tab in a container, signed in as `user` by Loop's own sign-in; resolves once the feed has loaded. */
    const open = async (user, container) => {
      const created = ctx.waitForEvent("page");
      const tabId = await api(
        "openInContainer",
        `http://loop.example/login?user=${HANDLE[user]}`,
        container.id,
      );
      const page = await created;
      await page.waitForURL((u) => u.href === "http://loop.example/", {
        timeout: 15_000,
      });
      await page.waitForLoadState("load");
      return { tabId, page };
    };
    const personalTab = await open("personal", personal);
    const workTab = await open("work", work);
    const groupsOut = await readGroups(worker);

    const raw = {};
    for (const { page } of [personalTab, workTab])
      await page.evaluate(() => document.fonts.ready);
    await personalTab.page.bringToFront();
    await sleep(500);
    // No animation may be caught half-way (the switches of the settings page glide), so every picture is the final state.
    const still = { animations: "disabled" };
    raw.personal = await personalTab.page.screenshot(still);

    const popupFor = async (tabId, name) => {
      const p = await ctx.newPage();
      await p.setViewportSize({ width: 420, height: 700 });
      await p.goto(`chrome-extension://${extId}/popup.html?tab=${tabId}`);
      await p.locator("main.popup").waitFor();
      await p.getByRole("heading", { name: "Containers" }).waitFor();
      await p.evaluate(() => document.fonts.ready);
      await sleep(400);
      raw[name] = await p.locator("main.popup").screenshot(still);
      await p.close();
    };
    await popupFor(personalTab.tabId, "popupPersonal");
    await popupFor(workTab.tabId, "popupWork");

    const p = await ctx.newPage();
    await p.setViewportSize(SETTINGS);
    await p.emulateMedia({ colorScheme: "light" });
    await p.goto(`chrome-extension://${extId}/options.html`);
    await p.locator(".opt-page").waitFor();
    await p.evaluate(() => document.fonts.ready);
    await p.evaluate(() => {
      document.querySelector("#general").scrollIntoView({ block: "start" });
    });
    await sleep(400);
    raw.settingsGeneral = await p.screenshot(still);
    await p.close();
    return {
      raw,
      groups: groupsOut,
      personalId: personalTab.tabId,
    };
  } finally {
    await ctx.close();
    server.close();
    rmSync(profile, { recursive: true, force: true });
  }
}

/**
 * A browser restart: two accounts in two groups, plus two look-alike tabs of one address in two windows (one a
 * container tab, one ordinary), so that after the restart SplitSession cannot tell which is which and holds both.
 * Returns the real held page and the real popup with its banner open.
 */
async function captureRestart() {
  const server = await startDemoSite(PORT);
  const profile = mkdtempSync(resolve(tmpdir(), "splitsession-store-"));
  const launch = () =>
    chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: true,
      deviceScaleFactor: 2,
      viewport: { width: 1240, height: 522 },
      args: [
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
        "--restore-last-session", // Chromium's "continue where you left off"
        `--host-resolver-rules=MAP *.example 127.0.0.1:${PORT}`,
        ...RASTER,
      ],
    });
  let ctx = await launch();
  try {
    let worker =
      ctx.serviceWorkers()[0] ??
      (await ctx.waitForEvent("serviceworker", { timeout: 15_000 }));
    let api = (method, ...args) =>
      worker.evaluate(([m, a]) => globalThis.facet[m](...a), [method, args]);
    const loaded = (tabId, part) =>
      worker.evaluate(
        async ([id, p]) => {
          for (let i = 0; i < 200; i++) {
            const t = await chrome.tabs.get(id);
            if (t.status === "complete" && (t.url ?? "").includes(p)) return;
            await new Promise((r) => setTimeout(r, 50));
          }
          throw new Error(`tab ${id} did not load ${p}`);
        },
        [tabId, part],
      );
    await api("listContainers");
    const personal = await api("createContainer", {
      name: "Personal",
      color: "green",
    });
    const work = await api("createContainer", { name: "Work", color: "blue" });
    const login = async (user, container, extra = {}) => {
      const id = await api(
        "openInContainer",
        `http://loop.example/login?user=${HANDLE[user]}`,
        container.id,
        extra,
      );
      await loaded(id, "loop.example");
      return id;
    };
    await login("personal", personal);
    await login("work", work);
    const padWindow = () =>
      worker.evaluate(async () => {
        const w = await chrome.windows.create({
          url: "http://board.example/?pad",
        });
        return { windowId: w.id, tabId: w.tabs[0].id };
      });
    const x = await padWindow();
    const lookAlike = await login("personal", personal, {
      active: false,
      windowId: x.windowId,
    });
    await worker.evaluate(
      (id) => chrome.tabs.update(id, { url: "http://loop.example/?w=x" }),
      lookAlike,
    );
    await loaded(lookAlike, "w=x");
    for (let i = 0; i < 40; i++) {
      const g = await worker.evaluate(
        (id) => chrome.tabs.get(id).then((t) => t.groupId),
        lookAlike,
      );
      if (g >= 0) break;
      await sleep(200);
    }
    await worker.evaluate((id) => chrome.tabs.ungroup(id), lookAlike); // out of its group: nothing tells which tab it is
    const y = await padWindow();
    const plain = await worker.evaluate(
      async (windowId) =>
        (
          await chrome.tabs.create({
            url: "http://loop.example/?w=x",
            active: false,
            windowId,
          })
        ).id,
      y.windowId,
    );
    await loaded(plain, "w=x");
    await worker.evaluate(
      async (ids) => {
        for (const id of ids) await chrome.tabs.update(id, { active: true });
      },
      [x.tabId, y.tabId],
    );
    await api("flushRestore");
    await sleep(500);
    await ctx.close();

    ctx = await launch();
    worker =
      ctx.serviceWorkers()[0] ??
      (await ctx.waitForEvent("serviceworker", { timeout: 15_000 }));
    const extId = new URL(worker.url()).host;
    api = (method, ...args) =>
      worker.evaluate(([m, a]) => globalThis.facet[m](...a), [method, args]);
    await api("listContainers");
    for (let i = 0; i < 60; i++) {
      if ((await api("getRestoreStatus")).held.length >= 2) break;
      await sleep(250);
    }
    const held = ctx.pages().find((p) => p.url().includes("held.html"));
    if (!held) throw new Error("no held tab after the restart");
    await held.evaluate(() => document.fonts.ready);
    await sleep(500);
    const heldPng = await held.screenshot({ animations: "disabled" });
    // The groups of the first window, as Chrome restored them.
    const groups = await worker.evaluate(async () => {
      const tabs = (await chrome.tabs.query({})).filter(
        (t) => t.url.startsWith("http://loop.example/") && t.groupId >= 0,
      );
      const all = await chrome.tabGroups.query({});
      return all
        .map((g) => ({
          title: g.title ?? "",
          color: g.color,
          index: Math.min(
            ...tabs.filter((t) => t.groupId === g.id).map((t) => t.index),
          ),
          tabs: tabs
            .filter((t) => t.groupId === g.id)
            .map((t) => ({ title: t.title, host: "loop.example", id: t.id })),
        }))
        .filter((g) => g.tabs.length > 0)
        .sort((a, b) => a.index - b.index);
    });
    const pop = await ctx.newPage();
    await pop.setViewportSize({ width: 420, height: 700 });
    await pop.goto(`chrome-extension://${extId}/popup.html`);
    await pop.getByRole("button", { name: /tabs? waiting/ }).click();
    await pop.evaluate(() => document.fonts.ready);
    await sleep(400);
    const popup = await pop
      .locator("main.popup")
      .screenshot({ animations: "disabled" });
    return { held: heldPng, popup, groups };
  } finally {
    await ctx.close().catch(() => undefined);
    server.close();
    rmSync(profile, { recursive: true, force: true });
  }
}

/** Strip items of a window: every group with its tabs. `active` = tab ids drawn as selected. */
const stripOf = (groups, active, plain = []) => [
  ...groups.map((g) => ({
    type: "group",
    title: g.title,
    color: g.color,
    tabs: g.tabs.map((t) => ({ ...t, active: active.includes(t.id) })),
  })),
  ...plain,
];

const { raw, groups, personalId } = await capture();
const restart = await captureRestart();
// The split-view pair: the README's capture, at 2x and at the width of one half of the window of screenshot 3.
const split = await captureSplitView(extension, {
  scale: 2,
  width: (PAGE.w - 2) / 2,
  height: PAGE.h,
  port: PORT,
});
const settingsTab = (title) => ({
  type: "tab",
  title,
  host: "settings",
  active: true,
});

const heldTab = () => ({
  type: "tab",
  title: "SplitSession: choose a container",
  host: "settings",
  active: true,
});

const browser = await chromium.launch({ channel: "chromium", args: RASTER });
try {
  const render = async (name, html, width, height) => {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.setContent(html);
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() =>
      Promise.all(
        [...document.images].map((i) => i.decode().catch(() => undefined)),
      ),
    );
    // Let the compositor settle (scaled images are first drawn in low quality) before the picture is taken.
    await page.evaluate(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    );
    await sleep(400);
    const png = flattenPng(await page.screenshot({ animations: "disabled" }));
    await page.close();
    const info = pngInfo(png);
    if (info.width !== width || info.height !== height || info.colorType !== 2)
      throw new Error(
        `${name}: ${info.width}x${info.height}, colour type ${info.colorType}`,
      );
    writeFileSync(resolve(out, name), png);
    console.log(`${name}  ${width}x${height}`);
  };
  await render(
    "screenshot-1-two-accounts.png",
    shotGroups({
      strip: stripOf(groups, [personalId]),
      page: raw.personal,
      popup: raw.popupPersonal,
    }),
    1280,
    800,
  );
  await render(
    "screenshot-2-popup.png",
    shotPopup({ popup: raw.popupWork, groups }),
    1280,
    800,
  );
  await render(
    "screenshot-3-split-view.png",
    shotSplit({
      strip: [
        {
          type: "split",
          tabs: [split.personal, split.work].map((t) => ({
            title: t.title,
            host: "loop.example",
          })),
        },
      ],
      left: split.personal,
      right: split.work,
    }),
    1280,
    800,
  );
  await render(
    "screenshot-4-settings.png",
    shotSettings({
      theme: "light",
      headline: "Simple settings, sensible defaults.",
      sub: "Tab groups, restore after restart, strict mode: one switch each.",
      strip: stripOf(groups, [], [settingsTab("SplitSession settings")]),
      settings: raw.settingsGeneral,
    }),
    1280,
    800,
  );
  await render(
    "screenshot-5-restart.png",
    shotRestart({
      strip: stripOf(restart.groups, [], [heldTab()]),
      held: restart.held,
      popup: restart.popup,
    }),
    1280,
    800,
  );
  await render("promo-small-440x280.png", promoTile(), 440, 280);
  await render(
    "promo-marquee-1400x560.png",
    marquee({
      work: split.work.png,
      personal: split.personal.png,
      popup: raw.popupPersonal,
    }),
    1400,
    560,
  );
} finally {
  await browser.close();
}
