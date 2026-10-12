import type { Page } from '@playwright/test';
import { at, expect, ext, followReplacement, go, pageJson, test, type Facet } from './fixtures';

/**
 * Regression tests for the isolation review of 2026-10-09 (findings 1-3) and the beacon identifier leak (4).
 * Each one failed on the code before the fix.
 */

let hostSeq = 0;
/** A site no earlier test has touched (*.localhost resolves to the stand without DNS). */
const freshHost = (label: string) => `${label}${Date.now().toString(36)}${++hostSeq}.localhost`;

/** Real-profile login on `host` plus a network-first service worker controlling its pages. */
async function realProfileWithWorker(facet: Facet, host: string): Promise<{ page: Page; sid: string }> {
  const page = await facet.plain(at(host, '/whoami'));
  await go(page, at(host, '/login?user=real'));
  await expect(page.locator('#user')).toHaveText('real');
  await go(page, at(host, '/swnet-page'));
  await expect(page.locator('#sw')).toHaveText('active');
  await page.reload();
  expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  const sid = (await facet.realCookies(at(host))).find((c) => c.name === 'sid')!.value;
  return { page, sid };
}

/** Who the real profile is on `host`, asked from a fresh plain tab. */
async function realUser(facet: Facet, host: string): Promise<string | null> {
  const page = await facet.plain(at(host, '/blank'));
  const user = (await pageJson(page, '/me')).user;
  await page.close();
  return user;
}

const registrations = (page: Page) => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length);

/**
 * Strict mode on, but a realm slipped past both of its layers (the shim's guard and the worker-script block), so a
 * worker can still be installed: the state the no-tab cookie rule exists for. Undo with `restoreStrict`.
 */
async function strictWithoutGuard(facet: Facet): Promise<void> {
  await facet.api('updateSettings', { strictMode: true });
  await facet.inWorker(async (_: null) => {
    const dnr = (globalThis as any).chrome.declarativeNetRequest;
    await dnr.updateDynamicRules({ removeRuleIds: [2] }); // STRICT_GUARD_RULE_ID
    const blocks = (await dnr.getSessionRules()).filter(
      (r: any) => r.action.type === 'block' && r.condition.tabIds?.includes(-1) && r.condition.resourceTypes?.join() === 'script',
    );
    await dnr.updateSessionRules({ removeRuleIds: blocks.map((r: any) => r.id) });
  }, null);
}

/** Puts the guard back after `strictWithoutGuard` (off and on again: the same path as the switch in Settings). */
async function restoreStrict(facet: Facet): Promise<void> {
  await facet.api('updateSettings', { strictMode: false });
  await facet.api('updateSettings', { strictMode: true });
}

