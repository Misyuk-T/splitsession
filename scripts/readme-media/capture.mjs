// The real pictures behind the README animations, taken with Playwright's Chromium (see ../readme-media.mjs):
//  - captureHowItWorks: the REAL Lite extension on the demo social network (Loop). The popup is driven like a user would (press +,
//    type "Work", Enter), the new tab opens in its container, and a second (brand) account signs in there through
//    the demo's real sign-in form and posts through its real composer. The pictures of every step are taken as they happen.
//  - captureInstall: the REAL chrome://extensions page, empty and with Developer mode off and on, and with the
//    extension loaded (an unpacked extension in Chromium is exactly what "Load unpacked" makes).
/* eslint-disable import/extensions -- local .mjs modules, run directly by node */
/* global chrome -- the callbacks of worker.evaluate run inside the extension's service worker */
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";

import { startDemoSite } from "../store-assets/demo-site.mjs";
import { CONTENT, visibleTitle } from "./mock.mjs";

const PORT = 47402;
const VIEWPORT = { width: CONTENT.w, height: CONTENT.h };
const HANDLE = "@northwind_studio";
const POST = "Spring release is live. Thanks for the feedback!";
/** A fixed place for the unpacked copy: an unpacked extension's ID comes from its path, so the card is the same every run. */
const UNPACKED = "/tmp/splitsession-readme-media/splitsession-lite-0.1.0";

