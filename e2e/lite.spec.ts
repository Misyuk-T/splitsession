import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { at, go, pageJson } from './fixtures';

/**
 * Lite edition smoke (docs/decisions.md, "Two editions"): loads `.output/lite/chrome-mv3` (`pnpm build:lite`) in its own
 * browser, apart from the Full build every other spec uses. Containers and login isolation work; the agent side is
 * not there: no bridge / debugger permissions, no bridge in the interface, no API for them.
 */
const LITE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.output/lite/chrome-mv3');

test.skip(!existsSync(path.join(LITE_PATH, 'manifest.json')), 'Lite build missing: run `pnpm build:lite` (or `pnpm e2e:lite`)');
test.describe.configure({ mode: 'serial' });

let userDataDir = '';
let context: BrowserContext;
let worker: Worker;
let extId = '';
const ext = (p: string) => `chrome-extension://${extId}/${p}`;
const api = <T = unknown>(method: string, ...args: unknown[]): Promise<T> =>
  worker.evaluate(
    async ([m, a]) => {
      const facet = (globalThis as unknown as { facet: Record<string, (...x: unknown[]) => Promise<unknown>> }).facet;
      return facet[m as string]!(...(a as unknown[]));
    },
    [method, args] as const,
  ) as Promise<T>;

test.beforeAll(async () => {
  userDataDir = mkdtempSync(path.join(tmpdir(), 'splitsession-lite-e2e-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: !process.env.HEADED,
    args: [`--disable-extensions-except=${LITE_PATH}`, `--load-extension=${LITE_PATH}`],
  });
  worker = context.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://')) ?? (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
  extId = new URL(worker.url()).host;
  await api('listContainers'); // waits for the worker to be ready
  await api('updateSettings', { strictMode: true }); // the isolation steady state (as in the Full fixtures)
});

test.afterAll(async () => {
  await context?.close();
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
});

async function openIn(container: string, url: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(ext(`open.html?container=${encodeURIComponent(container)}&url=${encodeURIComponent(url)}`));
  await expect.poll(() => page.url(), { timeout: 10_000 }).toMatch(/^http:/);
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  return page;
}