test.describe('service workers of the real profile', () => {
  test('without strict mode, SplitSession removes the site’s worker before a container tab’s first request (open.html, new-tab link)', async ({ facet }) => {
    await facet.api('updateSettings', { strictMode: false });
    const host = freshHost('sw');
    const real = await realProfileWithWorker(facet, host);
    const A = await facet.container('A');

    await facet.clearLog();
    const pa = await facet.openIn(A.name, at(host, '/login?user=alice'));
    await expect(pa.locator('#user')).toHaveText('alice');
    const login = (await facet.serverLog()).filter((e) => e.host === host && e.path === '/login?user=alice');
    expect(login).toHaveLength(1);
    expect(login[0]!.cookie).toBe(''); // not the real profile's session: no worker forwarded it
    expect((await facet.api<Array<{ name: string }>>('getJar', A.id)).map((c) => c.name)).toContain('sid');
    expect((await facet.realCookies(at(host))).find((c) => c.name === 'sid')?.value).toBe(real.sid);
    expect(await realUser(facet, host)).toBe('real');
    expect(await registrations(real.page)).toBe(0);

    // A target=_blank link from a container page: SplitSession opens the child itself, after removing the target's workers.
    const other = freshHost('swlink');
    const real2 = await realProfileWithWorker(facet, other);
    const linker = await facet.openIn(A.name, at('b.localhost', `/link?target=_blank&to=${encodeURIComponent(at(other, '/login?user=alice2'))}`));
    await facet.clearLog();
    const opened = facet.ctx.waitForEvent('page');
    await linker.click('#go');
    const child = await opened;
    await expect(child.locator('#user')).toHaveText('alice2');
    const hit = (await facet.serverLog()).filter((e) => e.host === other && e.path === '/login?user=alice2');
    expect(hit).toHaveLength(1);
    expect(hit[0]!.cookie).toBe('');
    expect((await facet.realCookies(at(other))).find((c) => c.name === 'sid')?.value).toBe(real2.sid);
    expect(await realUser(facet, other)).toBe('real');
  });

  test('strict mode: turning it on removes every worker and no site can install one, so a link inside a container tab is safe', async ({ facet }) => {
    await facet.api('updateSettings', { strictMode: false });
    expect(await facet.api('getStrictMode')).toMatchObject({ enabled: false, active: false });
    const host = freshHost('strict');
    const real = await realProfileWithWorker(facet, host); // allowed: strict mode is off, the site is not a container site
    const A = await facet.container('A');

    await facet.api('updateSettings', { strictMode: true });
    await expect.poll(() => registrations(real.page)).toBe(0);
    expect(await facet.api('getStrictMode')).toMatchObject({ enabled: true, active: true });

    // A plain link in a container tab: the navigation is the page's own (SplitSession cannot prepare it), and there is no
    // worker left to answer it.
    const pa = await facet.openIn(A.name, at('b.localhost', `/link?to=${encodeURIComponent(at(host, '/login?user=alice'))}`));
    await facet.clearLog();
    await pa.click('#go');
    await expect(pa.locator('#user')).toHaveText('alice');
    const login = (await facet.serverLog()).filter((e) => e.host === host && e.path === '/login?user=alice');
    expect(login).toHaveLength(1);
    expect(login[0]!.cookie).toBe('');
    expect((await facet.realCookies(at(host))).find((c) => c.name === 'sid')?.value).toBe(real.sid);
    expect(await realUser(facet, host)).toBe('real');

    // New registrations are refused everywhere, also in plain tabs on sites no container has seen.
    const free = await facet.plain(at(freshHost('free'), '/sw-page'));
    await expect(free.locator('#sw')).toHaveText('rejected: SecurityError');
    expect(await free.evaluate(() => typeof SharedWorker)).toBe('function'); // nothing else is patched there
  });

  test('strict mode: a leftover real-profile worker on a container site can neither send nor write the real profile’s cookies', async ({ facet }) => {
    await strictWithoutGuard(facet); // workers can still be installed
    try {
      const family = freshHost('fam');
      const www = `www.${family}`;
      const real = await realProfileWithWorker(facet, www);
      const A = await facet.container('A');
      // The container visits the apex: the site (registrable domain) becomes a container site; only the apex
      // origin's workers are removed, the worker of www.<site> stays.
      const visit = await facet.openIn(A.name, at(family, '/blank'));
      await expect(visit.locator('h1')).toHaveText(family);
      await expect
        .poll(async () =>
          (await facet.api<Array<{ condition: { tabIds?: number[]; requestDomains?: string[] } }>>('getSessionRules')).some(
            (r) => r.condition.tabIds?.includes(-1) && r.condition.requestDomains?.includes(family),
          ),
        )
        .toBe(true);

      // The worker answers this navigation with its own fetch (no tab): it goes without the real profile's cookies
      // (a worker answering a container tab's request cannot carry the real session in), and the response's Set-Cookie
      // must not land.
      await facet.clearLog();
      await go(real.page, at(www, '/login?user=intruder'));
      await expect(real.page.locator('#user')).toHaveText('anonymous');
      expect(await real.page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
      const viaWorker = (await facet.serverLog()).filter((e) => e.host === www && (e.path === '/login?user=intruder' || e.path === '/whoami'));
      expect(viaWorker.length).toBeGreaterThan(0);
      for (const hit of viaWorker) expect(hit.cookie).toBe('');
      expect((await facet.realCookies(at(www))).find((c) => c.name === 'sid')?.value).toBe(real.sid);
    } finally {
      await restoreStrict(facet);
    }
  });

  test('strict mode: a request outside tabs that no page of the site started keeps the real profile’s cookies (session refresh by the browser)', async ({ facet }) => {
    // Third review, finding 2: the no-tab rule used to strip Cookie from EVERY tab-less request to a container site,
    // browser-initiated ones included (Google's background session refresh would sign the real profile out). It now
    // needs an initiator on a container site. The extension's own fetch is such a request here: tab ID -1, initiator
    // chrome-extension://…, i.e. not a managed site (Chrome's own requests have no initiator at all).
    const host = freshHost('norefresh');
    const real = await facet.plain(at(host, '/login?user=real'));
    await expect(real.locator('#user')).toHaveText('real');
    const sid = (await facet.realCookies(at(host))).find((c) => c.name === 'sid')!.value;
    const A = await facet.container('A');
    await facet.openIn(A.name, at(host, '/blank')); // the site becomes a container site
    await expect
      .poll(async () =>
        (await facet.api<Array<{ condition: { tabIds?: number[]; requestDomains?: string[]; initiatorDomains?: string[] } }>>('getSessionRules')).some(
          (r) => r.condition.tabIds?.includes(-1) && r.condition.requestDomains?.includes(host) && r.condition.initiatorDomains?.includes(host),
        ),
      )
      .toBe(true);

    const sent = await facet.inWorker(async (u: string) => (await fetch(u, { credentials: 'include' })).text(), at(host, '/echo'));
    expect(sent).toContain(`sid=${sid}`);
    await facet.inWorker(async (u: string) => void (await fetch(u, { credentials: 'include' })).text(), at(host, `/set?c=${encodeURIComponent('refreshed=1; Path=/')}`));
    expect((await facet.realCookies(at(host))).map((c) => c.name).sort()).toEqual(['refreshed', 'sid']);
    expect(await realUser(facet, host)).toBe('real');
  });

  test('a fresh install shows no strict-mode prompt anywhere; the switch in Settings removes the existing workers', async ({ facet }) => {
    // The state of an install that never saw strict mode: setting off (the default), nothing to answer.
    for (const c of await facet.api<Array<{ id: string }>>('listContainers')) await facet.api('deleteContainer', c.id);
    await facet.api('updateSettings', { strictMode: false });
    const real = await realProfileWithWorker(facet, freshHost('ui'));
    expect(await registrations(real.page)).toBe(1);

    const popup = await facet.ctx.newPage();
    await popup.setViewportSize({ width: 380, height: 700 });
    await popup.goto(ext('popup.html'));
    await expect(popup.getByRole('heading', { name: 'Containers' })).toBeVisible();
    await popup.getByRole('button', { name: 'New container' }).click();
    await popup.getByLabel('Name').fill(`First-${Date.now().toString(36)}`);
    const firstTab = facet.ctx.waitForEvent('page');
    await popup.getByRole('button', { name: 'Create' }).click();
    facet.adopt(await firstTab); // creating a container opens a tab in it and closes the popup
    await expect.poll(() => popup.isClosed()).toBe(true);
    const popup2 = await facet.ctx.newPage();
    await popup2.setViewportSize({ width: 380, height: 700 });
    await popup2.goto(ext('popup.html'));
    await expect(popup2.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
    await popup2.waitForTimeout(300);
    await expect(popup2.getByRole('alertdialog')).toHaveCount(0);
    await expect(popup2.getByRole('dialog')).toHaveCount(0);
    await expect(popup2.getByTestId('strict-warning')).toHaveCount(0);
    await popup2.reload();
    await expect(popup2.getByRole('heading', { name: 'Containers' })).toBeVisible();
    await expect(popup2.getByRole('alertdialog')).toHaveCount(0);
    await expect(popup2.getByLabel(/strict/i)).toHaveCount(0);
    await popup2.close();
    expect(await registrations(real.page)).toBe(1); // nothing was removed behind the user's back

    const options = await facet.ctx.newPage();
    await options.setViewportSize({ width: 1000, height: 900 });
    await options.goto(ext('options.html'));
    await expect(options.getByRole('heading', { name: 'SplitSession settings' })).toBeVisible();
    await expect(options.getByRole('alertdialog')).toHaveCount(0);
    const strict = options.getByRole('switch', { name: /Strict mode/ });
    await expect(strict).toHaveAttribute('aria-checked', 'false');
    await expect(strict).toContainText('Sites can’t send push notifications while it’s on.');

    // "Why we need this": a custom disclosure, closed until asked for.
    const why = options.getByRole('button', { name: 'Why we need this' });
    await expect(why).toHaveAttribute('aria-expanded', 'false');
    await why.click();
    await expect(why).toHaveAttribute('aria-expanded', 'true');
    await expect(options.getByText(/Chrome gives each site one background helper/)).toBeVisible();
    await why.click();
    await expect(why).toHaveAttribute('aria-expanded', 'false');

    await strict.click();
    await expect(strict).toHaveAttribute('aria-checked', 'true');
    await expect.poll(() => registrations(real.page)).toBe(0);
    expect(await facet.api('getStrictMode')).toMatchObject({ enabled: true, active: true });
    expect(await facet.api('getSettings')).toMatchObject({ strictMode: true });
    // No site can install a worker now, also in a plain tab.
    const blocked = await facet.plain(at(freshHost('blocked'), '/sw-page'));
    await expect(blocked.locator('#sw')).toHaveText('rejected: SecurityError');

    // Off again: workers can register on sites no container uses.
    await strict.click();
    await expect(strict).toHaveAttribute('aria-checked', 'false');
    expect(await facet.api('getStrictMode')).toMatchObject({ enabled: false, active: false });
    const allowed = await facet.plain(at(freshHost('allowed'), '/sw-page'));
    await expect(allowed.locator('#sw')).toHaveText('registered');
    await options.close();
  });
});

test.describe('SameSite', () => {
  test('a cross-site page in a container tab cannot ride the container’s Lax, unspecified or Strict cookies', async ({ facet }) => {
    const A = await facet.container('A');
    const pa = await facet.openIn(A.name, at('a.localhost', '/login?user=alice'));
    await expect(pa.locator('#user')).toHaveText('alice'); // sid: HttpOnly, SameSite=Lax
    const set = (v: string) => `/set?c=${encodeURIComponent(v)}`;
    await go(pa, at('a.localhost', set('none=1; SameSite=None; Secure; Path=/')));
    await go(pa, at('a.localhost', set('plain=2; Path=/')));
    await go(pa, at('a.localhost', set('strict=3; SameSite=Strict; Path=/')));

    // Same-site: everything.
    expect((await pageJson(pa, '/me')).cookie).toMatch(/^(?=.*sid=)(?=.*none=1)(?=.*plain=2)(?=.*strict=3)/);

    // The same tab moves on to another site, which tries to use the session.
    const me = at('a.localhost', '/me');
    await go(pa, at('b.localhost', `/link?to=${encodeURIComponent(me)}`));
    const reads = await pa.evaluate(async (u) => {
      const omit = await (await fetch(u, { credentials: 'omit' })).json();
      const dflt = await (await fetch(u)).json();
      return { omit: omit.user, dflt: dflt.user, cookie: dflt.cookie };
    }, me);
    expect(reads).toEqual({ omit: null, dflt: null, cookie: 'none=1' });

    // Residual (docs/limits.md): declarativeNetRequest cannot see the credentials mode, so SameSite=None cookies
    // still go along on a cross-site request made with credentials: 'omit'.
    await facet.clearLog();
    await pa.evaluate((u) => fetch(u, { credentials: 'omit', mode: 'no-cors' }), at('a.localhost', '/echo?k=omit'));
    expect((await facet.serverLog()).find((e) => e.path === '/echo?k=omit')?.cookie).toBe('none=1');

    // A cross-site form POST (CSRF): no Lax or unspecified cookie.
    await pa.click('#post-go');
    await pa.waitForURL(me);
    expect(JSON.parse(await pa.locator('body').innerText())).toMatchObject({ user: null, cookie: 'none=1' });

    // A cross-site top-level GET (a link): Lax and unspecified cookies go, Strict ones do not (as in Chrome).
    await go(pa, at('b.localhost', `/link?to=${encodeURIComponent(me)}`));
    await pa.click('#go');
    await pa.waitForURL(me);
    const landed = JSON.parse(await pa.locator('body').innerText());
    expect(landed.user).toBe('alice');
    expect(landed.cookie).toContain('plain=2');
    expect(landed.cookie).not.toContain('strict=3');
  });
});

test.describe('#ctr= marker', () => {
  test('a page cannot switch its tab’s container; only a navigation the browser starts can use the marker', async ({ facet }) => {
    const A = await facet.container('A');
    const B = await facet.container('B');
    const pa = await facet.openIn(A.name, at('a.localhost', '/login?user=alice'));
    await expect(pa.locator('#user')).toHaveText('alice');
    const paId = await facet.tabIdOf(pa);

    // Same-document hash change in a container tab.
    await pa.evaluate(() => ((window as unknown as { __mem: string }).__mem = 'state-of-A'));
    await pa.evaluate((b) => (location.hash = `ctr=${encodeURIComponent(b)}`), B.name);
    await pa.waitForTimeout(1_000);
    expect(await pa.evaluate(() => (window as unknown as { __mem?: string }).__mem)).toBe('state-of-A');
    expect(await facet.api('getTabContainer', paId)).toBe(A.id);
    expect((await pageJson(pa, '/me')).user).toBe('alice');

    // A plain tab: neither a hash change nor a page-initiated navigation to a marked URL moves it.
    const plain = await facet.plain(at('a.localhost', '/login?user=real'));
    await expect(plain.locator('#user')).toHaveText('real');
    const plainId = await facet.tabIdOf(plain);
    await plain.evaluate((a) => (location.hash = `ctr=${encodeURIComponent(a)}`), A.name);
    await plain.evaluate((a) => (location.href = `/whoami?by=page#ctr=${encodeURIComponent(a)}`), A.name);
    await plain.waitForURL(/by=page/);
    await plain.waitForTimeout(1_000);
    expect(await facet.api('getTabContainer', plainId)).toBeNull();
    await expect(plain.locator('#user')).toHaveText('real');
    expect(plain.url()).toContain('#ctr=');

    // The same URL typed by the user / sent by an agent (tabs.update: no initiator) works.
    const target = at('a.localhost', `/whoami?by=agent#ctr=${encodeURIComponent(A.name)}`);
    await facet.inWorker(async ({ tabId, url }) => void (await (globalThis as any).chrome.tabs.update(tabId, { url })), { tabId: plainId, url: target });
    await expect.poll(() => plain.url()).toBe(at('a.localhost', '/whoami?by=agent'));
    await expect(plain.locator('#user')).toHaveText('alice');
    expect(await facet.api('getTabContainer', plainId)).toBe(A.id);
    // ...but not for a tab that is already in a container.
    await facet.inWorker(async ({ tabId, url }) => void (await (globalThis as any).chrome.tabs.update(tabId, { url })), {
      tabId: plainId,
      url: at('a.localhost', `/whoami?again=1#ctr=${encodeURIComponent(B.name)}`),
    });
    await plain.waitForURL(/again=1/);
    await plain.waitForTimeout(800);
    expect(await facet.api('getTabContainer', plainId)).toBe(A.id);
    expect(await facet.realCookies(at('a.localhost'))).toHaveLength(1); // the real profile's own login, untouched
  });
});

test.describe('beacon', () => {
  const beacon = (page: Page) => page.evaluate(async () => JSON.parse(await (await fetch('http://ctr.localhost/whoami')).text()));

  test('pages see a stable per-site key, never the container ID; the name only while the setting allows it', async ({ facet }) => {
    const A = await facet.container('A');
    const B = await facet.container('B');
    const pa = await facet.openIn(A.name, at('a.localhost', '/blank'));
    const onA = await beacon(pa);
    expect(onA.c).toMatch(/^[a-z2-7]{16}$/);
    expect(onA.n).toBe(A.name);
    expect(JSON.stringify(onA)).not.toContain(A.id);

    await go(pa, at('b.localhost', '/blank'));
    const onB = await beacon(pa);
    expect(onB.c).toMatch(/^[a-z2-7]{16}$/);
    expect(onB.c).not.toBe(onA.c); // two sites of one container cannot be linked by the key
    await go(pa, at('a.localhost', '/blank'));
    expect((await beacon(pa)).c).toBe(onA.c); // stable: storage stays where it was
    const pb = await facet.openIn(B.name, at('a.localhost', '/blank'));
    expect((await beacon(pb)).c).not.toBe(onA.c);

    // Raw names in the origin carry the key, not the ID: an unpatched dedicated worker sees them.
    await pa.evaluate(() => new Promise<void>((resolve) => (indexedDB.open('probe-db').onsuccess = (e) => ((e.target as IDBOpenDBRequest).result.close(), resolve()))));
    const raw = await pa.evaluate(
      () =>
        new Promise<string[]>((resolve) => {
          const w = new Worker(URL.createObjectURL(new Blob(['indexedDB.databases().then((d) => postMessage(d.map((x) => x.name)))'], { type: 'text/javascript' })));
          w.onmessage = (e) => resolve(e.data);
        }),
    );
    expect(raw).toContain(`__facet:${onA.c}:probe-db`);
    expect(raw.join(' ')).not.toContain(A.id);

    // Setting off: open pages lose the marks at once; new pages get no name at all.
    await facet.api('updateSettings', { showNameToPages: false });
    await expect.poll(() => pa.evaluate(() => document.documentElement.dataset.ctr ?? null)).toBeNull();
    await expect.poll(() => pa.title()).toBe('a.localhost blank');
    const fresh = await facet.openIn(A.name, at('a.localhost', '/blank'));
    const quiet = await beacon(fresh);
    expect(quiet.n).toBeUndefined();
    expect(quiet.c).toBe(onA.c);
    expect(await fresh.evaluate(() => document.documentElement.dataset.ctr ?? null)).toBeNull();
    await fresh.waitForTimeout(300);
    expect(await fresh.title()).toBe('a.localhost blank');
  });

  test('a frame on a site the container has not seen yet still gets its own key before its scripts run', async ({ facet }) => {
    const A = await facet.container('A');
    const site = freshHost('frame');
    const host = await facet.openIn(A.name, at('a.localhost', `/frame-host?child=${encodeURIComponent(at(site, '/blank'))}`));
    const frame = host.frameLocator('#f');
    await expect(frame.locator('h1')).toHaveText(site);
    const inFrame = host.frames().find((f) => f.url().startsWith(at(site, '/')))!;
    await inFrame.evaluate(() => localStorage.setItem('probe', 'from-container'));
    const fromBeacon = await inFrame.evaluate(async () => JSON.parse(await (await fetch('http://ctr.localhost/whoami')).text()));
    expect(fromBeacon.c).toMatch(/^[a-z2-7]{16}$/);
    // The frame's storage is the container's: the real profile on that site does not see it.
    const plain = await facet.plain(at(site, '/blank'));
    expect(await plain.evaluate(() => localStorage.getItem('probe'))).toBeNull();
    // And it is the stable namespace of (container, site), not a throwaway one: a top-level visit sees it.
    const top = await facet.openIn(A.name, at(site, '/blank'));
    expect(await top.evaluate(() => localStorage.getItem('probe'))).toBe('from-container');
  });

  test('a frame whose site has no beacon answer asks for one and waits for it before the page’s scripts run', async ({ facet }) => {
    const A = await facet.container('A');
    const site = freshHost('lost');
    const pa = await facet.openIn(A.name, at(site, '/blank'));
    await pa.evaluate(() => localStorage.setItem('shared', 'top'));
    const tabId = await facet.tabIdOf(pa);
    // Take the site's answer away behind SplitSession's back (as if an update of the rules had been lost).
    await facet.inWorker(
      async ({ tabId, site }) => {
        const dnr = (globalThis as any).chrome.declarativeNetRequest;
        const rules: Array<{ id: number; condition: { tabIds?: number[]; initiatorDomains?: string[] } }> = await dnr.getSessionRules();
        const ids = rules.filter((r) => r.condition.tabIds?.includes(tabId) && r.condition.initiatorDomains?.includes(site)).map((r) => r.id);
        await dnr.updateSessionRules({ removeRuleIds: ids });
      },
      { tabId, site },
    );
    expect(await beacon(pa)).toMatchObject({ p: 1 });

    await pa.evaluate((src) => {
      const f = document.createElement('iframe');
      f.id = 'late';
      f.src = src;
      document.body.append(f);
    }, at(site, '/frame'));
    const frame = pa.frameLocator('#late');
    await expect(frame.locator('#cookies')).toBeAttached();
    const inFrame = pa.frames().find((f) => f.url() === at(site, '/frame'))!;
    // Same (container, site) namespace as the top document: the frame waited for the real key, not a throwaway one.
    expect(await inFrame.evaluate(() => localStorage.getItem('shared'))).toBe('top');
    const log = await facet.api<Array<{ message: string }>>('getLog');
    expect(log.some((e) => e.message.includes(`beacon answer for ${site} asked by a frame of tab ${tabId}`))).toBe(true);
  });
});

/**
 * Second review (2026-10-09): a document whose scripts are disabled (`<iframe sandbox="allow-same-origin">` without
 * `allow-scripts`) gets no shim, yet the page that embeds it can use its realm. Each test failed before the fix.
 */
test.describe('frames whose scripts are disabled', () => {
  const realState = async (facet: Facet, host: string) => {
    const real = await facet.plain(at(host, '/blank'));
    await real.evaluate(() => {
      document.cookie = 'realtrack=REAL123; path=/';
      localStorage.setItem('uid', 'REAL-LS');
    });
    return real;
  };

  test('a container page cannot read or write the real profile’s cookies and storage through a sandboxed frame', async ({ facet }) => {
    const host = freshHost('sbx');
    const real = await realState(facet, host);
    const A = await facet.container('A');
    const pa = await facet.openIn(A.name, at(host, '/blank'));
    await pa.evaluate(() => {
      document.cookie = 'mine=A; path=/';
      localStorage.setItem('uid', 'A-LS');
    });
    await expect.poll(async () => (await facet.api<Array<{ name: string }>>('getJar', A.id)).map((c) => c.name)).toContain('mine');

    const seen = await pa.evaluate(async () => {
      const W = window as any;
      const view = (w: any) => ({ cookie: String(w.document.cookie), ls: w.localStorage.getItem('uid') });
      const out: Record<string, unknown> = {};
      const frame = (attrs: Record<string, string>) => {
        const f = document.createElement('iframe');
        for (const [k, v] of Object.entries(attrs)) f.setAttribute(k, v);
        document.body.append(f);
        return f;
      };
      const loaded = (f: HTMLIFrameElement) => new Promise((r) => f.addEventListener('load', r, { once: true }));
      // The reviewer's case: reached through window[n], before and after its document loads.
      const f1 = frame({ sandbox: 'allow-same-origin', src: '/blank' });
      const i1 = W.length - 1;
      out.initial = view(W[i1]);
      await loaded(f1);
      out.loaded = view(W[i1]);
      out.viaContentDocument = String(f1.contentDocument!.cookie);
      // The real profile's own native getter, taken from the frame's realm and called on the container's document.
      const getter = Object.getOwnPropertyDescriptor(W[i1].Document.prototype, 'cookie')!.get!;
      out.borrowedGetter = String(getter.call(document));
      // srcdoc, inserted through innerHTML, read in the same task.
      const holder = document.createElement('div');
      document.body.append(holder);
      holder.innerHTML = '<iframe sandbox="allow-same-origin" srcdoc="<p>x</p>"></iframe>';
      out.srcdocSameTask = view(W[W.length - 1]);
      // A frame inside the sandboxed frame (inherits the sandbox), reached as window[n][0].
      const f2 = frame({ sandbox: 'allow-same-origin', srcdoc: '<iframe src="/blank?inner"></iframe>' });
      await loaded(f2);
      const outer = W[W.length - 1];
      await new Promise((r) => setTimeout(r, 300));
      out.nested = outer.length > 0 ? view(outer[0]) : 'no inner frame';
      // Navigated again: a new realm, patched by the time the page gets it after the load.
      f1.src = '/blank?again';
      await loaded(f1);
      out.renavigated = view(W[i1]);
      // Writes through the frame: they must land in the container.
      W[i1].document.cookie = 'planted=FROM_CONTAINER; path=/; max-age=99999';
      W[i1].localStorage.setItem('planted', 'FROM_CONTAINER');
      return out;
    });
    const container = { cookie: 'mine=A', ls: 'A-LS' };
    expect(seen.initial).toEqual(container);
    expect(seen.loaded).toEqual(container);
    expect(seen.viaContentDocument).toBe('mine=A');
    expect(seen.borrowedGetter).toBe('mine=A');
    expect(seen.srcdocSameTask).toEqual(container);
    expect(seen.nested).toEqual(container);
    expect(seen.renavigated).toEqual(container);

    // Writes through the frame went into the container, not into the real profile.
    await expect.poll(async () => (await facet.api<Array<{ name: string }>>('getJar', A.id)).map((c) => c.name)).toContain('planted');
    expect((await facet.realCookies(at(host))).map((c) => `${c.name}=${c.value}`)).toEqual(['realtrack=REAL123']);
    expect(await real.evaluate(() => [localStorage.getItem('uid'), localStorage.getItem('planted')])).toEqual(['REAL-LS', null]);
    expect(await pa.evaluate(() => localStorage.getItem('planted'))).toBe('FROM_CONTAINER');
  });

  test('a same-origin <object> document and a sandboxed cousin of a cross-site parent are patched too; an opaque sandbox reaches nothing', async ({ facet }) => {
    const host = freshHost('obj');
    await realState(facet, host);
    const A = await facet.container('A');
    const pa = await facet.openIn(A.name, at(host, '/blank'));
    const objectView = await pa.evaluate(async () => {
      const o = document.createElement('object');
      o.type = 'text/html';
      o.data = '/blank?object';
      document.body.append(o);
      await new Promise((r) => o.addEventListener('load', r, { once: true }));
      const w = (window as any)[window.length - 1];
      return { viaFrames: String(w.document.cookie), viaContentDocument: String(o.contentDocument!.cookie), ls: w.localStorage.getItem('uid') };
    });
    expect(objectView).toEqual({ viaFrames: '', viaContentDocument: '', ls: null });

    // Opaque origin (`sandbox` without allow-same-origin): the parent cannot reach the document, and the frame's own
    // scripts cannot reach any storage.
    const opaque = await pa.evaluate(async () => {
      const f = document.createElement('iframe');
      f.setAttribute('sandbox', 'allow-scripts');
      f.srcdoc = `<script>
        const r = {};
        try { r.cookie = String(document.cookie); } catch (e) { r.cookie = e.name; }
        try { r.ls = String(localStorage.getItem('uid')); } catch (e) { r.ls = e.name; }
        parent.postMessage({ opaque: r }, '*');
      <\/script>`;
      const fromInside = new Promise((resolve) => addEventListener('message', (e) => e.data?.opaque && resolve(e.data.opaque)));
      document.body.append(f);
      const inside = await fromInside;
      let outside = '';
      try {
        outside = String((window as any)[window.length - 1].document.cookie);
      } catch (e) {
        outside = (e as Error).name;
      }
      return { inside, outside };
    });
    expect(opaque).toEqual({ inside: { cookie: 'SecurityError', ls: 'SecurityError' }, outside: 'SecurityError' });

    // A cross-site top document embeds a scripted frame and a sandboxed frame of `host`: the scripted one reaches its
    // sandboxed sibling through the parent, which it cannot script itself.
    const top = await facet.openIn(A.name, at('a.localhost', '/blank'));
    await top.evaluate((src) => {
      for (const sandbox of [null, 'allow-same-origin']) {
        const f = document.createElement('iframe');
        if (sandbox) f.setAttribute('sandbox', sandbox);
        f.src = src;
        document.body.append(f);
      }
    }, at(host, '/blank?cousin'));
    await expect.poll(() => top.frames().filter((f) => f.url() === at(host, '/blank?cousin')).length).toBe(2);
    const scripted = top.frames().find((f) => f.url() === at(host, '/blank?cousin'))!;
    await scripted.waitForLoadState('load');
    await top.waitForTimeout(300);
    const cousin = await scripted.evaluate(() => {
      const sibling = (parent as any)[1];
      return { cookie: String(sibling.document.cookie), ls: sibling.localStorage.getItem('uid'), own: document.cookie };
    });
    expect(cousin).toEqual({ cookie: '', ls: null, own: '' });
  });

  test('strict mode: no realm can install a service worker, so a link in a container tab still logs in there', async ({ facet }) => {
    expect(await facet.api('getStrictMode')).toMatchObject({ active: true });
    const host = freshHost('byp');
    const page = await facet.plain(at(host, '/whoami'));
    await go(page, at(host, '/login?user=real'));
    await expect(page.locator('#user')).toHaveText('real');
    const sid = (await facet.realCookies(at(host))).find((c) => c.name === 'sid')!.value;
    await go(page, at(host, '/blank'));

    // The reviewer's ways around the shim: a sandboxed frame's own register(), and its native register() applied to
    // the page's own container. The shim patches the frame's realm, so all are refused.
    const viaFrames = await page.evaluate(async () => {
      const out: string[] = [];
      for (const variant of ['src', 'srcdoc']) {
        const f = document.createElement('iframe');
        f.setAttribute('sandbox', 'allow-same-origin');
        if (variant === 'src') f.src = '/blank';
        else f.srcdoc = '<p>x</p>';
        document.body.append(f);
        await new Promise((r) => f.addEventListener('load', r, { once: true }));
        const w = (window as any)[window.length - 1];
        for (const [label, attempt] of [
          ['own', () => w.navigator.serviceWorker.register('/swnet.js')],
          ['borrowed', () => w.ServiceWorkerContainer.prototype.register.call(navigator.serviceWorker, '/swnet.js')],
        ] as const) {
          out.push(`${variant}/${label}: ${await attempt().then(() => 'registered', (e: Error) => e.name)}`);
        }
      }
      return out;
    });
    expect(viaFrames).toEqual(['src/own: SecurityError', 'src/borrowed: SecurityError', 'srcdoc/own: SecurityError', 'srcdoc/borrowed: SecurityError']);

    // A realm SplitSession never patched at all (a CDP isolated world stands in for one): the network layer refuses the
    // worker's script, because in strict mode no script request outside tabs is allowed.
    const cdp = await facet.ctx.newCDPSession(page);
    const { frameTree } = (await cdp.send('Page.getFrameTree')) as { frameTree: { frame: { id: string } } };
    const { executionContextId } = (await cdp.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'unpatched' })) as {
      executionContextId: number;
    };
    const raw = (await cdp.send('Runtime.evaluate', {
      contextId: executionContextId,
      awaitPromise: true,
      expression: `navigator.serviceWorker.register('/swnet.js').then(() => navigator.serviceWorker.ready).then(() => 'registered', (e) => 'refused: ' + e.name)`,
    })) as { result: { value: string } };
    await cdp.detach();
    expect(raw.result.value).toMatch(/^refused: /);
    expect(await registrations(page)).toBe(0);

    // The reviewer's follow-up: a link in container tab A to the site logs in as alice inside A.
    const A = await facet.container('A');
    const pa = await facet.openIn(A.name, at('b.localhost', `/link?to=${encodeURIComponent(at(host, '/login?user=alice'))}`));
    await facet.clearLog();
    await pa.click('#go');
    await expect(pa.locator('#user')).toHaveText('alice');
    const login = (await facet.serverLog()).filter((e) => e.host === host && e.path === '/login?user=alice');
    expect(login).toHaveLength(1);
    expect(login[0]!.cookie).not.toContain(sid);
    expect((await facet.api<Array<{ name: string }>>('getJar', A.id)).map((c) => c.name)).toContain('sid');
    expect((await facet.realCookies(at(host))).find((c) => c.name === 'sid')?.value).toBe(sid);
    expect(await realUser(facet, host)).toBe('real');
  });
});

