import { execFileSync } from 'node:child_process';
import type { Page } from '@playwright/test';
import { at, expect, ext, test, type Facet } from './fixtures';
import { hostPids, installHost, openPopup, startMcp, startSecondProfile, uninstallHost, type Mcp, type SecondProfile } from './bridge-helpers';

interface TabRow {
  tabId: number;
  windowId: number;
  index: number;
  active: boolean;
  pinned: boolean;
  title: string;
  url: string;
  groupId: number;
  container: { id: string; name: string } | null;
}

/** Popup with the agent bridge switched on and connected. */
async function turnOn(facet: Facet): Promise<{ popup: Page; card: ReturnType<Page['getByTestId']> }> {
  const { page: popup, toggle } = await openPopup(facet);
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  const card = popup.getByTestId('bridge-card');
  await expect(card).toHaveAttribute('data-status', 'connected', { timeout: 15_000 });
  return { popup, card };
}

const tabsOf = (mcp: Mcp, args: Record<string, unknown> = {}) => mcp.json<TabRow[]>('list_tabs', args);

/** A plain tab opened by the bridge itself. */
async function openPlain(mcp: Mcp, url: string): Promise<number> {
  const opened = await mcp.json<{ tabId: number }>('open_tab', { url });
  return opened.tabId;
}