test.describe('Lite edition', () => {
  test('manifest and worker: no agent bridge permissions, no key', async () => {
    const manifest = await worker.evaluate(() => (globalThis as any).chrome.runtime.getManifest());
    const all = [...(manifest.permissions ?? []), ...(manifest.optional_permissions ?? [])];
    for (const forbidden of ['nativeMessaging', 'debugger', 'userScripts']) expect(all).not.toContain(forbidden);
    for (const kept of ['sessions', 'tabGroups', 'webNavigation', 'declarativeNetRequest']) expect(manifest.permissions).toContain(kept);
    expect(manifest.name).toBe('SplitSession: Multiple Logins per Site');
    expect(manifest.key).toBeUndefined();
    // Chrome does not even define the APIs those permissions would give.
    const apis = await worker.evaluate(() => {
      const c = (globalThis as any).chrome;
      return { debugger: typeof c.debugger, connectNative: typeof c.runtime.connectNative, userScripts: typeof c.userScripts };
    });
    expect(apis).toEqual({ debugger: 'undefined', connectNative: 'undefined', userScripts: 'undefined' });
  });

  test('settings and API: only the shared settings exist, the bridge API does not', async () => {
    const settings = await api<Record<string, boolean>>('getSettings');
    expect(Object.keys(settings).sort()).toEqual(['restoreTabs', 'strictMode', 'tabGroups']);
    await expect(api('updateSettings', { agentBridge: true })).rejects.toThrow(/unknown setting/);
    await expect(api('updateSettings', { showNameToPages: true })).rejects.toThrow(/unknown setting/);
    await expect(api('getBridgeState')).rejects.toThrow();
    // Through the message path extension pages use, too.
    const page = await context.newPage();
    await page.goto(ext('options.html'));
    const reply = await page.evaluate(async () => (globalThis as any).chrome.runtime.sendMessage({ type: 'facet/api', method: 'getBridgeState', args: [] }));
    await page.close();
    expect(reply).toMatchObject({ ok: false });
  });

  test('two containers: a 302 login with an HttpOnly cookie stays apart from a plain tab and the real profile', async () => {
    const A = await api<{ id: string; name: string }>('createContainer', { name: 'Lite-A' });
    const B = await api<{ id: string; name: string }>('createContainer', { name: 'Lite-B' });
    const pa = await openIn(A.name, at('a.localhost', '/login?user=alice'));
    const pb = await openIn(B.name, at('a.localhost', '/login?user=bob'));
    await expect(pa.locator('#user')).toHaveText('alice');
    await expect(pb.locator('#user')).toHaveText('bob');
    expect((await pageJson(pa, '/me')).user).toBe('alice');
    expect((await pageJson(pb, '/me')).user).toBe('bob');
    await pa.reload();
    await expect(pa.locator('#user')).toHaveText('alice');

    const plain = await context.newPage();
    await api('flushRestore');
    await plain.goto(at('a.localhost', '/whoami'));
    await expect(plain.locator('#user')).toHaveText('anonymous');
    expect(await context.cookies(at('a.localhost'))).toEqual([]);
    expect(await pa.evaluate(() => document.cookie)).not.toContain('sid=');

    // Lite shows no container name to pages: no data-ctr, no title prefix.
    expect(await pa.evaluate(() => document.documentElement.dataset.ctr)).toBeUndefined();
    expect(await pa.title()).not.toContain(A.name);

    await go(plain, at('a.localhost', '/login?user=real'));
    await expect(plain.locator('#user')).toHaveText('real');
    await go(pa, at('a.localhost', '/login?user=alice2'));
    await expect(pa.locator('#user')).toHaveText('alice2');
    expect((await pageJson(pb, '/me')).user).toBe('bob');
    for (const p of [pa, pb, plain]) await p.close();
  });

  test('popup renders containers without a bridge section', async () => {
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 380, height: 700 });
    await popup.goto(ext('popup.html'));
    await expect(popup.getByRole('heading', { name: 'Containers' })).toBeVisible();
    await expect(popup.getByTestId('container-row').filter({ hasText: 'Lite-A' })).toHaveCount(1);
    await expect(popup.getByRole('button', { name: 'New container' })).toBeVisible();
    await expect(popup.getByText(/agent/i)).toHaveCount(0);
    await expect(popup.getByText(/bridge/i)).toHaveCount(0);
    await expect(popup.getByRole('button', { name: 'More', exact: true })).toHaveCount(0); // no header overflow menu
    await expect(popup.getByRole('switch')).toHaveCount(0);
    await expect(popup.getByRole('button', { name: /MCP/ })).toHaveCount(0); // no agent entry point in Lite
    await expect(popup.getByText('MCP')).toHaveCount(0);

    const font = await popup.evaluate(async () => {
      await document.fonts.ready;
      const loaded = [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family);
      return { body: getComputedStyle(document.body).fontFamily, loaded, title: getComputedStyle(document.querySelector('h1')!).fontFamily };
    });
    expect(font.body.replace(/"/g, '')).toMatch(/^Inter Variable,/);
    expect(font.title.replace(/"/g, '')).toMatch(/^Inter Variable,/);
    expect(font.loaded.some((f) => /Inter/.test(f))).toBe(true); // the bundled file really loaded (nothing is fetched from the network)
    await popup.close();
  });

  test('options: general, rules, export and import, without the agent sections and switches', async () => {
    const options = await context.newPage();
    await options.goto(ext('options.html'));
    await expect(options.getByRole('heading', { name: 'General' })).toBeVisible();
    await expect(options.getByText('Show containers as tab groups')).toBeVisible();
    await expect(options.getByText('Restore container tabs after restart')).toBeVisible();
    await expect(options.getByRole('heading', { name: 'Domain rules' })).toBeVisible();
    await expect(options.getByRole('heading', { name: 'Advanced' })).toBeVisible();
    await expect(options.getByRole('button', { name: 'Export and import' })).toBeVisible();
    expect(await options.locator('main h2').allInnerTexts()).toEqual(['General', 'Domain rules', 'Advanced']);
    expect(await options.locator('.opt-nav a').allInnerTexts()).toEqual(['General', 'Domain rules', 'Advanced']);
    await options.goto(ext('options.html#transfer'));
    await expect(options.getByRole('button', { name: 'Export and import' })).toHaveAttribute('aria-expanded', 'true');
    await expect(options.getByRole('link', { name: 'AI agent' })).toHaveCount(0);
    await expect(options.locator('#agent')).toHaveCount(0);
    await expect(options.getByText(/agent/i)).toHaveCount(0);
    await expect(options.getByText(/Show the container name to pages/)).toHaveCount(0);
    await expect(options.getByText(/container name in front of tab titles/i)).toHaveCount(0);
    await expect(options.getByText(/userScripts/i)).toHaveCount(0);
    await options.close();
  });
});
