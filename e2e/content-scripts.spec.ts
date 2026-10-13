import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { EXTENSION_ID, EXTENSION_PATH, TEST_PORT } from './env';
import { at, expect, go, test } from './fixtures';

/**
 * The content scripts (beacon + shim) are registered only while containers are in use (docs/decisions.md, "Content
 * scripts only while containers are in use"). Own browser and profile: the shared one carries containers and managed
 * sites from earlier tests, and the point here is a profile that never had any.
 */

async function workerOf(ctx: BrowserContext): Promise<Worker> {
  const ours = (w: Worker) => w.url().startsWith(`chrome-extension://${EXTENSION_ID}/`);
  return ctx.serviceWorkers().find(ours) ?? ctx.waitForEvent('serviceworker', { predicate: ours, timeout: 15_000 });
}

const apiOf =
  (sw: Worker) =>
  <T = unknown>(method: string, ...args: unknown[]): Promise<T> =>
    sw.evaluate(([m, a]) => (globalThis as any).facet[m as string](...(a as unknown[])), [method, args] as const) as Promise<T>;

const setCookie = (host: string, value: string) => at(host, `/set?c=${encodeURIComponent(`${value}; Path=/`)}`);

/** Opens `url` in a new page and returns it with the beacon requests (to ctr.localhost) its top frame made, seen over CDP. */
async function probe(ctx: BrowserContext, url: string): Promise<{ page: Page; beacon: string[] }> {
  const page = await ctx.newPage();
  const beacon: string[] = [];
  const cdp = await ctx.newCDPSession(page);
  cdp.on('Network.requestWillBeSent', (e: { request: { url: string } }) => {
    if (e.request.url.includes('ctr.localhost')) beacon.push(e.request.url);
  });
  await cdp.send('Network.enable');
  await page.goto(url);
  await page.waitForLoadState('load');
  return { page, beacon };
}

/** The shim marks every realm it patched with `Symbol.for('facet.shim')`. */
const shimmed = (page: Page) => page.evaluate(() => Object.getOwnPropertySymbols(window).some((s) => s.description === 'facet.shim'));

/** What Chrome has: registered scripts, enabled static rulesets, the global dynamic beacon answers (IDs 1, 2). */
const chromeState = (sw: Worker) =>
  sw.evaluate(async () => {
    const c = (globalThis as any).chrome;
    const scripts = await c.scripting.getRegisteredContentScripts();
    return {
      scripts: scripts.map((s: { id: string; matches: string[] }) => `${s.id} ${[...s.matches].sort().join(' ')}`),
      rulesets: (await c.declarativeNetRequest.getEnabledRulesets()) as string[],
      beaconDynamic: ((await c.declarativeNetRequest.getDynamicRules()) as Array<{ id: number }>).map((r) => r.id).filter((id) => id === 1 || id === 2),
    };
  });

/** `navigator.serviceWorker.register` from a CDP isolated world: a realm SplitSession's shim never patches. */
async function registerFromUnpatchedRealm(ctx: BrowserContext, page: Page): Promise<string> {
  const cdp = await ctx.newCDPSession(page);
  const { frameTree } = (await cdp.send('Page.getFrameTree')) as { frameTree: { frame: { id: string } } };
  const { executionContextId } = (await cdp.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'unpatched' })) as { executionContextId: number };
  const raw = (await cdp.send('Runtime.evaluate', {
    contextId: executionContextId,
    awaitPromise: true,
    expression: `navigator.serviceWorker.register('/sw.js').then(() => 'registered', (e) => 'refused: ' + e.name)`,
  })) as { result: { value: string } };
  await cdp.detach();
  return raw.result.value;
}

/** Same isolated-world trick to read the origin's raw localStorage keys (what the real profile's pages hold). */
async function rawStorageKeys(ctx: BrowserContext, page: Page): Promise<string[]> {
  const cdp = await ctx.newCDPSession(page);
  const { frameTree } = (await cdp.send('Page.getFrameTree')) as { frameTree: { frame: { id: string } } };
  const { executionContextId } = (await cdp.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'raw' })) as { executionContextId: number };
  const raw = (await cdp.send('Runtime.evaluate', { contextId: executionContextId, returnByValue: true, expression: 'Object.keys(localStorage)' })) as {
    result: { value: string[] };
  };
  await cdp.detach();
  return raw.result.value;
}

const loadsScript = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const s = document.createElement('script');
        s.src = '/sw.js'; // any script of the site; it only adds a listener
        s.onload = () => resolve('load');
        s.onerror = () => resolve('error');
        document.head.append(s);
      }),
  );

