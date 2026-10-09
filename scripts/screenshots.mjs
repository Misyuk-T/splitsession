// Captures the README screenshots of the popup, options page and choose page (light and dark) into docs/screenshots/.
//
//   pnpm build && node scripts/screenshots.mjs [outDir]
//
// Launches Playwright's Chromium with the built extension (.output/chrome-mv3) and the e2e stand, seeds a few demo
// containers, tabs and rules, and takes the pictures. Needs `pnpm exec playwright install chromium` once.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv[2] ?? resolve(root, 'docs/screenshots'));
const extension = resolve(root, '.output/chrome-mv3');
const EXT_ID = 'hapfikidacgfgnnajkgnaednpgnhmffk';
const PORT = 47399;
mkdirSync(out, { recursive: true });

const stand = spawn(process.execPath, [resolve(root, 'test-server/server.mjs'), String(PORT)], { stdio: 'ignore' });
const userDataDir = mkdtempSync(resolve(tmpdir(), 'facet-shots-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});

try {
  const worker = context.serviceWorkers().find((w) => w.url().includes(EXT_ID)) ?? (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
  const api = (method, ...args) =>
    worker.evaluate(([m, a]) => globalThis.facet[m](...a), [method, args]);
  await api('listContainers');

  const work = await api('createContainer', { name: 'Work', color: 'blue' });
  const personal = await api('createContainer', { name: 'Personal', color: 'green' });
  await api('createContainer', { name: 'Client A', color: 'orange' });
  await api('createContainer', { name: 'Side project', color: 'purple' });
  const url = (host, path = '/whoami') => `http://${host}:${PORT}${path}`;
  const tabId = await api('openInContainer', url('a.localhost', '/login?user=work-account'), work.id);
  await api('openInContainer', url('b.localhost'), work.id);
  await api('openInContainer', url('sso.localhost', '/sso/login?user=me'), personal.id);
  await api('setDomainRule', { domain: 'github.com', action: 'always', containerId: work.id });
  await api('setDomainRule', { domain: 'reddit.com', action: 'ask' });
  await api('setDomainRule', { domain: 'threads.com', action: 'always', containerId: personal.id });
  // The usual state: the user said yes to strict mode when the first container appeared (no dialog, no warning).
  await api('grantStrictMode');
  await new Promise((r) => setTimeout(r, 800));

  const shoot = async (name, path, viewport, { scheme, fullPage = false, before } = {}) => {
    const page = await context.newPage();
    await page.setViewportSize(viewport);
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(`chrome-extension://${EXT_ID}/${path}`);
    await page.waitForTimeout(500);
    if (before) await before(page);
    await page.screenshot({ path: resolve(out, `${name}-${scheme}.png`), fullPage });
    await page.close();
    console.log(`${name}-${scheme}.png`);
  };

  for (const scheme of ['light', 'dark']) {
    await shoot('popup', `popup.html?tab=${tabId}`, { width: 380, height: 560 }, { scheme, fullPage: true });
    await shoot('popup-menu', `popup.html?tab=${tabId}`, { width: 380, height: 560 }, {
      scheme,
      before: async (page) => {
        await page.getByRole('button', { name: /Reopen this tab in/ }).click();
        await page.waitForTimeout(200);
      },
    });
    await shoot('options', 'options.html', { width: 900, height: 900 }, { scheme, fullPage: true });
    await shoot('choose', `choose.html?url=${encodeURIComponent('https://www.reddit.com/r/chrome/')}&tab=${tabId}`, { width: 700, height: 640 }, { scheme });
  }
} finally {
  await context.close();
  stand.kill();
  rmSync(userDataDir, { recursive: true, force: true });
}