test.describe('agent bridge', () => {
  let mcp: Mcp | null = null;
  let second: SecondProfile | null = null;

  test.beforeEach(({ facet }) => {
    installHost(facet); // the host manifest goes into this run's browser profile only
  });
  test.afterEach(async ({ facet }) => {
    await mcp?.close().catch(() => {});
    mcp = null;
    await second?.close();
    second = null;
    await facet.api('setBridgeProfileLabel', '');
    // Leave nothing behind for the other specs: bridge off, and no page of ours polling the worker awake.
    await facet.api('updateSettings', { agentBridge: false });
    await facet.inWorker(async () => {
      const c = (globalThis as any).chrome;
      const stray: Array<{ id: number; url?: string }> = (await c.tabs.query({})).filter((t: { url?: string }) => /^(https?:|chrome-extension:)/.test(t.url ?? ''));
      await c.tabs.remove(stray.map((t) => t.id));
    }, undefined);
    await expect.poll(() => hostPids(facet), { timeout: 10_000 }).toEqual([]);
  });

  test('is off by default: no host process, and the MCP server says so', async ({ facet }) => {
    const { toggle } = await openPopup(facet);
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(await facet.api<{ agentBridge: boolean }>('getSettings')).toMatchObject({ agentBridge: false });
    expect(hostPids(facet)).toEqual([]);

    mcp = await startMcp(facet);
    const off = await mcp.call('list_tabs');
    expect(off.isError).toBe(true);
    expect(off.text).toMatch(/bridge is off — turn it on in the Facet popup/);

    const empty = await startMcp(facet, '/nonexistent-native-hosts');
    const missing = await empty.call('list_tabs');
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/host is not installed — run `pnpm bridge:install`/);
    await empty.close();

    const { tools } = await mcp.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['activate_tab', 'assign_tab', 'bridge_info', 'click', 'close_tab', 'get_tab_html', 'get_tab_text', 'list_containers', 'list_tabs', 'navigate', 'open_in_container', 'open_tab', 'run_js', 'screenshot_tab', 'scroll', 'type'],
    );
    expect(tools.find((t) => t.name === 'list_tabs')?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === 'get_tab_text')?.inputSchema).toMatchObject({ required: ['tabId'], properties: { maxChars: { default: 20_000 } } });
  });

  test('the popup switch turns it on and off, with a visible state and an action counter', async ({ facet }) => {
    const { popup, card } = await turnOn(facet);
    await expect(card).toHaveClass(/fx-bridge--on/);
    await expect(popup.getByTestId('bridge-status')).toContainText('Agent connected — full access');
    await expect(popup.getByTestId('bridge-actions')).toHaveText('0 actions');
    expect(hostPids(facet)).toHaveLength(1);

    mcp = await startMcp(facet);
    await mcp.json('list_containers');
    await mcp.json('list_tabs');
    await expect(popup.getByTestId('bridge-actions')).toHaveText('2 actions');

    // The options page shows the same switch, in the same state, with a plain explanation of what "on" means.
    const options = await facet.ctx.newPage();
    await options.goto(ext('options.html'));
    await expect(options.getByRole('heading', { name: 'AI agent bridge' })).toBeVisible();
    await expect(options.getByRole('switch', { name: /Agent bridge/ })).toHaveAttribute('aria-checked', 'true');
    await expect(options.getByText('While it is on, the agent can')).toBeVisible();
    await expect(options.getByText(/click, type, scroll and run JavaScript in any tab/)).toBeVisible();

    // Off again, from the popup: connection closed, host gone, tools refuse.
    await popup.getByRole('switch', { name: /Agent bridge/ }).click();
    await expect(popup.getByTestId('bridge-card')).toHaveAttribute('data-status', 'off');
    await expect(popup.getByTestId('bridge-status')).toHaveCount(0);
    await expect.poll(() => hostPids(facet), { timeout: 10_000 }).toEqual([]);
    await expect(options.getByRole('switch', { name: /Agent bridge/ })).toHaveAttribute('aria-checked', 'false');
    const refused = await mcp.call('list_tabs');
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/bridge is off/);
    expect(await facet.api<{ agentBridge: boolean }>('getSettings')).toMatchObject({ agentBridge: false });
    await options.close();
  });

  test('list_tabs shows the tabs of every window with their containers', async ({ facet }) => {
    const c = await facet.container('Agent');
    const inContainer = await facet.openIn(c.name, at('a.localhost', '/blank'));
    const plain = await facet.plain(at('b.localhost', '/blank'));
    const containerTabId = await facet.tabIdOf(inContainer);
    const plainTabId = await facet.tabIdOf(plain);
    // A second window.
    const second = await facet.inWorker(async (url: string) => {
      const w = await (globalThis as any).chrome.windows.create({ url });
      return { windowId: w.id as number, tabId: w.tabs[0].id as number };
    }, at('sso.localhost', '/blank'));

    await turnOn(facet);
    mcp = await startMcp(facet);

    const all = await tabsOf(mcp);
    const byId = new Map(all.map((t) => [t.tabId, t]));
    const container = byId.get(containerTabId)!;
    expect(container.container).toEqual({ id: c.id, name: c.name });
    expect(container.url).toBe(at('a.localhost', '/blank'));
    expect(container.title).toContain('a.localhost blank');
    expect(typeof container.windowId).toBe('number');
    expect(typeof container.groupId).toBe('number');
    expect(byId.get(plainTabId)!.container).toBeNull();
    const other = byId.get(second.tabId)!;
    expect(other.windowId).toBe(second.windowId);
    expect(other.windowId).not.toBe(container.windowId);
    expect(new Set(all.map((t) => t.windowId)).size).toBeGreaterThanOrEqual(2);

    const inSecond = await tabsOf(mcp, { windowId: second.windowId });
    expect(inSecond.map((t) => t.tabId)).toContain(second.tabId); // (Playwright may have put the popup in that window too)
    expect(inSecond.every((t) => t.windowId === second.windowId)).toBe(true);
    expect(inSecond.length).toBeLessThan(all.length);
    expect((await tabsOf(mcp, { containerId: c.name })).map((t) => t.tabId)).toEqual([containerTabId]);
    expect((await tabsOf(mcp, { containerId: c.id })).map((t) => t.tabId)).toEqual([containerTabId]);
    expect((await mcp.call('list_tabs', { containerId: 'nope' })).text).toMatch(/no container "nope"/);

    const containers = await mcp.json<Array<{ id: string; name: string; tabCount: number }>>('list_containers');
    expect(containers.find((x) => x.id === c.id)).toMatchObject({ name: c.name, tabCount: 1 });
  });

  test('open_in_container opens the page in the container: its cookies are on the first request', async ({ facet }) => {
    const c = await facet.container('Login');
    const login = await facet.openIn(c.name, at('a.localhost', '/login?user=alice'));
    await expect(login.locator('#user')).toHaveText('alice');
    await turnOn(facet);
    mcp = await startMcp(facet);

    await facet.clearLog();
    const opened = await mcp.json<{ tabId: number; container: { name: string }; url: string; loaded: boolean }>('open_in_container', {
      url: at('a.localhost', '/whoami'),
      container: c.name.toUpperCase(), // names are case-insensitive
    });
    expect(opened.container).toEqual({ id: c.id, name: c.name });
    expect(opened.loaded).toBe(true);
    facet.adopt(await pageFor(facet, opened.tabId));

    const first = (await facet.serverLog()).find((r) => r.host === 'a.localhost' && r.path === '/whoami');
    expect(first?.cookie).toMatch(/\bsid=/); // the container's session, already on the very first request
    const text = await mcp.call('get_tab_text', { tabId: opened.tabId });
    expect(text.texts[1]).toContain('alice');

    // A plain tab of the same site has no session.
    const plainId = await openPlain(mcp, at('a.localhost', '/whoami'));
    expect((await mcp.call('get_tab_text', { tabId: plainId })).texts[1]).toContain('anonymous');

    // Unknown container: an error that lists the existing ones, unless it may be created.
    const unknown = await mcp.call('open_in_container', { url: at('a.localhost', '/blank'), container: 'Nowhere' });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toMatch(/no container "Nowhere".*existing:.*createIfMissing/);
    const made = await mcp.json<{ container: { name: string } }>('open_in_container', { url: at('a.localhost', '/blank'), container: 'Made-by-agent', createIfMissing: true });
    expect(made.container.name).toBe('Made-by-agent');
    expect((await mcp.json<Array<{ name: string }>>('list_containers')).map((x) => x.name)).toContain('Made-by-agent');

    expect((await mcp.call('open_in_container', { url: 'ftp://x.test/', container: c.name })).text).toMatch(/not allowed/);
    expect((await mcp.call('open_in_container', { url: 'not a url', container: c.name })).text).toMatch(/not a valid address/);
  });

  test('reads and operates a page: text, html, type, click, submit, scroll, run_js', async ({ facet }) => {
    await turnOn(facet);
    mcp = await startMcp(facet);
    const tabId = await openPlain(mcp, at('a.localhost', '/agent'));

    const text = await mcp.call('get_tab_text', { tabId });
    expect(JSON.parse(text.texts[0]!)).toMatchObject({ tabId, url: at('a.localhost', '/agent'), title: 'Agent page', truncated: false });
    expect(text.texts[1]).toContain('Agent page');
    expect(text.texts[1]).toContain('bottom');
    const cut = await mcp.call('get_tab_html', { tabId, maxChars: 100 });
    expect(JSON.parse(cut.texts[0]!)).toMatchObject({ truncated: true, selector: null });
    expect(cut.texts[1]!.length).toBe(100);

    const html = await mcp.call('get_tab_html', { tabId, selector: '#title' });
    expect(html.texts[1]).toBe('<h1 id="title">Agent page</h1>');
    expect((await mcp.call('get_tab_html', { tabId, selector: '#nope' })).text).toMatch(/no element matches "#nope"/);
    expect((await mcp.call('get_tab_html', { tabId, selector: '!!' })).text).toMatch(/invalid selector/);

    // type: native value setter + input/change events (the page listens to both), click, and the page reacts.
    expect((await mcp.json('type', { tabId, selector: '#name', text: 'hello' }))).toEqual({ typed: 5 });
    expect((await mcp.json('type', { tabId, selector: '#name', text: ' world', append: true }))).toEqual({ typed: 6 });
    expect(await mcp.json('click', { tabId, selector: '#go' })).toEqual({ clicked: '<button#go>' });
    const after = (await mcp.call('get_tab_text', { tabId })).texts[1]!;
    expect(after).toContain('clicked:hello world');
    expect(after).toContain('input:hello world|change');

    // Coordinates: whatever is at the point.
    const rect = await mcp.json<unknown>('run_js', { tabId, code: 'const r = document.getElementById("go").getBoundingClientRect(); return [r.x + 2, r.y + 2];' });
    const [x, y] = rect as [number, number];
    await mcp.json('type', { tabId, selector: '#name', text: 'by-point' });
    await mcp.json('click', { tabId, x, y });
    expect((await mcp.call('get_tab_text', { tabId })).texts[1]).toContain('clicked:by-point');
    expect((await mcp.call('click', { tabId, x: 100000, y: 100000 })).text).toMatch(/no element at/);
    expect((await mcp.call('click', { tabId })).text).toMatch(/selector, or both x and y/);
    expect((await mcp.call('click', { tabId, selector: '#absent' })).text).toMatch(/no element matches "#absent"/);
    expect((await mcp.call('type', { tabId, selector: '#title', text: 'x' })).text).toMatch(/not a text field/);

    // Scroll.
    const bottom = await mcp.json<{ y: number; maxY: number }>('scroll', { tabId, to: 'bottom' });
    expect(bottom.y).toBeGreaterThan(1000);
    expect((await mcp.json<{ y: number }>('scroll', { tabId, to: 'top' })).y).toBe(0);
    expect((await mcp.json<{ y: number }>('scroll', { tabId, dy: 300 })).y).toBe(300);
    expect((await mcp.json<{ y: number }>('scroll', { tabId, selector: '#bottom' })).y).toBeGreaterThan(1000);
    expect((await mcp.call('scroll', { tabId })).text).toMatch(/give selector, to, or dx\/dy/);

    // run_js: MAIN world sees the page's own variables, async code works, errors come back as errors.
    expect((await mcp.call('run_js', { tabId, code: 'return window.pageVar;' })).text).toBe('42');
    expect((await mcp.call('run_js', { tabId, code: 'await new Promise(r => setTimeout(r, 50)); return {a: [1, "two"], t: document.title};' })).text).toBe('{"a":[1,"two"],"t":"Agent page"}');
    expect((await mcp.call('run_js', { tabId, code: 'document.title = "changed";' })).text).toBe('undefined');
    const thrown = await mcp.call('run_js', { tabId, code: 'throw new TypeError("boom");' });
    expect(thrown.isError).toBe(true);
    expect(thrown.text).toBe('TypeError: boom');
    expect((await mcp.call('run_js', { tabId, code: 'return (' })).text).toMatch(/SyntaxError/);
    const cutJs = await mcp.call('run_js', { tabId, code: 'return "y".repeat(5000);', maxChars: 200 });
    expect(cutJs.texts[0]!.length).toBe(200);
    expect(cutJs.texts[1]).toMatch(/truncated to 200/);

    // Submit through the form with Enter semantics.
    await mcp.json('type', { tabId, selector: '#q', text: 'cats', submit: true });
    await expect.poll(async () => (await tabsOf(mcp!)).find((t) => t.tabId === tabId)?.url, { timeout: 10_000 }).toBe(at('a.localhost', '/agent-submit?q=cats'));
    expect((await mcp.call('get_tab_text', { tabId })).texts[1]).toContain('cats');
  });

  test('run_js reports a page that forbids eval, and the ISOLATED world', async ({ facet }) => {
    await turnOn(facet);
    mcp = await startMcp(facet);
    const tabId = await openPlain(mcp, at('a.localhost', '/agent-csp'));
    const blocked = await mcp.call('run_js', { tabId, code: 'return 1;' });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toMatch(/Content-Security-Policy forbids evaluating code strings/);
    // The other tools do not need eval and still work there.
    expect((await mcp.call('get_tab_text', { tabId })).texts[1]).toContain('Agent page');
    expect(await mcp.json('click', { tabId, selector: '#go' })).toEqual({ clicked: '<button#go>' });
    const isolated = await mcp.call('run_js', { tabId, code: 'return 1;', world: 'ISOLATED' });
    expect(isolated.isError).toBe(true);
    expect(isolated.text).toMatch(/ISOLATED world cannot evaluate code strings/);
  });

  test('screenshot_tab returns an image of a background tab and puts the active tab back', async ({ facet }) => {
    await turnOn(facet);
    mcp = await startMcp(facet);
    const first = await openPlain(mcp, at('a.localhost', '/agent'));
    const second = await mcp.json<{ tabId: number; windowId: number }>('open_tab', { url: at('b.localhost', '/blank'), active: true });
    expect((await tabsOf(mcp)).find((t) => t.tabId === second.tabId)!.active).toBe(true);

    const shot = await mcp.call('screenshot_tab', { tabId: first });
    expect(shot.isError).toBe(false);
    expect(shot.images).toHaveLength(1);
    expect(shot.images[0]!.mimeType).toBe('image/png');
    const png = Buffer.from(shot.images[0]!.data, 'base64');
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.length).toBeGreaterThan(1000);

    const after = await tabsOf(mcp, { windowId: second.windowId });
    expect(after.find((t) => t.tabId === second.tabId)!.active).toBe(true); // restored
    expect(after.find((t) => t.tabId === first)!.active).toBe(false);

    const jpeg = await mcp.call('screenshot_tab', { tabId: second.tabId, format: 'jpeg', quality: 50 });
    expect(jpeg.images[0]!.mimeType).toBe('image/jpeg');
    expect([...Buffer.from(jpeg.images[0]!.data, 'base64').subarray(0, 2)]).toEqual([0xff, 0xd8]);
    expect((await mcp.call('screenshot_tab', { tabId: 999999 })).text).toMatch(/no tab with id 999999/);
  });

  test('navigate, activate, assign and close tabs', async ({ facet }) => {
    const c = await facet.container('Move');
    await turnOn(facet);
    mcp = await startMcp(facet);

    const tabId = await openPlain(mcp, at('a.localhost', '/blank'));
    const nav = await mcp.json<{ url: string; title: string; loaded: boolean }>('navigate', { tabId, url: at('b.localhost', '/blank') });
    expect(nav).toMatchObject({ url: at('b.localhost', '/blank'), loaded: true });
    expect((await mcp.call('navigate', { tabId, url: 'javascript:alert(1)' })).text).toMatch(/not allowed/);

    // Into the container and out again; the page reloads each time.
    const moved = await mcp.json<{ container: { name: string } | null }>('assign_tab', { tabId, container: c.name });
    expect(moved.container).toEqual({ id: c.id, name: c.name });
    expect((await tabsOf(mcp)).find((t) => t.tabId === tabId)!.container).toEqual({ id: c.id, name: c.name });
    expect((await mcp.json<{ container: unknown }>('assign_tab', { tabId, container: null })).container).toBeNull();
    expect((await mcp.call('assign_tab', { tabId, container: 'Ghost' })).text).toMatch(/no container "Ghost"/);

    const act = await mcp.json<{ tabId: number }>('activate_tab', { tabId });
    expect(act.tabId).toBe(tabId);
    expect((await tabsOf(mcp)).find((t) => t.tabId === tabId)!.active).toBe(true);

    expect(await mcp.json('close_tab', { tabId })).toEqual({ tabId, closed: true });
    expect((await tabsOf(mcp)).some((t) => t.tabId === tabId)).toBe(false);
    expect((await mcp.call('close_tab', { tabId })).text).toMatch(/no tab with id/);
  });

  test('validates arguments and answers many clients at once', async ({ facet }) => {
    await turnOn(facet);
    mcp = await startMcp(facet);
    const other = await startMcp(facet);
    const bad = await mcp.call('close_tab', { tabId: -1 });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/tabId: must be at least 0/);
    expect((await mcp.call('get_tab_text', { tabId: 1, maxChars: 5 })).text).toMatch(/maxChars: must be at least 100/);
    expect((await mcp.call('type', { tabId: 1, selector: 'a' })).text).toMatch(/missing required argument "text"/);
    const [a, b] = await Promise.all([mcp.json('list_tabs'), other.json('list_tabs')]);
    expect(a).toEqual(b);
    await other.close();
  });

  test('run_js can hand back more than 1 MiB (Chrome only caps what the host sends to the extension)', async ({ facet }) => {
    await turnOn(facet);
    mcp = await startMcp(facet);
    const tabId = await openPlain(mcp, at('a.localhost', '/blank'));
    const big = await mcp.call('run_js', { tabId, code: 'return "z".repeat(1500000);', maxChars: 2_000_000 });
    expect(big.isError).toBe(false);
    expect(big.texts[0]!.length).toBe(1_500_002);
  });

  test('without the host installed the popup says how to install it, and "Check again" connects once it is', async ({ facet }) => {
    uninstallHost(facet);
    const { page: popup, toggle } = await openPopup(facet);
    await toggle.click();
    const card = popup.getByTestId('bridge-card');
    await expect(card).toHaveAttribute('data-status', 'host-missing', { timeout: 15_000 });
    await expect(card).toHaveClass(/fx-bridge--on/); // the switch is still visibly ON
    await expect(popup.getByTestId('bridge-install')).toContainText('pnpm bridge:install');
    await expect(popup.getByTestId('bridge-status')).toContainText('not installed');

    installHost(facet);
    await popup.getByRole('button', { name: 'Check again' }).click();
    await expect(card).toHaveAttribute('data-status', 'connected', { timeout: 15_000 });
    await expect(popup.getByTestId('bridge-install')).toHaveCount(0);
  });

  test('reconnects when the host process dies, and after the extension worker restarts', async ({ facet }) => {
    const { popup, card } = await turnOn(facet);
    mcp = await startMcp(facet);
    await mcp.json('list_containers');
    const [pid] = hostPids(facet);
    expect(pid).toBeGreaterThan(0);

    execFileSync('kill', ['-9', String(pid)]);
    await expect.poll(() => hostPids(facet).filter((p) => p !== pid).length, { timeout: 20_000 }).toBe(1);
    await expect(card).toHaveAttribute('data-status', 'connected', { timeout: 20_000 });
    await mcp.json('list_containers');

    // The worker stops (Chrome does this when idle; here forced). The popup's next request wakes it, and it reconnects.
    const [pid2] = hostPids(facet);
    await facet.stopServiceWorker(popup);
    await expect.poll(() => hostPids(facet).filter((p) => p === pid2).length, { timeout: 15_000 }).toBe(0);
    await expect.poll(() => hostPids(facet).filter((p) => p !== pid2).length, { timeout: 20_000 }).toBe(1); // a new host
    await expect(card).toHaveAttribute('data-status', 'connected', { timeout: 20_000 });
    await mcp.json('list_containers');
  });

  test('switching it off while a tool is still running: the action that was already received is not performed', async ({ facet }) => {
    const { popup } = await turnOn(facet);
    mcp = await startMcp(facet);
    const tabId = await openPlain(mcp, at('a.localhost', '/agent'));
    const page = await pageFor(facet, tabId);
    const out = page.locator('#out');

    // Make the tab lookup that every tool starts with slow, once: the tool is then "received, not yet acting" for 2.5 s.
    const slowOnce = () =>
      facet.inWorker(async (id: number) => {
        const tabs = (globalThis as any).chrome.tabs;
        const real = tabs.get;
        const state = { hit: false };
        (globalThis as any).__slowLookup = { state, restore: () => (tabs.get = real) };
        tabs.get = function (tid: number, ...rest: unknown[]) {
          if (tid !== id || state.hit) return real.call(tabs, tid, ...rest);
          state.hit = true;
          tabs.get = real;
          return new Promise((r) => setTimeout(r, 2500)).then(() => real.call(tabs, tid, ...rest));
        };
      }, tabId);
    const lookupStarted = () => facet.inWorker(async () => (globalThis as any).__slowLookup.state.hit as boolean, undefined);
    try {
      // Control: the same slow click, switch left on, does happen.
      await slowOnce();
      const slow = await mcp.json('click', { tabId, selector: '#go' });
      expect(slow).toEqual({ clicked: '<button#go>' });
      await expect(out).toHaveText('clicked:');

      // Now switch it off while the click is waiting for its lookup.
      await page.reload();
      await expect(out).toHaveText('');
      await slowOnce();
      const pending = mcp.call('click', { tabId, selector: '#go' });
      await expect.poll(lookupStarted, { timeout: 10_000 }).toBe(true);
      await popup.getByRole('switch', { name: /Agent bridge/ }).click();
      await expect(popup.getByTestId('bridge-card')).toHaveAttribute('data-status', 'off');
      const answer = await pending;
      expect(answer.isError).toBe(true);
      expect(answer.text).toMatch(/switched off/);

      // The lookup finishes after 2.5 s; the click must not follow it.
      await page.waitForTimeout(3500);
      await expect(out).toHaveText('');
      const log = await facet.api<Array<{ message: string; data?: Record<string, unknown> }>>('getLog');
      const clicks = log.filter((e) => e.message === 'agent action' && e.data!.tool === 'click');
      expect(clicks.at(-1)!.data).toMatchObject({ ok: false, error: expect.stringMatching(/not performed/) });
    } finally {
      await facet.inWorker(async () => (globalThis as any).__slowLookup?.restore(), undefined).catch(() => {});
    }
  });

  test('a second Chrome profile does not take over a live bridge; it says so, and connects once the first lets go', async ({ facet }) => {
    await facet.api('setBridgeProfileLabel', 'First');
    const { popup, card } = await turnOn(facet);
    mcp = await startMcp(facet);
    expect((await mcp.json<{ profileLabel: string }>('bridge_info')).profileLabel).toBe('First');
    const [firstHost] = hostPids(facet);
    expect(firstHost).toBeGreaterThan(0);

    second = await startSecondProfile(facet);
    await second.api('setBridgeProfileLabel', 'Second');
    await second.api('updateSettings', { agentBridge: true });
    const popup2 = await second.popup();
    const card2 = popup2.getByTestId('bridge-card');
    await expect(card2).toHaveAttribute('data-status', 'busy', { timeout: 20_000 });
    await expect(popup2.getByTestId('bridge-status')).toContainText('Another Chrome profile holds the agent bridge — turn it off there first');
    await expect(popup2.getByTestId('bridge-busy')).toContainText('Only one Chrome profile can hold the agent bridge');

    // The first profile still holds it, truthfully: same host, still connected, and the agent still reaches it.
    await expect(card).toHaveAttribute('data-status', 'connected');
    await expect(popup.getByTestId('bridge-status')).toContainText('Agent connected');
    expect(hostPids(facet)).toEqual([firstHost]);
    expect((await mcp.json<{ profileLabel: string }>('bridge_info')).profileLabel).toBe('First');
    expect(Array.isArray(await tabsOf(mcp))).toBe(true);

    // The first profile lets go: the second one, which was waiting, connects by itself.
    await popup.getByRole('switch', { name: /Agent bridge/ }).click();
    await expect(card).toHaveAttribute('data-status', 'off');
    await expect(card2).toHaveAttribute('data-status', 'connected', { timeout: 30_000 });
    expect(hostPids(facet)).toHaveLength(1);
    expect(hostPids(facet)).not.toContain(firstHost);
    const info = await mcp.json<{ profileLabel: string; windows: number; tabs: number }>('bridge_info');
    expect(info.profileLabel).toBe('Second');
    expect(info.windows).toBeGreaterThanOrEqual(1);
  });

  test('the profile name from the options page is what bridge_info reports', async ({ facet }) => {
    await turnOn(facet);
    mcp = await startMcp(facet);
    expect((await mcp.json<{ profileLabel: string | null }>('bridge_info')).profileLabel).toBeNull();
    const options = await facet.ctx.newPage();
    await options.goto(ext('options.html'));
    const field = options.getByRole('textbox', { name: 'Profile name' });
    await field.fill('Work');
    await field.press('Enter');
    await expect.poll(async () => (await mcp!.json<{ profileLabel: string | null }>('bridge_info')).profileLabel).toBe('Work');
    await field.fill('');
    await field.blur();
    await expect.poll(async () => (await mcp!.json<{ profileLabel: string | null }>('bridge_info')).profileLabel).toBeNull();
    await options.close();
  });

  test('the action log records what was done to which site, never what the page said', async ({ facet }) => {
    await turnOn(facet);
    mcp = await startMcp(facet);
    const tabId = await openPlain(mcp, at('a.localhost', '/agent'));
    await mcp.json('type', { tabId, selector: '#name', text: 'secret-typed-text' });
    await mcp.call('get_tab_text', { tabId });
    await mcp.call('click', { tabId, selector: '#absent' });

    const log = await facet.api<Array<{ message: string; level: string; data?: Record<string, unknown> }>>('getLog');
    const actions = log.filter((e) => e.message === 'agent action');
    const tools = actions.map((e) => e.data!.tool);
    expect(tools).toEqual(expect.arrayContaining(['open_tab', 'type', 'get_tab_text', 'click']));
    const click = actions.find((e) => e.data!.tool === 'click' && e.data!.tabId === tabId)!;
    expect(click.data).toMatchObject({ tabId, host: `a.localhost:${new URL(at('a.localhost')).port}`, ok: false });
    expect(click.level).toBe('warn');
    const serialized = JSON.stringify(log);
    expect(serialized).not.toContain('secret-typed-text');
    expect(serialized).not.toContain('Agent page');
  });
});

/** The Playwright page of a tab that Facet or the bridge opened (so the test closes it afterwards). */
async function pageFor(facet: Facet, tabId: number): Promise<Page> {
  for (let i = 0; i < 50; i++) {
    for (const page of facet.ctx.pages()) {
      if (page.isClosed()) continue;
      if (/^http/.test(page.url()) && (await facet.tabIdOf(page).catch(() => -1)) === tabId) return page;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no page for tab ${tabId}`);
}