/** Software rasterising with fixed font rendering: no run-to-run differences in anti-aliased corners and text. */
export const RASTER = [
  "--disable-gpu",
  "--disable-lcd-text",
  "--font-render-hinting=none",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A picture once the page has stopped changing (two shots 120 ms apart agree): focus rings and toggles settle. */
async function steady(shoot) {
  let last = await shoot();
  for (let i = 0; i < 25; i++) {
    await sleep(120);
    const next = await shoot();
    if (next.equals(last)) return next;
    last = next;
  }
  throw new Error("the page never settled");
}

const assertSize = (png, label, size = VIEWPORT, scale = 1) => {
  const w = png.readUInt32BE(16);
  const h = png.readUInt32BE(20);
  if (w !== size.width * scale || h !== size.height * scale)
    throw new Error(
      `${label}: ${w}x${h}, expected ${size.width * scale}x${size.height * scale}`,
    );
  return png;
};

/** Page and rectangles of an element as the page sees them. */
const rectOf = async (locator) => {
  const box = await locator.boundingBox();
  if (!box) throw new Error("element has no box");
  return { x: box.x, y: box.y, w: box.width, h: box.height };
};

/** @param {string} extension folder of the built Lite extension */
export async function captureHowItWorks(extension) {
  const server = await startDemoSite(PORT);
  const profile = mkdtempSync(resolve(tmpdir(), "splitsession-readme-"));
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    deviceScaleFactor: 1,
    viewport: VIEWPORT,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      `--host-resolver-rules=MAP *.example 127.0.0.1:${PORT}`,
      ...RASTER, // the same pixels on every run
    ],
  });
  try {
    const worker =
      ctx.serviceWorkers()[0] ??
      (await ctx.waitForEvent("serviceworker", { timeout: 15_000 }));
    const extId = new URL(worker.url()).host;
    await worker.evaluate(() => globalThis.facet.listContainers());
    const still = { animations: "disabled" };
    const settle = (p) => p.evaluate(() => document.fonts.ready);

    // 1. Dana, personal, in an ordinary tab.
    const personal = ctx.pages()[0] ?? (await ctx.newPage());
    await personal.goto("http://loop.example/login?user=dana");
    await personal.waitForURL("http://loop.example/");
    await settle(personal);
    await sleep(300);
    const personalPng = assertSize(
      await steady(() => personal.screenshot(still)),
      "personal",
    );
    const personalTitle = await personal.title();
    const personalTabId = await worker.evaluate(
      async () =>
        (await chrome.tabs.query({ url: "http://loop.example/*" }))[0].id,
    );

    // 2. The popup, as a user drives it: + opens the form, a name is typed, Enter creates the container.
    const pop = await ctx.newPage();
    await pop.setViewportSize({ width: 420, height: 700 });
    await pop.goto(
      `chrome-extension://${extId}/popup.html?tab=${personalTabId}`,
    );
    const main = pop.locator("main.popup");
    await pop.getByRole("heading", { name: "Containers" }).waitFor();
    await settle(pop);
    await sleep(400);
    const rel = async (locator) => {
      const m = await rectOf(main);
      const r = await rectOf(locator);
      return { x: r.x - m.x, y: r.y - m.y, w: r.w, h: r.h };
    };
    const popup = { empty: await steady(() => main.screenshot(still)) };
    const plusBox = await rel(
      pop.getByRole("button", { name: "New container" }),
    );
    await pop.getByRole("button", { name: "New container" }).click();
    const name = pop.getByRole("textbox", { name: "Name" });
    await name.waitFor();
    await sleep(300);
    popup.form = await steady(() => main.screenshot(still));
    const typed = [];
    for (const text of ["W", "Wo", "Wor", "Work"]) {
      await name.fill(text);
      await sleep(150);
      typed.push(await steady(() => main.screenshot(still)));
    }
    popup.typed = typed;
    const createBox = await rel(pop.getByRole("button", { name: "Create" }));
    const nameBox = await rel(name);
    const created = ctx.waitForEvent("page");
    await name.press("Enter");
    const workPage = await created;
    await workPage.waitForLoadState("domcontentloaded").catch(() => undefined);
    await pop.close().catch(() => undefined);

    // 3. The new tab is in the "Work" group. Sign in there as someone else, through the site's own form.
    // The new tab is placed in its container and grouped a moment after it opens: navigate once that has happened
    // (a navigation made earlier can be cut short by the placement), and try again if the form does not show up.
    for (let i = 0; i < 60; i++) {
      const grouped = await worker.evaluate(async () =>
        (await chrome.tabs.query({})).some((t) => t.groupId >= 0),
      );
      if (grouped) break;
      await sleep(150);
    }
    await sleep(600);
    const handleInput = workPage.getByPlaceholder("Handle");
    for (let attempt = 1; ; attempt++) {
      await workPage.goto("http://loop.example/signin");
      try {
        await handleInput.waitFor({ timeout: 5000 });
        break;
      } catch (error) {
        if (attempt === 3) throw error;
      }
    }
    await settle(workPage);
    await sleep(300);
    const signIn = {
      empty: assertSize(
        await steady(() => workPage.screenshot(still)),
        "sign-in",
      ),
    };
    const continueButton = workPage.getByRole("button", { name: "Continue" });
    const handleBox = await rectOf(handleInput);
    const continueBox = await rectOf(continueButton);
    await handleInput.focus();
    await sleep(150);
    signIn.focused = await steady(() => workPage.screenshot(still));
    signIn.typed = [];
    for (let n = 3; n < HANDLE.length; n += 3) {
      await handleInput.fill(HANDLE.slice(0, n));
      signIn.typed.push(await steady(() => workPage.screenshot(still)));
    }
    await handleInput.fill(HANDLE);
    signIn.typed.push(await steady(() => workPage.screenshot(still)));
    await continueButton.click();
    await workPage.waitForURL("http://loop.example/");
    await settle(workPage);
    await sleep(300);
    const workPng = assertSize(
      await steady(() => workPage.screenshot(still)),
      "work",
    );
    const workTitle = await workPage.title();

    // 4. Post as the brand, through the site's own composer.
    const composer = workPage.getByPlaceholder("What's new?");
    const postButton = workPage.getByRole("button", { name: "Post" });
    const composerBox = await rectOf(composer);
    const postBox = await rectOf(postButton);
    await composer.focus();
    await sleep(150);
    const compose = {
      focused: await steady(() => workPage.screenshot(still)),
      typed: [],
    };
    for (let n = 6; n < POST.length; n += 6) {
      await composer.fill(POST.slice(0, n));
      compose.typed.push(await steady(() => workPage.screenshot(still)));
    }
    await composer.fill(POST);
    compose.typed.push(await steady(() => workPage.screenshot(still)));
    await postButton.click();
    await workPage
      .locator(".list li:first-child time", { hasText: "now" })
      .waitFor();
    await settle(workPage);
    await sleep(300);
    compose.posted = assertSize(
      await steady(() => workPage.screenshot(still)),
      "posted",
    );

    // The two tabs must really hold two accounts: that is what the animation claims.
    await personal.reload();
    if (
      !(await personal.locator("nav .me > b").innerText()).startsWith("Dana W.")
    )
      throw new Error("the personal tab lost its account");
    if ((await personal.locator(".list").innerText()).includes(POST))
      throw new Error("the brand post leaked into the personal feed");
    if (
      (await workPage.locator("nav .me > b").innerText()) !== "Northwind Studio"
    )
      throw new Error("the Work tab is not signed in as the brand account");

    const groups = await worker.evaluate(async () => {
      const all = await chrome.tabGroups.query({});
      return all.map((g) => ({ title: g.title ?? "", color: g.color }));
    });
    const group = groups.find((g) => visibleTitle(g.title) !== "");
    if (!group) throw new Error("no tab group was made for the container");
    return {
      personal: personalPng,
      work: workPng,
      personalTitle,
      workTitle,
      popup,
      plusBox,
      createBox,
      nameBox,
      signIn,
      handleBox,
      continueBox,
      compose,
      composerBox,
      postBox,
      group: { title: visibleTitle(group.title), color: group.color },
    };
  } finally {
    await ctx.close().catch(() => undefined);
    server.close();
    rmSync(profile, { recursive: true, force: true });
  }
}

