// Regenerates the promo picture of the agent bridge into docs/media/:
//
//   pnpm agent:media [out.png]        (builds the FULL edition and the bridge first; needs `pnpm exec playwright install chromium` once)
//
//   agent-bridge.png   1600x900   an AI agent's terminal session next to the browser window it works in
//
// REAL: the Full extension (.output/chrome-mv3) in Playwright's Chromium with the agent bridge switched on; the native host
// registered in a temporary profile only; the bridge's own MCP server driven by a real MCP client (list_tabs, snapshot,
// type, click, get_tab_text) on the demo social network (Loop, scripts/store-assets/loop-site.mjs) in two containers; the
// glow, the "Agent: reading" pill and the favicon dots drawn by the extension's own overlay; the tab groups and the toolbar
// dot as Chrome reports them; the terminal lines are built from the answers of those calls.
// DRAWN: the terminal panel (HTML), the browser window around the page, the caption. Nothing leaves the machine.
// The glow breathes on the wall clock, so two runs differ by a few anti-aliased pixels at most.
/* eslint-disable import/extensions -- local .mjs modules, run directly by node */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

import { captureAgent, REPLY, VIEWPORT } from "./agent-media/capture.mjs";
import { shotAgent, SIZE } from "./agent-media/frames.mjs";
import { RASTER } from "./readme-media/capture.mjs";
import { flattenPng, pngInfo } from "./store-assets/png.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(
  process.argv[2] ?? resolve(root, "docs/media/agent-bridge.png"),
);
mkdirSync(dirname(out), { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cap = await captureAgent(root);
const png2 = cap.shot;
if (
  png2.readUInt32BE(16) !== VIEWPORT.width * 2 ||
  png2.readUInt32BE(20) !== VIEWPORT.height * 2
)
  throw new Error("the page picture has the wrong size");

// The terminal lines come from what the tools answered.
const byName = (n) => cap.calls.find((c) => c.name === n);
const tabs = cap.tabs; // list_tabs answer
const web = tabs.filter((t) => /^https?:/.test(t.url));
const names = web.map((t) => t.container?.name ?? new URL(t.url).host);
const snapshot = JSON.parse(byName("snapshot").text.split("\n")[0]);
const brandTab = web.find((t) => t.container?.name === "Brand");
// What the tools answered: `type` {"typed":70}, `click` {"clicked":"<button>"}, `get_tab_text` the page's text.
const answer = (n) => JSON.parse(byName(n).text.split("\n")[0]);
const text = byName("get_tab_text").text;
if (text.indexOf(REPLY) < 0 || text.indexOf(REPLY) > text.indexOf("Priya Nair"))
  throw new Error("the reply is not the first post of the feed");
const steps = [
  {
    tool: "list_tabs",
    arg: "",
    out: [`${web.length} tabs · ${names.join(" · ")}`],
  },
  {
    tool: "snapshot",
    arg: `(${brandTab.container.name} · ${new URL(brandTab.url).host})`,
    out: [`${snapshot.refs} elements`],
  },
  {
    tool: "type",
    arg: `"What's new?"`,
    out: [`typed ${answer("type").typed} characters`],
  },
  { tool: "click", arg: `"Post"`, out: [`clicked ${answer("click").clicked}`] },
  {
    tool: "get_tab_text",
    arg: "",
    out: ["the new post is first in the feed"],
  },
];
const [r, g, b] = cap.badge.color;

const browser = await chromium.launch({ channel: "chromium", args: RASTER });
try {
  const html = shotAgent({
    shot: png2,
    strip: cap.strip,
    badge: `rgb(${r},${g},${b})`,
    ask: "Reply to Priya's note on the Brand account on Loop.",
    steps,
    done: "Replied to @priya_n from the Brand account.",
    headline: "Your AI agent, working in the right account.",
  });
  const p = await browser.newPage({
    viewport: { width: SIZE.width, height: SIZE.height },
  });
  await p.setContent(html);
  await p.evaluate(() => document.fonts.ready);
  await p.evaluate(() =>
    Promise.all(
      [...document.images].map((i) => i.decode().catch(() => undefined)),
    ),
  );
  await p.evaluate(
    () =>
      new Promise((res) =>
        requestAnimationFrame(() => requestAnimationFrame(res)),
      ),
  );
  await sleep(400);
  const png = flattenPng(await p.screenshot({ animations: "disabled" }));
  const info = pngInfo(png);
  if (info.width !== SIZE.width || info.height !== SIZE.height)
    throw new Error(`${info.width}x${info.height}`);
  writeFileSync(out, png);
  console.log(
    `${out}  ${SIZE.width}x${SIZE.height}  ${(png.length / 1048576).toFixed(2)} MB`,
  );
} finally {
  await browser.close();
}
