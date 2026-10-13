import type { Page } from '@playwright/test';
import { at, expect, followReplacement, go, test, type Facet } from './fixtures';

/** `/set?c=<cookie>`: a persistent cookie (in the real profile or, from a container tab, in the container's jar). */
const setCookie = (host: string, value: string) => at(host, `/set?c=${encodeURIComponent(`${value}; Max-Age=86400; Path=/`)}`);

/** Requests the stand saw for `pathWithQuery`, as their Cookie headers. */
async function cookiesFor(facet: Facet, pathWithQuery: string): Promise<string[]> {
  return (await facet.serverLog()).filter((e) => e.path === pathWithQuery).map((e) => e.cookie);
}

/** A container tab whose jar holds `cookie` for a.localhost, inside the container's tab group. */
async function containerTab(facet: Facet, ref: string, cookie: string): Promise<{ page: Page; tabId: number; groupId: number }> {
  const page = await facet.openIn(ref, setCookie('a.localhost', cookie));
  await go(page, at('a.localhost', '/whoami'));
  await expect(page.locator('#cookies')).toHaveText(cookie);
  const tabId = await facet.tabIdOf(page);
  await expect.poll(async () => (await facet.tabInfo(tabId)).groupId).toBeGreaterThanOrEqual(0);
  return { page, tabId, groupId: (await facet.tabInfo(tabId)).groupId };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** What the group guard logged (each enforcement: tab, containers from -> to, reason). */
const guardLog = async (facet: Facet) => (await facet.api<Array<{ message: string }>>('getLog')).map((e) => e.message).filter((m) => m.startsWith('group guard:'));

/** Opens a tab the way Chrome does inside a group ("New tab to the right" of `nextTo`): at its index, with it as opener. */
const chromeNewTabInGroup = (facet: Facet, nextTo: number, url?: string) =>
  facet.inWorker(
    async ([id, address]: [number, string | null]) => {
      const c = (globalThis as any).chrome;
      const t = await c.tabs.get(id);
      const created = await c.tabs.create({ index: t.index + 1, openerTabId: id, active: true, ...(address ? { url: address } : {}) });
      return { id: created.id as number, groupId: created.groupId as number };
    },
    [nextTo, url ?? null] as [number, string | null],
  );
const groupTabs = (facet: Facet, tabIds: number[], groupId?: number) =>
  facet.inWorker(async ([ids, group]: [number[], number | undefined]) => (globalThis as any).chrome.tabs.group({ tabIds: ids, ...(group !== undefined ? { groupId: group } : {}) }) as Promise<number>, [tabIds, groupId] as [number[], number | undefined]);

const tabCount = async (facet: Facet, containerId: string) => (await facet.api<Array<{ containerId: string }>>('listTabs')).filter((t) => t.containerId === containerId).length;

test.describe('every tab inside a SplitSession tab group is in its container', () => {
  test('an ordinary tab moved into a container’s group is reopened in that container: its first request has the container’s cookies, never the real profile’s', async ({ facet }) => {
    const R = await facet.container('Reddit');
    const { groupId } = await containerTab(facet, R.name, 'who=reddit');
    const plain = await facet.plain(setCookie('a.localhost', 'who=real'));
    await go(plain, at('a.localhost', '/whoami?t=drag'));
    await expect(plain.locator('#cookies')).toHaveText('who=real');
    const plainId = await facet.tabIdOf(plain);
    await facet.clearLog();

    const next = await followReplacement(facet, plain, () => groupTabs(facet, [plainId], groupId));
    await expect(next.locator('#cookies')).toHaveText('who=reddit');
    const nextId = await facet.tabIdOf(next);
    expect(await facet.api('getTabContainer', nextId)).toBe(R.id);
    expect(await facet.api('getTabContainer', plainId)).toBeNull();
    // The group looks the same as before and now holds the new tab.
    await expect.poll(async () => (await facet.tabInfo(nextId)).groupId).toBe(groupId);
    // Every request for the page, the first one included, carried the container's cookie and nothing of the real profile.
    const sent = await cookiesFor(facet, '/whoami?t=drag');
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((c) => c === 'who=reddit')).toBe(true);
    expect((await facet.realCookies(at('a.localhost'))).map((c) => c.value)).toEqual(['real']); // untouched
    // A short notice on the button, then the usual colour dot.
    await expect.poll(async () => (await facet.tabInfo(nextId)).badge).toBe('→');
    await expect.poll(async () => (await facet.tabInfo(nextId)).badge, { timeout: 10_000 }).toBe(' ');
  });

  test('a container tab moved from one container’s group into another’s is reopened in the second', async ({ facet }) => {
    const A = await facet.container('Alpha');
    const B = await facet.container('Beta');
    const a = await containerTab(facet, A.name, 'who=alice');
    const b = await containerTab(facet, B.name, 'who=bob');
    expect(a.groupId).not.toBe(b.groupId);
    await facet.clearLog();
    await go(a.page, at('a.localhost', '/whoami?t=a2b'));

    const next = await followReplacement(facet, a.page, () => groupTabs(facet, [a.tabId], b.groupId));
    await expect(next.locator('#cookies')).toHaveText('who=bob');
    expect(await facet.api('getTabContainer', await facet.tabIdOf(next))).toBe(B.id);
    expect(await tabCount(facet, A.id)).toBe(0);
    expect(await tabCount(facet, B.id)).toBe(2);
    expect(await cookiesFor(facet, '/whoami?t=a2b')).toEqual(['who=alice', 'who=bob']); // its own load, then the reopened one
  });

  test('taking a container tab out of its group, or into a group that is not SplitSession’s, keeps its container and its badge', async ({ facet }) => {
    const A = await facet.container('Alpha');
    const a = await containerTab(facet, A.name, 'who=alice');
    const before = (await facet.api<unknown[]>('listTabs')).length;
    await facet.inWorker(async (id: number) => (globalThis as any).chrome.tabs.ungroup(id), a.tabId);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect((await facet.tabInfo(a.tabId)).groupId).toBe(-1);
    expect(await facet.api('getTabContainer', a.tabId)).toBe(A.id);
    expect((await facet.tabInfo(a.tabId)).badge).toBe(' ');

    const mine = await groupTabs(facet, [a.tabId]);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect((await facet.tabInfo(a.tabId)).groupId).toBe(mine);
    expect(await facet.api('getTabContainer', a.tabId)).toBe(A.id);
    expect((await facet.tabInfo(a.tabId)).badge).toBe(' ');
    expect((await facet.api<unknown[]>('listTabs')).length).toBe(before);
    expect(a.page.isClosed()).toBe(false);
  });

  test('a page that is not a website moved into the group is assigned where it stands (nothing reloads); what it opens next is in the container', async ({ facet }) => {
    const R = await facet.container('Reddit');
    const { groupId } = await containerTab(facet, R.name, 'who=reddit');
    await facet.plain(setCookie('a.localhost', 'who=real')).then((p) => p.close());
    const blank = await facet.ctx.newPage();
    facet.adopt(blank);
    await blank.goto('about:blank');
    const id = await facet.tabIdOf(blank);
    await groupTabs(facet, [id], groupId);
    await expect.poll(() => facet.api('getTabContainer', id)).toBe(R.id);
    expect(blank.isClosed()).toBe(false);
    expect((await facet.tabInfo(id)).groupId).toBe(groupId);
    await facet.clearLog();
    await go(blank, at('a.localhost', '/whoami?t=blank'));
    await expect(blank.locator('#cookies')).toHaveText('who=reddit');
    expect(await cookiesFor(facet, '/whoami?t=blank')).toEqual(['who=reddit']);
    expect((await guardLog(facet)).join('\n')).toMatch(new RegExp(`tab ${id} no container -> ${R.id} \\(moved into the group\\): assigned to it in place`));
  });

  test('a tab Chrome creates inside the group (“New tab to the right”) is in the container before anything is typed: its first request has the container’s cookie, never the real profile’s', async ({ facet }) => {
    const R = await facet.container('Reddit');
    const one = await containerTab(facet, R.name, 'who=reddit');
    const two = await facet.openIn(R.name, at('a.localhost', '/whoami?t=two'));
    const twoId = await facet.tabIdOf(two);
    await expect.poll(async () => (await facet.tabInfo(twoId)).groupId).toBe(one.groupId);
    const real = await facet.plain(setCookie('a.localhost', 'who=real')); // the real profile is logged in too
    await real.close();
    await facet.clearLog();

    // New tab page between two tabs of the group: Chrome puts it into the group and reports no group change for it.
    const opened = facet.ctx.waitForEvent('page');
    const created = await chromeNewTabInGroup(facet, one.tabId);
    expect(created.groupId).toBe(one.groupId);
    const ntp = await opened;
    facet.adopt(ntp);
    // A person needs far longer than this to type an address.
    await expect.poll(() => facet.api('getTabContainer', created.id), { timeout: 1_000 }).toBe(R.id);
    await go(ntp, at('a.localhost', '/whoami?t=ntp'));
    await expect(ntp.locator('#cookies')).toHaveText('who=reddit');
    await go(ntp, at('a.localhost', '/whoami?t=ntp2'));
    expect(await cookiesFor(facet, '/whoami?t=ntp')).toEqual(['who=reddit']);
    expect(await cookiesFor(facet, '/whoami?t=ntp2')).toEqual(['who=reddit']);
    expect((await facet.tabInfo(created.id)).groupId).toBe(one.groupId);
    expect((await facet.realCookies(at('a.localhost'))).map((c) => c.value)).toEqual(['real']);
    expect((await guardLog(facet)).join('\n')).toContain(`tab ${created.id} no container -> ${R.id} (created in the group): assigned to it in place`);

    // A website Chrome opens inside the group (an address opened next to a grouped tab): its request is out before any
    // extension hears of the tab (limits.md), so it is reopened in the container: the tab that stays is in it.
    const adopt = (p: Page) => facet.adopt(p); // the tab Chrome made and the one that replaces it
    facet.ctx.on('page', adopt);
    const born = await chromeNewTabInGroup(facet, one.tabId, at('a.localhost', '/whoami?t=url'));
    expect(born.groupId).toBe(one.groupId);
    await expect.poll(async () => (await facet.inWorker(async (id: number) => (globalThis as any).chrome.tabs.get(id).then(() => true, () => false), born.id))).toBe(false);
    await expect
      .poll(async () => (await facet.inWorker(async (g: number) => (await (globalThis as any).chrome.tabs.query({ groupId: g })).map((t: { id: number }) => t.id) as number[], one.groupId)).length)
      .toBe(4);
    const inGroup = await facet.inWorker(async (g: number) => (await (globalThis as any).chrome.tabs.query({ groupId: g })).map((t: { id: number }) => t.id) as number[], one.groupId);
    for (const id of inGroup) expect(await facet.api('getTabContainer', id)).toBe(R.id);
    await expect.poll(async () => (await cookiesFor(facet, '/whoami?t=url')).at(-1)).toBe('who=reddit');
    expect((await guardLog(facet)).join('\n')).toContain(`tab ${born.id} no container -> ${R.id} (created in the group): reopened in it`);
    facet.ctx.off('page', adopt);
  });

  test('a loaded, logged-in ordinary tab dragged into the group at once is logged out there: the container has no login for the site', async ({ facet }) => {
    const R = await facet.container('Reddit');
    const { groupId } = await containerTab(facet, R.name, 'who=reddit'); // the container knows a.localhost only
    const plain = await facet.plain(setCookie('b.localhost', 'session=real-user'));
    await go(plain, at('b.localhost', '/whoami?t=login'));
    await expect(plain.locator('#cookies')).toHaveText('session=real-user');
    const plainId = await facet.tabIdOf(plain);
    await facet.clearLog();

    // Dragged right after it loaded (the old one-second guard ignored a tab this young).
    const next = await followReplacement(facet, plain, () => groupTabs(facet, [plainId], groupId));
    await expect(next.locator('#cookies')).toHaveText('');
    const nextId = await facet.tabIdOf(next);
    expect(await facet.api('getTabContainer', nextId)).toBe(R.id);
    await expect.poll(async () => (await facet.tabInfo(nextId)).groupId).toBe(groupId);
    // A refresh is still logged out; nothing went out with the real login.
    await next.reload();
    await expect(next.locator('#cookies')).toHaveText('');
    const sent = await cookiesFor(facet, '/whoami?t=login');
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(sent.every((c) => c === '')).toBe(true);
    expect((await facet.realCookies(at('b.localhost'))).map((c) => c.value)).toEqual(['real-user']);
    expect((await guardLog(facet)).join('\n')).toContain(`tab ${plainId} no container -> ${R.id} (moved into the group): reopened in it as tab ${nextId}`);
  });

  test('the sweep fixes an ordinary tab already sitting in a container’s group (no tab event at all), and keeps checking while such groups exist', async ({ facet }) => {
    const R = await facet.container('Reddit');
    const { groupId } = await containerTab(facet, R.name, 'who=reddit');
    const plain = await facet.plain(setCookie('a.localhost', 'who=real'));
    await go(plain, at('a.localhost', '/whoami?t=sweep'));
    await expect(plain.locator('#cookies')).toHaveText('who=real');
    const plainId = await facet.tabIdOf(plain);
    // The ordinary tab sits in a group of the user's, which then gets the container's title, invisible marker included
    // (as if the tab had got into the container's group past every handler): no tab changes its group.
    const userGroup = await groupTabs(facet, [plainId]);
    await sleep(1_500);
    expect(await facet.api('getTabContainer', plainId)).toBeNull();
    await facet.clearLog();
    const next = await followReplacement(facet, plain, () =>
      facet.inWorker(async ([from, to]: [number, number]) => {
        const c = (globalThis as any).chrome;
        const g = await c.tabGroups.get(from);
        await c.tabGroups.update(to, { title: g.title, color: g.color });
      }, [groupId, userGroup] as [number, number]),
    );
    await expect(next.locator('#cookies')).toHaveText('who=reddit');
    const nextId = await facet.tabIdOf(next);
    expect(await facet.api('getTabContainer', nextId)).toBe(R.id);
    expect(await cookiesFor(facet, '/whoami?t=sweep')).toEqual(['who=reddit']);
    expect((await guardLog(facet)).join('\n')).toContain(`tab ${plainId} no container -> ${R.id} (sweep: tabs or groups changed): reopened in it as tab ${nextId}`);
    // The periodic check runs while a group stands for a container.
    expect(await facet.inWorker(async () => !!(await (globalThis as any).chrome.alarms.get('splitsession-group-sweep')), null)).toBe(true);
  });

  test('a tab moved into a group by SplitSession itself (re-group, a new tab) is not touched', async ({ facet }) => {
    const R = await facet.container('Reddit');
    const one = await containerTab(facet, R.name, 'who=reddit');
    const two = await facet.openIn(R.name, at('a.localhost', '/whoami?t=two'));
    const twoId = await facet.tabIdOf(two);
    await expect.poll(async () => (await facet.tabInfo(twoId)).groupId).toBe(one.groupId);
    await facet.inWorker(async (id: number) => (globalThis as any).chrome.tabs.ungroup(id), twoId);
    await facet.api('regroupTabs');
    await expect.poll(async () => (await facet.tabInfo(twoId)).groupId).toBe(one.groupId);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(two.isClosed()).toBe(false);
    expect(await facet.api('getTabContainer', twoId)).toBe(R.id);
    expect(await tabCount(facet, R.id)).toBe(2);
  });

  test('a tab SplitSession itself opens (a domain rule) inside another container’s group stays in its container when the group call is refused for longer than five seconds (a long drag)', async ({ facet }) => {
    const A = await facet.container('Alpha');
    const B = await facet.container('Beta');
    const a = await containerTab(facet, A.name, 'who=alice');
    const b = await containerTab(facet, B.name, 'who=bob');
    // The replacement is created at the old tab's index: only inside the group (not at its edge) Chrome puts it into the group.
    const b2 = await facet.openIn(B.name, at('a.localhost', '/whoami?t=b2'));
    await expect.poll(async () => (await facet.tabInfo(await facet.tabIdOf(b2))).groupId).toBe(b.groupId);
    await facet.api('setDomainRule', { domain: 'c.localhost', action: 'always', containerId: A.id });
    // The user holds a dragged tab for 6.5 s: Chrome refuses every tab-group edit until then.
    await facet.inWorker(async (ms: number) => {
      const tabs = (globalThis as any).chrome.tabs;
      const real = tabs.group.bind(tabs);
      const until = Date.now() + ms;
      tabs.group = (...args: unknown[]) => (Date.now() < until ? Promise.reject(new Error('Tabs cannot be edited right now (user may be dragging a tab).')) : real(...args));
    }, 6_500);
    await facet.clearLog();

    // A tab of group B goes to a site whose rule says Alpha: the replacement is made at its place, so Chrome puts it into group B.
    const next = await followReplacement(facet, b2, () => go(b2, at('c.localhost', '/whoami?t=held')));
    const nextId = await facet.tabIdOf(next);
    expect(await facet.api('getTabContainer', nextId)).toBe(A.id);
    await expect.poll(async () => (await facet.tabInfo(nextId)).groupId, { timeout: 15_000 }).toBe(a.groupId);
    await sleep(1_500); // a sweep or two must not undo it
    expect(await facet.api('getTabContainer', nextId)).toBe(A.id);
    expect((await facet.tabInfo(nextId)).groupId).toBe(a.groupId);
    const log = (await guardLog(facet)).filter((m) => m.startsWith(`group guard: tab ${nextId} `)).join('\n');
    expect(log).not.toContain('reopened in it');
    expect(log).toContain(`tab ${nextId} ${A.id} -> ${B.id}`);
    expect(log).toContain("SplitSession's own tab, moved to the group of " + A.id);
  });

  test('a container group with 15 tabs that have loaded nothing gets them all assigned at once (assignments in place are not rate-limited)', async ({ facet }) => {
    const R = await facet.container('Reddit');
    const { groupId } = await containerTab(facet, R.name, 'who=reddit');
    const ids = await facet.inWorker(async () => {
      const c = (globalThis as any).chrome;
      const made: number[] = [];
      for (let i = 0; i < 15; i++) made.push((await c.tabs.create({ active: false })).id as number); // new tab pages
      return made;
    }, null);
    await groupTabs(facet, ids, groupId);
    await expect
      .poll(async () => (await Promise.all(ids.map((id) => facet.api('getTabContainer', id)))).filter((c) => c === R.id).length, { timeout: 2_000 })
      .toBe(15);
    expect((await guardLog(facet)).join('\n')).not.toContain('more than');
  });

  test('15 loaded ordinary tabs moved into a container group all end up in the container within 25 s, without waiting for the 30 s alarm', async ({ facet }) => {
    test.setTimeout(100_000);
    const R = await facet.container('Reddit');
    const { groupId } = await containerTab(facet, R.name, 'who=reddit');
    const ids: number[] = [];
    for (let i = 0; i < 15; i++) {
      const page = await facet.plain(at('a.localhost', `/whoami?t=many${i}`));
      ids.push(await facet.tabIdOf(page));
    }
    const adopt = (p: Page) => facet.adopt(p);
    facet.ctx.on('page', adopt); // the pages that replace them
    // Only the guard's own sweep after the rate window may finish the job: take the periodic alarm away.
    await facet.inWorker(async () => (globalThis as any).chrome.alarms.clear('splitsession-group-sweep'), null);
    await groupTabs(facet, ids, groupId);
    const inGroup = () => facet.inWorker(async (g: number) => (await (globalThis as any).chrome.tabs.query({ groupId: g })).map((t: { id: number }) => t.id) as number[], groupId);
    await expect
      .poll(async () => (await Promise.all((await inGroup()).map((id) => facet.api('getTabContainer', id)))).filter((c) => c === R.id).length, { timeout: 25_000, intervals: [500] })
      .toBe(16);
    expect((await inGroup()).length).toBe(16);
    expect((await guardLog(facet)).join('\n')).toContain('the rest wait for a sweep just after the window');
    facet.ctx.off('page', adopt);
  });
});
