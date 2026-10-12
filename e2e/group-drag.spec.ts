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

/** A person cannot drag a tab within a second of it appearing, and SplitSession ignores a group change that early (a new tab joining its opener's group). */
const aged = () => new Promise((resolve) => setTimeout(resolve, 1200));

const groupTabs = (facet: Facet, tabIds: number[], groupId?: number) =>
  facet.inWorker(async ([ids, group]: [number[], number | undefined]) => (globalThis as any).chrome.tabs.group({ tabIds: ids, ...(group !== undefined ? { groupId: group } : {}) }) as Promise<number>, [tabIds, groupId] as [number[], number | undefined]);

const tabCount = async (facet: Facet, containerId: string) => (await facet.api<Array<{ containerId: string }>>('listTabs')).filter((t) => t.containerId === containerId).length;

test.describe('dragging a tab into a SplitSession tab group', () => {
  test('an ordinary tab moved into a container’s group is reopened in that container: its first request has the container’s cookies, never the real profile’s', async ({ facet }) => {
    const R = await facet.container('Reddit');
    const { groupId } = await containerTab(facet, R.name, 'who=reddit');
    const plain = await facet.plain(setCookie('a.localhost', 'who=real'));
    await go(plain, at('a.localhost', '/whoami?t=drag'));
    await expect(plain.locator('#cookies')).toHaveText('who=real');
    const plainId = await facet.tabIdOf(plain);
    await facet.clearLog();
    await aged();

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
    await aged();

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

  test('pages that are not websites are left where they were put', async ({ facet }) => {
    const R = await facet.container('Reddit');
    const { groupId } = await containerTab(facet, R.name, 'who=reddit');
    const blank = await facet.ctx.newPage();
    facet.adopt(blank);
    await blank.goto('about:blank');
    const id = await facet.tabIdOf(blank);
    await aged();
    await groupTabs(facet, [id], groupId);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(blank.isClosed()).toBe(false);
    expect((await facet.tabInfo(id)).groupId).toBe(groupId);
    expect(await facet.api('getTabContainer', id)).toBeNull();
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
});
