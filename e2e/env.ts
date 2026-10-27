import path from "node:path";
import { fileURLToPath } from "node:url";

export const TEST_PORT = Number(process.env.FACET_TEST_PORT ?? 47321);
/**
 * The suite runs the unpacked Full (pinned key, wxt.config.ts): `hapfikidacgfgnnajkgnaednpgnhmffk`. The store item has
 * `STORE_ID` (hhodioekcdmhpocjbkjnblmbmchddphf), which a local build gets only through a test key (store-upgrade.spec.ts
 * uses a throwaway one instead); src/core/copies.ts holds both.
 */
export const EXTENSION_ID = "hapfikidacgfgnnajkgnaednpgnhmffk";
export const STORE_ID = "hhodioekcdmhpocjbkjnblmbmchddphf";
export const EXTENSION_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.output/chrome-mv3",
);
export const at = (host: string, p = "/") => `http://${host}:${TEST_PORT}${p}`;
/** Address of a page of the extension. */
export const ext = (p: string) => `chrome-extension://${EXTENSION_ID}/${p}`;