test.describe('a tab moved into a container has no opener (third review, finding 1)', () => {
  /** Work holds a login (HttpOnly), a page-set cookie and a localStorage entry on `host`; a plain tab is open on it. */
  async function setup(facet: Facet, host: string) {
    const W = await facet.container('Work');
    const work = await facet.openIn(W.name, at(host, '/login?user=work-user'));
    await expect(work.locator('#user')).toHaveText('work-user');
    await work.evaluate(() => {
      document.cookie = 'wtrack=W1; Path=/';
      localStorage.setItem('wls', 'W-LS');
    });
    const opener = await facet.plain(at(host, '/blank'));
    return { W, work, opener };
  }

  /** What `opener` can learn about the window it holds in `window.w`, as strings. */
  const probe = (opener: Page) =>
    opener.evaluate(async () => {
      const w = (window as any).w as Window & typeof globalThis;
      const out: Record<string, string> = { closed: String(w.closed) };
      const attempt = async (key: string, fn: () => unknown) => {
        try {
          out[key] = String(await fn());
        } catch (e) {
          out[key] = `threw ${(e as Error).name}`;
        }
      };
      await attempt('cookie', () => w.document.cookie);
      await attempt('ls', () => w.localStorage.getItem('wls'));
      await attempt('user', async () => (await w.fetch('/me')).text());
      await attempt('location', () => w.location.href);
      return out;
    });

  /** The page `opener` opened that now shows `needle`, once the extension moved it (the first tab is closed). */
  async function movedPopup(facet: Facet, before: Set<Page>, needle: string): Promise<Page> {
    let found: Page | undefined;
    await expect
      .poll(() => (found = facet.ctx.pages().find((p) => !before.has(p) && !p.isClosed() && p.url().includes(needle))) !== undefined, { timeout: 15_000 })
      .toBe(true);
    facet.adopt(found!);
    await found!.waitForLoadState('domcontentloaded').catch(() => {});
    return found!;
  }

  const leaks = (seen: Record<string, string>) => JSON.stringify(seen).match(/work-user|W1|W-LS/);

  test('a rule moving a popup into a container: the opener can neither read nor script it', async ({ facet }) => {
    const host = freshHost('opener');
    const { W, opener } = await setup(facet, host);
    await facet.api('setDomainRule', { domain: host, action: 'always', containerId: W.id });

    const before = new Set(facet.ctx.pages());
    await opener.evaluate(() => ((window as any).w = window.open('/whoami?popup=1')));
    // The old popup closes once the container tab exists.
    await expect.poll(() => opener.evaluate(() => (window as any).w.closed), { timeout: 15_000 }).toBe(true);
    const moved = await movedPopup(facet, before, 'popup=1');
    await expect(moved.locator('#user')).toHaveText('work-user'); // the container's login
    expect(await facet.api('getTabContainer', await facet.tabIdOf(moved))).toBe(W.id);
    expect(await moved.evaluate(() => document.cookie)).toContain('wtrack=W1');

    // The new tab was never opened by a page: no opener to script it...
    expect(await moved.evaluate(() => window.opener)).toBeNull();
    // ...and the window the opener holds is the old one, closed, with nothing of the container in it.
    await expect.poll(() => opener.evaluate(() => (window as any).w.closed)).toBe(true);
    const seen = await probe(opener);
    expect(seen.closed).toBe('true');
    expect(leaks(seen), JSON.stringify(seen)).toBeNull();
    // And the opener's own (real-profile) view is untouched.
    expect(await opener.evaluate(() => document.cookie)).not.toContain('wtrack');
    expect(await facet.realCookies(at(host))).toEqual([]);
  });

  test('the choose page: picking a container for a tab that has an opener opens a fresh tab, not the same document', async ({ facet }) => {
    const host = freshHost('chooseop');
    const { W, opener } = await setup(facet, host);
    await facet.api('setDomainRule', { domain: host, action: 'ask' });

    const before = new Set(facet.ctx.pages());
    await opener.evaluate(() => ((window as any).w = window.open('/whoami?popup=2')));
    const asking = await movedPopup(facet, before, 'choose.html');
    await expect(asking.getByTestId('choose-url')).toHaveText(at(host, '/whoami?popup=2'));
    const moved = await followReplacement(facet, asking, () => asking.getByTestId('choose-container').filter({ hasText: W.name }).click());

    await expect(moved.locator('#user')).toHaveText('work-user');
    expect(await facet.api('getTabContainer', await facet.tabIdOf(moved))).toBe(W.id);
    expect(await moved.evaluate(() => document.cookie)).toContain('wtrack=W1');
    expect(await moved.evaluate(() => window.opener)).toBeNull();
    await expect.poll(() => opener.evaluate(() => (window as any).w.closed)).toBe(true);
    const seen = await probe(opener);
    expect(leaks(seen), JSON.stringify(seen)).toBeNull();
  });

  test('a container page’s popup into the SAME container keeps its opener (same identity)', async ({ facet }) => {
    const host = freshHost('sameopen');
    const { W, work } = await setup(facet, host);
    await facet.api('setDomainRule', { domain: host, action: 'always', containerId: W.id });
    const opened = facet.ctx.waitForEvent('page');
    await work.evaluate(() => ((window as any).w = window.open('/whoami?popup=3')));
    const child = await opened;
    facet.adopt(child);
    await expect(child.locator('#user')).toHaveText('work-user');
    expect(await facet.api('getTabContainer', await facet.tabIdOf(child))).toBe(W.id);
    expect(await child.evaluate(() => window.opener !== null)).toBe(true);
    expect(await work.evaluate(() => (window as any).w.closed)).toBe(false);
  });
});
