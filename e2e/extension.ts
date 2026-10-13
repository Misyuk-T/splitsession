import {
  type BrowserContext,
  expect,
  type Page,
  type Worker,
} from "@playwright/test";

import { EXTENSION_ID, EXTENSION_PATH } from "./env";

/** Chromium flags that load one unpacked extension (SplitSession Full unless `extensionPath` says otherwise). */
export const extensionArgs = (extensionPath = EXTENSION_PATH): string[] => [
  `--disable-extensions-except=${extensionPath}`,
  `--load-extension=${extensionPath}`,
];

/** SplitSession's own service worker (not another extension's, nor an old worker of another ID). */
export const isOurWorker = (w: { url(): string }): boolean =>
  w.url().startsWith(`chrome-extension://${EXTENSION_ID}/`);

/** The first SplitSession service worker of a context, waiting for one when none runs yet. */
export async function workerOf(ctx: BrowserContext): Promise<Worker> {
  return (
    ctx.serviceWorkers().find(isOurWorker) ??
    ctx.waitForEvent("serviceworker", {
      predicate: isOurWorker,
      timeout: 15_000,
    })
  );
}

/** Calls the background API the worker exposes for tests (`globalThis.facet`, src/background/index.ts). */
export const apiOf =
  (worker: Worker) =>
  <T = unknown>(method: string, ...args: unknown[]): Promise<T> =>
    worker.evaluate(
      async ([m, a]) => {
        const facet = (
          globalThis as unknown as {
            facet: Record<string, (...x: unknown[]) => Promise<unknown>>;
          }
        ).facet;
        return facet[m as string]!(...(a as unknown[]));
      },
      [method, args] as const,
    ) as Promise<T>;

/** The popup as a page of its own (420 x 800), once its container list has rendered. */
export async function popupPage(ctx: BrowserContext): Promise<Page> {
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 420, height: 800 });
  await page.goto(`chrome-extension://${EXTENSION_ID}/popup.html`);
  await expect(page.getByRole("heading", { name: "Containers" })).toBeVisible();
  return page;
}
