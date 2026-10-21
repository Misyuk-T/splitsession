import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
  type Worker,
} from "@playwright/test";

/**
 * Two enabled copies of SplitSession in one profile (docs/decisions.md, "Duplicate copies"): each popup and the settings
 * page warn about the other; with one copy alone there is no warning.
 *
 * The copies are the Lite build (`.output/lite/chrome-mv3`, `pnpm build:lite`) and a Full build made here on purpose:
 * a local Lite has a path-derived ID, which no release build knows, so Full is built into `.output/dup-test` with that ID
 * added to its known copies (build-time hook FACET_TEST_COPY_IDS, wxt.config.ts; there is no runtime setting for it).
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LITE_PATH = path.join(ROOT, ".output/lite/chrome-mv3");
const FULL_OUT = path.join(ROOT, ".output/dup-test");
const FULL_PATH = path.join(FULL_OUT, "chrome-mv3");
const FULL_ID = "hapfikidacgfgnnajkgnaednpgnhmffk"; // fixed by the extension key (wxt.config.ts)
const VERSION = (
  JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
    version: string;
  }
).version;

/** The ID Chrome gives an unpacked extension: the first 16 bytes of the SHA-256 of its path, each nibble as a letter a-p. */
const pathId = (dir: string): string =>
  [...createHash("sha256").update(realpathSync(dir)).digest().subarray(0, 16)]
    .map(
      (byte) => "abcdefghijklmnop"[byte >> 4]! + "abcdefghijklmnop"[byte & 15]!,
    )
    .join("");

test.skip(
  !existsSync(path.join(LITE_PATH, "manifest.json")),
  "Lite build missing: run `pnpm build:lite`",
);
test.describe.configure({ mode: "serial" });

let liteId = "";
const dirs: string[] = [];

test.beforeAll(() => {
  liteId = pathId(LITE_PATH);
  execFileSync("pnpm", ["exec", "wxt", "build"], {
    cwd: ROOT,
    stdio: "ignore",
    env: {
      ...process.env,
      FACET_EDITION: "full",
      FACET_OUT_DIR: FULL_OUT,
      FACET_TEST_COPY_IDS: liteId,
    },
  });
});

test.afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  rmSync(FULL_OUT, { recursive: true, force: true });
});

/** One Chromium profile with the given unpacked extensions, their service workers up. */
async function launch(paths: string[]): Promise<BrowserContext> {
  const userDataDir = mkdtempSync(path.join(tmpdir(), "splitsession-dup-e2e-"));
  dirs.push(userDataDir);
  const list = paths.join(",");
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: !process.env.HEADED,
    args: [`--disable-extensions-except=${list}`, `--load-extension=${list}`],
  });
  const hosts = () =>
    new Set(context.serviceWorkers().map((w: Worker) => new URL(w.url()).host));
  await expect
    .poll(
      async () => {
        for (const id of paths.map((p) => (p === LITE_PATH ? liteId : FULL_ID)))
          if (!hosts().has(id)) {
            // A worker that is not up yet: wait for it, or the browser has not started it (no event arrives)
            await context
              .waitForEvent("serviceworker", { timeout: 1_000 })
              .catch(() => {});
          }
        return paths.every((p) =>
          hosts().has(p === LITE_PATH ? liteId : FULL_ID),
        );
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  return context;
}

const popupOf = async (context: BrowserContext, id: string): Promise<Page> => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 420, height: 800 });
  await page.goto(`chrome-extension://${id}/popup.html`);
  await expect(page.getByRole("heading", { name: "Containers" })).toBeVisible();
  return page;
};

const notice = (page: Page) => page.getByTestId("duplicate-copy-notice");

test.describe("two copies in one profile", () => {
  test("the build knows the local Lite's ID (path-derived)", async () => {
    const context = await launch([LITE_PATH]);
    try {
      expect(
        context.serviceWorkers().map((w: Worker) => new URL(w.url()).host),
      ).toEqual([liteId]);
    } finally {
      await context.close();
    }
  });

  test("each copy's popup and settings warn about the other, with edition and version", async () => {
    const context = await launch([FULL_PATH, LITE_PATH]);
    try {
      const fullPopup = await popupOf(context, FULL_ID);
      await expect(notice(fullPopup)).toContainText(
        `Another copy of SplitSession is on (Lite ${VERSION})`,
      );
      await expect(notice(fullPopup)).toContainText(
        "keep one and turn the other off in chrome://extensions",
      );

      const litePopup = await popupOf(context, liteId);
      await expect(notice(litePopup)).toContainText(
        `Another copy of SplitSession is on (Full ${VERSION})`,
      );
      // The notice sits at the top, under the header and above the container list.
      const noticeTop = (await notice(litePopup).boundingBox())!.y;
      const listTop = (await litePopup
        .getByRole("heading", { name: "Containers" })
        .boundingBox())!.y;
      expect(noticeTop).toBeLessThan(listTop);

      for (const id of [FULL_ID, liteId]) {
        const options = await context.newPage();
        await options.goto(`chrome-extension://${id}/options.html`);
        await expect(
          options.getByRole("heading", { name: "General" }),
        ).toBeVisible();
        await expect(notice(options)).toContainText(
          "Another copy of SplitSession is on",
        );
        const general = await options.locator("#general").boundingBox();
        const noticeBox = await notice(options).boundingBox();
        expect(noticeBox!.y).toBeGreaterThan(general!.y);
        expect(noticeBox!.y).toBeLessThan(general!.y + 120); // at the top of General
        await options.close();
      }
      await fullPopup.close();
      await litePopup.close();
    } finally {
      await context.close();
    }
  });

  test('"Open extensions" opens chrome://extensions for the other copy', async () => {
    const context = await launch([FULL_PATH, LITE_PATH]);
    try {
      const popup = await popupOf(context, FULL_ID);
      await expect(notice(popup)).toBeVisible();
      const opened = context.waitForEvent("page", { timeout: 10_000 });
      await popup.getByRole("button", { name: "Open extensions" }).click();
      const tab = await opened;
      await expect
        .poll(() => tab.url(), { timeout: 10_000 })
        .toBe(`chrome://extensions/?id=${liteId}`);
    } finally {
      await context.close();
    }
  });

  test("a copy that is alone gets no warning", async () => {
    for (const [dir, id] of [
      [FULL_PATH, FULL_ID],
      [LITE_PATH, liteId],
    ] as const) {
      const context = await launch([dir]);
      try {
        const popup = await popupOf(context, id);
        // Give a ping time to fail (nothing is there to answer) and the popup time to ask.
        await popup.waitForTimeout(1_500);
        await expect(notice(popup)).toHaveCount(0);
        const options = await context.newPage();
        await options.goto(`chrome-extension://${id}/options.html`);
        await expect(
          options.getByRole("heading", { name: "General" }),
        ).toBeVisible();
        await options.waitForTimeout(500);
        await expect(notice(options)).toHaveCount(0);
      } finally {
        await context.close();
      }
    }
  });
});
