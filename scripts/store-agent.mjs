// Regenerates the Chrome Web Store picture of the AI agent into docs/release/assets/:
//
//   pnpm store:agent [out.png]        (builds the STORE edition in basic mode and the bridge first; needs `pnpm exec playwright install chromium` once)
//
//   screenshot-6-ai-agent.png   1280x800   an AI agent's terminal session next to the browser window it works in
//
// The store item is Full in basic mode (no debugger), so this picture is made with the store build itself: FACET_EDITION=store
// with the test-only FACET_TEST_GRANT_NM=1 (nativeMessaging required, because headless Chrome cannot accept the prompt of an
// optional one; e2e/store-basic.spec.ts) and the pinned test key, built into .output/store-agent/ (removed afterwards).
// Everything else is the capture of docs/media/agent-bridge.png (scripts/agent-media.mjs, scripts/agent-media/): the real
// extension, the real bridge driven by a real MCP client, the Loop demo site in two containers, the glow and the "Agent: reading"
// pill drawn by the extension. Only basic-mode tools are called (list_tabs, snapshot, type, click, get_tab_text). The terminal
// panel, the browser window around the page and the caption are drawn (same frame as screenshots 1-5, scripts/store-assets/).
// The picture is flattened to 24-bit RGB (the Store refuses alpha). Nothing leaves the machine; only a temporary profile is
// touched. The glow breathes on the wall clock, so two runs differ by a few anti-aliased pixels at most.
/* eslint-disable import/extensions -- local .mjs modules, run directly by node */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

import { captureAgent, REPLY } from "./agent-media/capture.mjs";
import { shotAgentStore } from "./agent-media/frames.mjs";
import { RASTER } from "./readme-media/capture.mjs";
import { flattenPng, pngInfo } from "./store-assets/png.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(
  process.argv[2] ??
    resolve(root, "docs/release/assets/screenshot-6-ai-agent.png"),
);
const outDir = resolve(root, ".output/store-agent");
const SIZE = { width: 1280, height: 800 };
const WIN = { x: 520, w: 720 }; // the drawn window; the page area is (w - 2) x 522
const VIEWPORT = { width: WIN.w - 2, height: 522 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(dirname(out), { recursive: true });

execFileSync("node", [resolve(root, "bridge/build.mjs")], {
  cwd: root,
  stdio: "ignore",
});
execFileSync("pnpm", ["exec", "wxt", "build"], {
  cwd: root,
  stdio: "ignore",
  env: {
    ...process.env,
    FACET_EDITION: "store",
    FACET_OUT_DIR: outDir,
    FACET_TEST_KEY: readFileSync(
      resolve(root, "extension-key.pub"),
      "utf8",
    ).trim(),
    FACET_TEST_GRANT_NM: "1",
  },
});

try {
  const cap = await captureAgent(root, {
    extension: resolve(outDir, "chrome-mv3"),
    viewport: VIEWPORT,
    consent: true,
  });
  if (
    cap.shot.readUInt32BE(16) !== VIEWPORT.width * 2 ||
    cap.shot.readUInt32BE(20) !== VIEWPORT.height * 2
  )
    throw new Error("the page picture has the wrong size");

  // The terminal lines come from what the tools answered.
  const byName = (n) => cap.calls.find((c) => c.name === n);
  const web = cap.tabs.filter((t) => /^https?:/.test(t.url));
  const names = web.map((t) => t.container?.name ?? new URL(t.url).host);
  const snapshot = JSON.parse(byName("snapshot").text.split("\n")[0]);
  const brandTab = web.find((t) => t.container?.name === "Brand");
  const answer = (n) => JSON.parse(byName(n).text.split("\n")[0]);
  const text = byName("get_tab_text").text;
  if (
    text.indexOf(REPLY) < 0 ||
    text.indexOf(REPLY) > text.indexOf("Priya Nair")
  )
    throw new Error("the reply is not the first post of the feed");
  const steps = [
    {
      tool: "list_tabs",
      arg: "",
      out: [`${web.length} tabs · ${names.join(" · ")}`],
    },
    {
      tool: "snapshot",
      arg: `(${brandTab.container.name})`,
      out: [`${snapshot.refs} elements`],
    },
    {
      tool: "type",
      arg: `"What's new?"`,
      out: [`typed ${answer("type").typed} characters`],
    },
    {
      tool: "click",
      arg: `"Post"`,
      out: [`clicked ${answer("click").clicked}`],
    },
    {
      tool: "get_tab_text",
      arg: "",
      out: ["the new post is first in the feed"],
    },
  ];
  const [r, g, b] = cap.badge.color;

  const browser = await chromium.launch({ channel: "chromium", args: RASTER });
  try {
    const html = shotAgentStore({
      shot: cap.shot,
      strip: cap.strip,
      badge: `rgb(${r},${g},${b})`,
      ask: "Reply to Priya's note on the Brand account on Loop.",
      steps,
      done: "Replied to @priya_n from the Brand account.",
      headline: "Your agent, in the right account.",
      sub: "Optional and off by default. The agent sees each tab with its account.",
      win: WIN,
    });
    const p = await browser.newPage({ viewport: SIZE });
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
    if (
      info.width !== SIZE.width ||
      info.height !== SIZE.height ||
      info.colorType !== 2
    )
      throw new Error(
        `${info.width}x${info.height}, colour type ${info.colorType}`,
      );
    writeFileSync(out, png);
    console.log(`${out}  ${JSON.stringify(info)}`);
  } finally {
    await browser.close();
  }
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