/**
 * Two accounts of the demo social network in two containers, both tabs OUT of their groups (what Chrome does with the tabs of a
 * split view), as the real extension then shows them: "⧉ " in front of the title. Chrome's split view itself cannot be
 * driven from Playwright; each half is photographed at half the window's width, the pair is composed by scenes.mjs.
 * The Chrome Web Store pictures (scripts/store-assets.mjs) take the same pair at their own size and at 2x.
 * @param {string} extension folder of the built Lite extension
 * @param {{ scale?: number, width?: number, height?: number, port?: number }} [options] picture scale, size of each
 *   half in CSS pixels and the demo server's port (the README's own by default)
 */
export async function captureSplitView(extension, options = {}) {
  const {
    scale = 1,
    width: half = (CONTENT.w - 2) / 2,
    height = CONTENT.h,
    port = PORT,
  } = options;
  const server = await startDemoSite(port);
  const profile = mkdtempSync(resolve(tmpdir(), "splitsession-readme-"));
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    deviceScaleFactor: scale,
    viewport: { width: half, height },
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      `--host-resolver-rules=MAP *.example 127.0.0.1:${port}`,
      ...RASTER,
    ],
  });
  try {
    const worker =
      ctx.serviceWorkers()[0] ??
      (await ctx.waitForEvent("serviceworker", { timeout: 15_000 }));
    const api = (method, ...args) =>
      worker.evaluate(([m, a]) => globalThis.facet[m](...a), [method, args]);
    await api("listContainers");
    const made = {
      work: await api("createContainer", { name: "Work", color: "blue" }),
      personal: await api("createContainer", {
        name: "Personal",
        color: "green",
      }),
    };
    const open = async (user) => {
      const created = ctx.waitForEvent("page");
      const tabId = await api(
        "openInContainer",
        `http://loop.example/login?user=${{ work: "northwind_studio", personal: "dana" }[user]}`,
        made[user].id,
      );
      const page = await created;
      await page.waitForURL("http://loop.example/", { timeout: 15_000 });
      await page.evaluate(() => document.fonts.ready);
      return { tabId, page };
    };
    const tabs = { work: await open("work"), personal: await open("personal") };
    // Out of the group, as in a split view. The page title then gets its mark.
    await sleep(800);
    await worker.evaluate(
      (ids) => chrome.tabs.ungroup(ids),
      [tabs.work.tabId, tabs.personal.tabId],
    );
    const out = {};
    for (const user of ["work", "personal"]) {
      const { page } = tabs[user];
      for (let i = 0; !(await page.title()).startsWith("⧉"); i++) {
        if (i > 40) throw new Error(`the ${user} tab never got its ⧉ mark`);
        await sleep(150);
      }
      await page.bringToFront();
      await sleep(300);
      out[user] = {
        png: assertSize(
          await steady(() => page.screenshot({ animations: "disabled" })),
          user,
          { width: half, height },
          scale,
        ),
        title: await page.title(),
        color: made[user].color,
        name: made[user].name,
      };
    }
    if (
      !(await tabs.work.page.locator("nav .me > b").innerText()).startsWith(
        "Northwind Studio",
      )
    )
      throw new Error("the Work tab is not the brand account");
    if (
      !(await tabs.personal.page.locator("nav .me > b").innerText()).startsWith(
        "Dana W.",
      )
    )
      throw new Error("the Personal tab is not the personal account");
    return out;
  } finally {
    await ctx.close().catch(() => undefined);
    server.close();
    rmSync(profile, { recursive: true, force: true });
  }
}

