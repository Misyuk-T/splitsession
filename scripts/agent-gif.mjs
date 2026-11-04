// Regenerates the animation of the agent bridge into docs/media/:
//
//   pnpm agent:gif [out.gif [stillsDir]]   (builds the bridge and the STORE edition in basic mode; needs `pnpm exec playwright install chromium` once)
//
//   agent-bridge.gif   880x600   an AI agent's terminal types a request and calls the tools, and the browser shows each effect
//
// Same size, frame rate, captions, window and GIF encoder as the README animations (scripts/readme-media/). The story is about
// 10 s and loops: the request is typed; list_tabs, snapshot (Brand), type, click "Post" and get_tab_text follow one by one, with
// the Brand container tab as it is after each call (glow, "Agent: reading / typing / clicking" pill, the text in the composer, the
// post first in the feed); it ends on the closing line and holds.
//
// REAL: the store build in basic mode (as scripts/store-agent.mjs: FACET_EDITION=store with the test-only FACET_TEST_GRANT_NM=1,
// built into .output/store-agent/ and removed afterwards), the bridge's own MCP server driven by a real MCP client, the Loop demo
// site (scripts/store-assets/loop-site.mjs) in two containers, the pictures of the Brand tab (1x) after each call, the tab strip
// and the pill's verb as Chrome and the extension have them, and the numbers in the terminal lines (the tools' answers). Only
// basic-mode tools are called. DRAWN: the terminal, the browser window, the captions. The page is one picture per call: a call
// is one instant, so the text in the composer shows up at once, as the tool does it. Nothing leaves the machine; only a
// temporary profile is touched. The glow breathes on the wall clock, so each picture is taken at the top of a breath.
// With a second argument, the first and last frame are also saved there as PNG (to look at them).
/* eslint-disable import/extensions -- local .mjs modules, run directly by node */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

import { captureAgent } from "./agent-media/capture.mjs";
import { agentGif, VIEWPORT } from "./agent-media/gif-scenes.mjs";
import { sessionOf } from "./agent-media/session.mjs";
import { RASTER } from "./readme-media/capture.mjs";
import { encodeGif } from "./readme-media/gif.mjs";
import { SIZE } from "./readme-media/mock.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(
  process.argv[2] ?? resolve(root, "docs/media/agent-bridge.gif"),
);
const stills = process.argv[3] ? resolve(process.argv[3]) : null;
const outDir = resolve(root, ".output/store-agent");
const MAX_BYTES = 4 * 1024 * 1024;
mkdirSync(dirname(out), { recursive: true });
if (stills) mkdirSync(stills, { recursive: true });

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
    scale: 1,
    frames: true,
  });
  for (const f of cap.frames) {
    const png = f.png;
    if (
      png.readUInt32BE(16) !== VIEWPORT.width ||
      png.readUInt32BE(20) !== VIEWPORT.height
    )
      throw new Error(`the picture "${f.name}" has the wrong size`);
  }
  // After the click the page is a new document: it has the glow again at once, the click's pill is gone with the old one.
  const verbs = cap.frames.map((f) => f.pill).join(",");
  if (verbs !== ",,reading,typing,,reading")
    throw new Error(`unexpected pills: ${verbs}`);
  const text = cap.calls.find((c) => c.name === "get_tab_text").text;
  if (
    text.indexOf("@priya_n Thanks!") < 0 ||
    text.indexOf("@priya_n Thanks!") > text.indexOf("Priya Nair")
  )
    throw new Error("the reply is not the first post of the feed");
  const script = sessionOf(
    cap,
    "Reply to Priya's note on the Brand account on Loop.",
    "Replied to @priya_n from the Brand account.",
  );

  const browser = await chromium.launch({ channel: "chromium", args: RASTER });
  try {
    const frames = await agentGif(browser, cap, script);
    const gif = encodeGif(frames, SIZE);
    if (gif.length > MAX_BYTES)
      throw new Error(
        `${(gif.length / 1048576).toFixed(2)} MB, over the 4 MB limit`,
      );
    writeFileSync(out, gif);
    const seconds = frames.reduce((sum, f) => sum + f.ms, 0) / 1000;
    console.log(
      `${out}  ${SIZE.width}x${SIZE.height}  ${frames.length} frames  ${seconds.toFixed(1)} s  ${(gif.length / 1024).toFixed(0)} KB`,
    );
    if (stills) {
      frames.forEach((f, i) => {
        if (i % 6 === 0 || i === frames.length - 1)
          writeFileSync(
            resolve(stills, `agent-${String(i).padStart(2, "0")}.png`),
            f.png,
          );
      });
    }
  } finally {
    await browser.close();
  }
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
