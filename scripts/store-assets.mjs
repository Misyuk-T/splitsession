// Regenerates the Chrome Web Store pictures of SplitSession Lite into docs/release/assets/:
//
//   pnpm store:assets [outDir]        (builds the Lite edition first; needs `pnpm exec playwright install chromium` once)
//
//   screenshot-1-two-accounts.png   1280x800   two accounts of one site side by side, tab groups, popup open
//   screenshot-2-popup.png          1280x800   the popup close-up and the tab groups it makes
//   screenshot-3-settings.png       1280x800   Settings: tab groups, restore after restart, strict mode
//   screenshot-4-domain-rules.png   1280x800   Domain rules (dark theme)
//   screenshot-5-restart.png        1280x800   after a browser restart: groups are back, an unsure tab waits for a choice
//   promo-small-440x280.png         440x280    small promo tile
//   promo-marquee-1400x560.png      1400x560   marquee promo tile
//
// How: Playwright's Chromium loads the built Lite extension (.output/lite/chrome-mv3) and a small demo server
// (scripts/store-assets/demo-site.mjs: fake sites on *.example names). The real extension makes the containers, tab
// groups and domain rules, two demo accounts sign in to the same site in two containers, and the REAL popup, settings
// page and sites are photographed at 2x. scripts/store-assets/frames.mjs then composes marketing frames (brand
// background, headline, a drawn browser window whose tab strip comes from the real group data) and every PNG is
// flattened to 24-bit RGB (the Store refuses alpha). Everything is fixed (demo data, ports, sizes), nothing leaves the
// machine, and only a temporary profile is touched.
/* eslint-disable import/extensions -- local .mjs modules, run directly by node */
/* global chrome -- the callbacks of worker.evaluate run inside the extension's service worker */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