test('content scripts are registered only while containers are in use, and isolation still holds from the first request', async () => {
  test.setTimeout(120_000);
  const dir = mkdtempSync(path.join(tmpdir(), 'facet-scripts-'));
  const serverLog = async () => (await (await fetch(`http://127.0.0.1:${TEST_PORT}/__log`)).json()) as Array<{ host: string; path: string; cookie: string }>;
  let ctx: BrowserContext | null = null;
  try {
    ctx = await chromium.launchPersistentContext(dir, {
      channel: 'chromium',
      headless: !process.env.HEADED,
      args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
    });
    const sw = await workerOf(ctx);
    const api = apiOf(sw);
    await api('listContainers');

    // (a) A profile that never had a container: nothing registered, no beacon answer anywhere, no request from pages.
    expect(await api('getContentScripts')).toMatchObject({ scope: 'off', wanted: 'off', beaconRules: false });
    expect(await chromeState(sw)).toEqual({ scripts: [], rulesets: [], beaconDynamic: [] });
    const quiet = await probe(ctx, at('a.localhost', '/blank'));
    expect(quiet.beacon).toEqual([]);
    expect(await shimmed(quiet.page)).toBe(false);

    // (d) Strict mode with no script registered: the network rule refuses a service worker in a plain tab; ordinary
    // page scripts load.
    await api('updateSettings', { strictMode: true });
    expect(await api('getStrictMode')).toMatchObject({ active: true });
    const strictPage = await probe(ctx, at('nosw.localhost', '/sw-page'));
    await expect(strictPage.page.locator('#sw')).toHaveText(/^rejected: /);
    expect(strictPage.beacon).toEqual([]);
    expect(await loadsScript(strictPage.page)).toBe('load');
    expect(await strictPage.page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
    await api('updateSettings', { strictMode: false });

    // (b) A container and a tab in it: the scripts are registered before its first navigation, which is isolated
    // (cookies and storage) from its very first document.
    const real = await ctx.newPage();
    await real.goto(setCookie('a.localhost', 'who=real'));
    await go(real, at('a.localhost', '/blank'));
    await real.evaluate(() => localStorage.setItem('k', 'real'));
    const A = await api<{ id: string; name: string }>('createContainer', { name: 'Scripts A' });
    await fetch(`http://127.0.0.1:${TEST_PORT}/__log?clear=1`);
    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${EXTENSION_ID}/open.html?container=${encodeURIComponent(A.id)}&url=${encodeURIComponent(setCookie('a.localhost', 'who=alice'))}`);
    await expect.poll(() => page.url(), { timeout: 10_000 }).toMatch(/^http:/);
    await expect(page.locator('#set')).toContainText('who=alice');
    expect(await shimmed(page)).toBe(true);
    expect(await page.evaluate(() => document.cookie)).toBe('who=alice'); // the jar's view, not the real profile's
    expect(await page.evaluate(() => localStorage.getItem('k'))).toBeNull();
    await page.evaluate(() => localStorage.setItem('k', 'alice'));
    const first = (await serverLog()).filter((e) => e.host === 'a.localhost' && e.path.startsWith('/set?'));
    expect(first.map((e) => e.cookie)).toEqual(['']); // nothing of the real profile went out
    expect((await ctx.cookies(at('a.localhost'))).map((c) => `${c.name}=${c.value}`)).toEqual(['who=real']);
    expect(await api('getContentScripts')).toMatchObject({ scope: 'all', beaconRules: true });
    expect((await chromeState(sw)).scripts).toEqual(['facet-beacon <all_urls>', 'facet-shim <all_urls>']);
    // While containers are in use, plain pages ask the beacon too (the noise exists only then).
    const busy = await probe(ctx, at('b.localhost', '/blank'));
    expect(busy.beacon.length).toBeGreaterThan(0);
    expect(await real.evaluate(() => localStorage.getItem('k'))).toBe('real');

    // (c) The last container tab closes: after the grace period (skipped here) only the sites containers used keep
    // the scripts, so pages elsewhere make no beacon request.
    await go(page, at('a.localhost', '/whoami?t=scripts'));
    await api('flushRestore');
    await page.close();
    await expect.poll(() => api<Array<unknown>>('listTabs')).toEqual([]);
    expect(await api('getContentScripts')).toMatchObject({ scope: 'all', wanted: 'managed' });
    expect(await api('flushContentScripts')).toMatchObject({ scope: 'managed', beaconRules: true, matches: 2 });
    expect((await chromeState(sw)).scripts).toEqual(['facet-beacon *://*.a.localhost/* *://a.localhost/*', 'facet-shim *://*.a.localhost/* *://a.localhost/*']);
    const elsewhere = await probe(ctx, at('b.localhost', '/sw-page'));
    expect(elsewhere.beacon).toEqual([]);
    expect(await shimmed(elsewhere.page)).toBe(false);
    await expect(elsewhere.page.locator('#sw')).toHaveText('registered'); // no container used b.localhost: untouched
    // On the container's site a plain tab still hides the container's storage (the shim's managed mode)...
    const managed = await probe(ctx, at('a.localhost', '/blank?plain'));
    expect(managed.beacon.length).toBeGreaterThan(0);
    expect(await shimmed(managed.page)).toBe(true);
    expect(await managed.page.evaluate(() => [localStorage.getItem('k'), Object.keys(localStorage).some((k) => k.startsWith('__facet:'))])).toEqual(['real', false]);
    expect((await rawStorageKeys(ctx, managed.page)).some((k) => k.startsWith('__facet:'))).toBe(true);
    // ...and refuses service workers in the page (the shim). Outside strict mode there is no network block: a realm
    // the shim never patched (here a CDP isolated world) can still register one — documented, see docs/limits.md.
    await go(managed.page, at('a.localhost', '/sw-page'));
    await expect(managed.page.locator('#sw')).toHaveText('rejected: SecurityError');
    expect(await managed.page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
    expect(await registerFromUnpatchedRealm(ctx, managed.page)).toBe('registered');
    // Strict mode on: every worker removed, and the network block refuses even unpatched realms; off again: no block.
    await api('updateSettings', { strictMode: true });
    await expect.poll(() => managed.page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
    expect(await registerFromUnpatchedRealm(ctx, managed.page)).toMatch(/^refused: /);
    await api('updateSettings', { strictMode: false });
    expect(await loadsScript(managed.page)).toBe('load'); // the page's own scripts are not affected

    // (e) Reopening the closed container tab: registration comes first again, the tab is isolated from its first load.
    await fetch(`http://127.0.0.1:${TEST_PORT}/__log?clear=1`);
    const created = ctx.waitForEvent('page');
    const restoredId = await sw.evaluate(async () => (await (globalThis as any).chrome.sessions.restore()).tab?.id as number);
    const restored = await created;
    await expect.poll(() => api('getTabContainer', restoredId), { timeout: 10_000 }).toBe(A.id);
    await expect(restored.locator('#cookies')).toHaveText('who=alice');
    expect(await shimmed(restored)).toBe(true);
    expect(await restored.evaluate(() => localStorage.getItem('k'))).toBe('alice');
    const sent = (await serverLog()).filter((e) => e.path === '/whoami?t=scripts').map((e) => e.cookie);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((c) => c === 'who=alice')).toBe(true);
    expect(await api('getContentScripts')).toMatchObject({ scope: 'all' });

    // Container gone entirely: its sites stay managed (their namespaced storage is still in the origins).
    await api('deleteContainer', A.id);
    expect(await api('flushContentScripts')).toMatchObject({ scope: 'managed' });
  } finally {
    await ctx?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shared browser: after the last container tab, a plain page on an unused site makes no beacon request', async ({ facet }) => {
  const A = await facet.container('A');
  const page = await facet.openIn(A.name, at('a.localhost', '/blank'));
  expect(await facet.api('getContentScripts')).toMatchObject({ scope: 'all' });
  await page.close();
  await expect.poll(() => facet.api<Array<{ containerId: string }>>('listTabs')).toEqual([]);
  const status = await facet.api<{ scope: string }>('flushContentScripts');
  expect(status.scope).not.toBe('all');
  const host = `unused${Date.now().toString(36)}.localhost`;
  const plain = await probe(facet.ctx, at(host, '/blank'));
  facet.adopt(plain.page);
  expect(plain.beacon).toEqual([]);
  expect(await shimmed(plain.page)).toBe(false);
  // A new container tab: registered again before its first navigation.
  const again = await facet.openIn(A.name, at(host, '/blank'));
  expect(await shimmed(again)).toBe(true);
  expect(await facet.api('getContentScripts')).toMatchObject({ scope: 'all' });
});

test('a closed container group (saved by Chrome) keeps nothing registered for every site; reopened, its tabs are isolated from the first request', async ({ facet }) => {
  test.setTimeout(90_000);
  const A = await facet.container('A');
  await facet.plain(setCookie('a.localhost', 'who=real'));
  const open = async (n: number) => {
    const page = await facet.openIn(A.name, setCookie('a.localhost', 'who=alice'));
    await go(page, at('a.localhost', `/whoami?cg=${n}`));
    await expect(page.locator('#cookies')).toHaveText('who=alice');
    return { page, tabId: await facet.tabIdOf(page) };
  };
  const one = await open(1);
  const two = await open(2);
  await expect.poll(async () => (await facet.tabInfo(one.tabId)).groupId).toBeGreaterThanOrEqual(0);
  const { groupId, windowId } = await facet.tabInfo(one.tabId);
  await expect.poll(async () => (await facet.tabInfo(two.tabId)).groupId).toBe(groupId);
  const group = await facet.inWorker(async (id: number) => {
    const g = await (globalThis as any).chrome.tabGroups.get(id);
    return { title: g.title as string, color: g.color as string };
  }, groupId);
  expect(await facet.api('getContentScripts')).toMatchObject({ scope: 'all', wanted: 'all', reason: { kind: 'tabs', count: 2 } });
  await facet.api('flushRestore');

  // "Close group": every tab goes at once, Chrome keeps the group as a saved one.
  await facet.inWorker((ids: number[]) => (globalThis as any).chrome.tabs.remove(ids), [one.tabId, two.tabId]);
  await expect.poll(() => one.page.isClosed() && two.page.isClosed()).toBe(true);
  await facet.api('flushRestore');
  const debug = await facet.api<{ records: Array<{ url: string; savedGroup?: boolean }> }>('getRestoreDebug');
  expect(debug.records.filter((r) => r.url.includes('/whoami?cg=') && r.savedGroup)).toHaveLength(2);

  // The restorable records of the saved group are not tabs: after the grace period (skipped) the scripts cover the
  // container sites only, and a page elsewhere makes no beacon request.
  expect(await facet.api('getContentScripts')).toMatchObject({ wanted: 'managed', reason: { kind: 'sites' } });
  const status = await facet.api<{ scope: string }>('flushContentScripts');
  expect(status).toMatchObject({ scope: 'managed', wanted: 'managed', beaconRules: true });
  const host = `closedgroup${Date.now().toString(36)}.localhost`;
  const plain = await probe(facet.ctx, at(host, '/blank'));
  facet.adopt(plain.page);
  expect(plain.beacon).toEqual([]);
  expect(await shimmed(plain.page)).toBe(false);

  // Chrome opens the saved group again: new tabs, a new group with the same title (marker included) and colour. The
  // restore gate holds their addresses until they are decided; the scripts are registered for every frame before they load.
  await facet.clearLog();
  const urls = [at('a.localhost', '/whoami?cg=1'), at('a.localhost', '/whoami?cg=2')];
  const reopened = await facet.inWorker(async ({ urls, title, color, windowId }: { urls: string[]; title: string; color: string; windowId: number }) => {
    const c = (globalThis as any).chrome;
    const win = (await c.windows.get(windowId).catch(() => null))?.type === 'normal' ? windowId : (await c.windows.getAll({ windowTypes: ['normal'] }))[0].id;
    const tabs = await Promise.all(urls.map((url) => c.tabs.create({ url, windowId: win, active: false })));
    const g = await c.tabs.group({ tabIds: tabs.map((t: { id: number }) => t.id), createProperties: { windowId: win } });
    await c.tabGroups.update(g, { title, color });
    return tabs.map((t: { id: number }) => t.id as number);
  }, { urls, ...group, windowId });
  for (const id of reopened) await expect.poll(() => facet.api('getTabContainer', id), { timeout: 10_000 }).toBe(A.id);
  const reopenedPages = () => facet.ctx.pages().filter((p) => p.url().includes('/whoami?cg='));
  await expect.poll(() => reopenedPages().length, { timeout: 10_000 }).toBe(2);
  const pages = reopenedPages();
  for (const p of pages) {
    facet.adopt(p);
    await expect(p.locator('#cookies')).toHaveText('who=alice');
    expect(await shimmed(p)).toBe(true);
  }
  for (const q of ['/whoami?cg=1', '/whoami?cg=2']) {
    const sent = (await facet.serverLog()).filter((e) => e.path === q).map((e) => e.cookie);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((c) => c === 'who=alice')).toBe(true); // not one request carried the real profile's cookie
  }
  expect(await facet.api('getContentScripts')).toMatchObject({ scope: 'all', reason: { kind: 'tabs', count: 2 } });
});
