// Renders assets/icon.svg to public/icons/icon-{16,32,48,128}.png with Playwright's Chromium (no image library needed).
//
//   node scripts/make-icons.mjs
//
// Needs the browser once: `pnpm exec playwright install chromium`. The PNGs are committed, so a normal build does not
// run this; run it after changing assets/icon.svg (and keep src/ui/components/Logo.tsx in step).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const svg = readFileSync(resolve(root, "assets/icon.svg"), "utf8");
const out = resolve(root, "public/icons");
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
try {
  for (const size of [16, 32, 48, 128]) {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    });
    await page.setContent(
      `<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
    );
    const png = await page.screenshot({
      omitBackground: true,
      clip: { x: 0, y: 0, width: size, height: size },
    });
    writeFileSync(resolve(out, `icon-${size}.png`), png);
    await page.close();
    console.log(`public/icons/icon-${size}.png (${png.length} bytes)`);
  }
} finally {
  await browser.close();
}
