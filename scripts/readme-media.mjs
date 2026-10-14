// Regenerates the two animated GIFs of the README into docs/media/:
//
//   pnpm readme:media [outDir]        (builds the Lite edition first; needs `pnpm exec playwright install chromium` once)
//
//   how-it-works.gif   "Two accounts, side by side": two accounts of one site in two tabs of one window
//   install.gif        "Install in Chrome": from a GitHub Release zip to the pinned toolbar button
//   split-view.png     a still: the two accounts as the two halves of Chrome's split view
//
// REAL (Playwright's Chromium with the built Lite extension, .output/lite/chrome-mv3, and the demo sites of
// scripts/store-assets/demo-site.mjs): every picture of the demo mail site, of the popup (+, a name typed, Enter) and
// of chrome://extensions (Developer mode off and on, the extension's card). Chrome's split view cannot be driven from
// Playwright, so the still shows two real container tabs composed as a split pair. DRAWN: the browser window around them, the
// new-tab page, the Releases page, Finder, the file picker (a real OS picker cannot be recorded), the extensions menu,
// the cursor and the captions. Frames are encoded to GIF in pure JS (scripts/readme-media/gif.mjs). Everything is
// fixed (demo data, ports, sizes, timings), nothing leaves the machine, and only temporary profiles are touched.
// With a second argument, the first and last frame of each GIF are also saved there as PNG (to look at them).
/* eslint-disable import/extensions -- local .mjs modules, run directly by node */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

import {
  captureHowItWorks,
  captureInstall,
  captureSplitView,
} from "./readme-media/capture.mjs";
import { encodeGif } from "./readme-media/gif.mjs";
import { SIZE } from "./readme-media/mock.mjs";
import { howItWorks, install, splitView } from "./readme-media/scenes.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, "docs/media");
const stills = process.argv[2] ? resolve(process.argv[2]) : null;
const extension = resolve(root, ".output/lite/chrome-mv3");
mkdirSync(out, { recursive: true });
if (stills) mkdirSync(stills, { recursive: true });

const MAX_BYTES = 4 * 1024 * 1024;

function save(name, frames) {
  const gif = encodeGif(frames, SIZE);
  if (gif.length > MAX_BYTES)
    throw new Error(
      `${name} is ${(gif.length / 1048576).toFixed(2)} MB, over the 4 MB limit`,
    );
  writeFileSync(resolve(out, name), gif);
  const seconds = frames.reduce((sum, f) => sum + f.ms, 0) / 1000;
  console.log(
    `${name}  ${SIZE.width}x${SIZE.height}  ${frames.length} frames  ${seconds.toFixed(1)} s  ${(gif.length / 1048576).toFixed(2)} MB`,
  );
  if (stills) {
    const base = name.replace(/\.gif$/, "");
    writeFileSync(resolve(stills, `${base}-first.png`), frames[0].png);
    writeFileSync(
      resolve(stills, `${base}-last.png`),
      frames[frames.length - 1].png,
    );
  }
}

const how = await captureHowItWorks(extension);
const ext = await captureInstall(extension);
const split = await captureSplitView(extension);
const browser = await chromium.launch({ channel: "chromium" });
try {
  save("how-it-works.gif", await howItWorks(browser, how));
  save("install.gif", await install(browser, ext));
  const still = await splitView(browser, split);
  writeFileSync(resolve(out, "split-view.png"), still);
  console.log(
    `split-view.png  ${SIZE.width}x${SIZE.height}  ${(still.length / 1048576).toFixed(2)} MB`,
  );
  if (stills) writeFileSync(resolve(stills, "split-view.png"), still);
} finally {
  await browser.close();
}