import { startDemoSite } from "./store-assets/demo-site.mjs";
import {
  marquee,
  promoTile,
  shotPopup,
  shotRestart,
  shotSettings,
  shotTwoAccounts,
} from "./store-assets/frames.mjs";
import { flattenPng, pngInfo } from "./store-assets/png.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(process.argv[2] ?? resolve(root, "docs/release/assets"));
const extension = resolve(root, ".output/lite/chrome-mv3");
const PORT = 47401;
const PANE = { width: 599, height: 526 };
const SETTINGS = { width: 880, height: 520 };
mkdirSync(out, { recursive: true });

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
    viewport: PANE,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      `--host-resolver-rules=MAP *.example 127.0.0.1:${PORT}`,
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

    const work = await api("createContainer", { name: "Work", color: "blue" });
    const personal = await api("createContainer", {
      name: "Personal",
      color: "green",
    });
    const client = await api("createContainer", {
      name: "Client A",
      color: "orange",
    });
    const side = await api("createContainer", {
      name: "Side project",
      color: "purple",
    });
    /** A tab in a container at `url`; resolves once the site has loaded. */
    const open = async (url, container, landed) => {
      const created = ctx.waitForEvent("page");
      const tabId = await api("openInContainer", url, container.id);
      const page = await created;
      await page.waitForURL((u) => u.href === landed, { timeout: 15_000 });
      await page.waitForLoadState("load");
      return { tabId, page };
    };
    const workMail = await open(
      "http://mail.example/login?user=work",
      work,
      "http://mail.example/",
    );
    await open("http://board.example/", work, "http://board.example/");
    const personalMail = await open(
      "http://mail.example/login?user=personal",
      personal,
      "http://mail.example/",
    );
    await open("http://invoices.example/", client, "http://invoices.example/");
    await open("http://notes.example/", side, "http://notes.example/");
    const groupsOut = await readGroups(worker);

    const raw = {};
    for (const { page } of [workMail, personalMail])
      await page.evaluate(() => document.fonts.ready);
    await sleep(500);
    // No animation may be caught half-way (the switches of the settings page glide), so every picture is the final state.
    const still = { animations: "disabled" };
    raw.work = await workMail.page.screenshot(still);
    raw.personal = await personalMail.page.screenshot(still);

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
    await popupFor(personalMail.tabId, "popupPersonal");
    await popupFor(workMail.tabId, "popupWork");

    const settings = async (name, scheme, hash, fill) => {
      const p = await ctx.newPage();
      await p.setViewportSize(SETTINGS);
      await p.emulateMedia({ colorScheme: scheme });
      await p.goto(`chrome-extension://${extId}/options.html`);
      await p.locator(".opt-page").waitFor();
      await p.evaluate(() => document.fonts.ready);
      await p.evaluate((h) => {
        document.querySelector(h).scrollIntoView({ block: "start" });
      }, hash);
      if (fill) await fill(p);
      await sleep(400);
      raw[name] = await p.screenshot(still);
      await p.close();
    };
    await settings("settingsGeneral", "light", "#general");
    // Rules last: a rule for a site opens that site in its container, so they must not exist while tabs are opened.
    await api("setDomainRule", {
      domain: "board.example",
      action: "always",
      containerId: work.id,
    });
    await api("setDomainRule", {
      domain: "invoices.example",
      action: "always",
      containerId: client.id,
    });
    await api("setDomainRule", { domain: "social.example", action: "ask" });
    await sleep(500);
    await settings("settingsRules", "dark", "#rules", async (p) => {
      // A rule being written: the form is the real one, typed into like a user would.
      await p.locator("#rule-site").fill("photos.example");
      await p.getByRole("combobox", { name: "Container" }).click();
      await p.getByRole("option", { name: "Personal" }).click();
      await p.locator("#rule-site").blur();
    });
    return { raw, groups: groupsOut, workId: workMail.tabId };
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
    const work = await api("createContainer", { name: "Work", color: "blue" });
    const personal = await api("createContainer", {
      name: "Personal",
      color: "green",
    });
    const login = async (user, container, extra = {}) => {
      const id = await api(
        "openInContainer",
        `http://mail.example/login?user=${user}`,
        container.id,
        extra,
      );
      await loaded(id, "mail.example");
      return id;
    };
    await login("work", work);
    await login("personal", personal);
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
      (id) => chrome.tabs.update(id, { url: "http://mail.example/?w=x" }),
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
            url: "http://mail.example/?w=x",
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
        (t) => t.url.startsWith("http://mail.example/") && t.groupId >= 0,
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
            .map((t) => ({ title: t.title, host: "mail.example", id: t.id })),
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

const { raw, groups } = await capture();
const restart = await captureRestart();

const mailTabs = groups
  .flatMap((g) => g.tabs)
  .filter((t) => t.host === "mail.example");
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

const browser = await chromium.launch({ channel: "chromium" });
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
    shotTwoAccounts({
      strip: stripOf(
        groups.slice(0, 3),
        mailTabs.map((t) => t.id),
      ),
      work: raw.work,
      personal: raw.personal,
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
    "screenshot-3-settings.png",
    shotSettings({
      theme: "light",
      headline: "Simple settings, sensible defaults.",
      sub: "Tab groups, restore after restart, strict mode: one switch each.",
      strip: stripOf(
        groups.slice(0, 2),
        [],
        [settingsTab("SplitSession settings")],
      ),
      settings: raw.settingsGeneral,
    }),
    1280,
    800,
  );
  await render(
    "screenshot-4-domain-rules.png",
    shotSettings({
      theme: "dark",
      headline: "Right site, right account.",
      sub: "Open each site in the container you choose, or be asked every time.",
      strip: stripOf(
        groups.slice(0, 2),
        [],
        [settingsTab("SplitSession settings")],
      ),
      settings: raw.settingsRules,
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
      work: raw.work,
      personal: raw.personal,
      popup: raw.popupPersonal,
    }),
    1400,
    560,
  );
} finally {
  await browser.close();
}
