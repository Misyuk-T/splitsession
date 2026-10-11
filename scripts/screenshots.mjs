// Captures the README screenshots of the popup, options page and choose page (light and dark) into docs/screenshots/.
//
//   pnpm build && pnpm build:lite && node bridge/build.mjs && node scripts/screenshots.mjs [outDir]
//
// With the Lite build present (.output/lite/chrome-mv3) it also shoots the Lite popup (popup-lite-*).
//
// Launches Playwright's Chromium with the built extension (.output/chrome-mv3) and the e2e stand, seeds a few demo
// containers, tabs and rules, connects the agent bridge to a real (temporary) host and lets an MCP client do a few
// things so the popup shows its "recent actions", and takes the pictures. Needs `pnpm exec playwright install chromium`
// once. Nothing outside a temporary directory is touched (the host manifest goes into the temporary profile).
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from '@playwright/test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv[2] ?? resolve(root, 'docs/screenshots'));
const extension = resolve(root, '.output/chrome-mv3');
const EXT_ID = 'hapfikidacgfgnnajkgnaednpgnhmffk';
const PORT = 47399;
mkdirSync(out, { recursive: true });

const stand = spawn(process.execPath, [resolve(root, 'test-server/server.mjs'), String(PORT)], { stdio: 'ignore' });
const userDataDir = mkdtempSync(resolve(tmpdir(), 'facet-shots-'));
// Unix socket paths are short: a directory directly under /tmp.
const socketDir = mkdtempSync(resolve('/tmp', 'fb-shots-'));
const socketPath = resolve(socketDir, 'bridge.sock');
const nativeHostsDir = resolve(userDataDir, 'NativeMessagingHosts');
mkdirSync(nativeHostsDir);
execFileSync(process.execPath, [resolve(root, 'scripts/bridge-install.mjs'), '--dir', nativeHostsDir, '--host-dir', resolve(userDataDir, 'facet-host'), '--no-build'], { stdio: 'pipe' });
const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  env: { ...process.env, FACET_BRIDGE_SOCKET: socketPath },
});
let mcp = null;

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
  await new Promise((r) => setTimeout(r, 800));

  // The agent bridge, connected, with a few things the "agent" just did.
  await api('updateSettings', { agentBridge: true });
  const connected = async () => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if ((await api('getBridgeState')).status === 'connected') return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('the agent bridge did not connect');
  };
  await connected();
  mcp = new Client({ name: 'facet-screenshots', version: '0.0.0' });
  await mcp.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [resolve(root, 'bridge/dist/splitsession-bridge.mjs'), 'mcp'],
      env: { ...process.env, FACET_BRIDGE_SOCKET: socketPath, FACET_BRIDGE_MANIFEST_DIRS: nativeHostsDir },
      stderr: 'pipe',
    }),
  );
  const call = (name, args = {}) => mcp.callTool({ name, arguments: args });
  await call('list_containers');
  await call('list_tabs');
  await call('get_tab_text', { tabId });
  await call('get_tab_html', { tabId, selector: 'body' });
  await call('scroll', { tabId, to: 'bottom' });
  await new Promise((r) => setTimeout(r, 3500)); // the on-page highlight has faded; the popup keeps the list

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
    // 420 x 600: the largest popup Chrome shows.
    await shoot('popup', `popup.html?tab=${tabId}`, { width: 420, height: 600 }, { scheme });
    // The agent row unfolded: the last five actions.
    await shoot('popup-agent', `popup.html?tab=${tabId}`, { width: 420, height: 600 }, {
      scheme,
      before: async (page) => {
        await page.getByRole('button', { name: /^Agent, / }).click();
        await page.waitForTimeout(200);
      },
    });
    await shoot('popup-menu', `popup.html?tab=${tabId}`, { width: 420, height: 600 }, {
      scheme,
      before: async (page) => {
        await page.getByRole('button', { name: /Reopen in/ }).click();
        await page.waitForTimeout(200);
      },
    });
    await shoot('options', 'options.html', { width: 900, height: 900 }, { scheme, fullPage: true });
    await shoot('choose', `choose.html?url=${encodeURIComponent('https://www.reddit.com/r/chrome/')}&tab=${tabId}`, { width: 700, height: 640 }, { scheme });
  }
  // The Lite edition's popup: containers only, no agent row.
  const liteDir = resolve(root, '.output/lite/chrome-mv3');
  if (existsSync(liteDir)) {
    const liteData = mkdtempSync(resolve(tmpdir(), 'facet-shots-lite-'));
    const lite = await chromium.launchPersistentContext(liteData, {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${liteDir}`, `--load-extension=${liteDir}`],
    });
    try {
      const liteWorker = lite.serviceWorkers()[0] ?? (await lite.waitForEvent('serviceworker', { timeout: 15_000 }));
      const liteId = new URL(liteWorker.url()).host;
      const liteApi = (method, ...args) => liteWorker.evaluate(([m, a]) => globalThis.facet[m](...a), [method, args]);
      await liteApi('listContainers');
      const w = await liteApi('createContainer', { name: 'Work', color: 'blue' });
      await liteApi('createContainer', { name: 'Personal', color: 'green' });
      await liteApi('createContainer', { name: 'Client A', color: 'orange' });
      const liteTab = await liteApi('openInContainer', url('a.localhost', '/login?user=work-account'), w.id);
      await liteApi('openInContainer', url('b.localhost'), w.id);
      for (const scheme of ['light', 'dark']) {
        const page = await lite.newPage();
        await page.setViewportSize({ width: 420, height: 600 });
        await page.emulateMedia({ colorScheme: scheme });
        await page.goto(`chrome-extension://${liteId}/popup.html?tab=${liteTab}`);
        await page.waitForTimeout(500);
        await page.screenshot({ path: resolve(out, `popup-lite-${scheme}.png`) });
        await page.close();
        console.log(`popup-lite-${scheme}.png`);
      }
    } finally {
      await lite.close();
      rmSync(liteData, { recursive: true, force: true });
    }
  }
} finally {
  await mcp?.close().catch(() => {});
  await context.close();
  stand.kill();
  rmSync(userDataDir, { recursive: true, force: true });
  rmSync(socketDir, { recursive: true, force: true });
}