/** @param {string} extension folder of the built Lite extension */
export async function captureInstall(extension) {
  rmSync(resolve(UNPACKED, ".."), { recursive: true, force: true });
  mkdirSync(resolve(UNPACKED, ".."), { recursive: true });
  cpSync(extension, UNPACKED, { recursive: true });
  const still = { animations: "disabled" };
  const open = async (withExtension) => {
    const profile = mkdtempSync(resolve(tmpdir(), "splitsession-readme-"));
    const ctx = await chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: true,
      deviceScaleFactor: 1,
      viewport: VIEWPORT,
      args: withExtension
        ? [
            `--disable-extensions-except=${UNPACKED}`,
            `--load-extension=${UNPACKED}`,
            ...RASTER,
          ]
        : RASTER,
    });
    if (withExtension && ctx.serviceWorkers().length === 0)
      await ctx.waitForEvent("serviceworker", { timeout: 15_000 });
    const page = await ctx.newPage();
    await page.goto("chrome://extensions");
    await sleep(1200);
    return { ctx, page, profile };
  };

  const before = await open(false);
  let pictures;
  try {
    const { page } = before;
    const devMode = page.locator("#devMode");
    const devModeBox = await rectOf(devMode);
    const off = assertSize(
      await steady(() => page.screenshot(still)),
      "extensions, developer mode off",
    );
    await devMode.click();
    await sleep(900);
    const on = assertSize(
      await steady(() => page.screenshot(still)),
      "extensions, developer mode on",
    );
    const loadUnpackedBox = await rectOf(page.locator("#loadUnpacked"));
    pictures = { off, on, devModeBox, loadUnpackedBox };
  } finally {
    await before.ctx.close().catch(() => undefined);
    rmSync(before.profile, { recursive: true, force: true });
  }

  const after = await open(true);
  try {
    const { page } = after;
    if (
      (await page.locator("#devMode").getAttribute("aria-pressed")) !== "true"
    ) {
      await page.locator("#devMode").click();
      await sleep(900);
    }
    await page.locator("extensions-item").first().waitFor();
    pictures.card = assertSize(
      await steady(() => page.screenshot(still)),
      "extensions, with the extension",
    );
  } finally {
    await after.ctx.close().catch(() => undefined);
    rmSync(after.profile, { recursive: true, force: true });
    rmSync(resolve(UNPACKED, ".."), { recursive: true, force: true });
  }
  return pictures;
}
