import { at, expect, go, test } from './fixtures';

const titleOf = (page: import('@playwright/test').Page) => page.evaluate(() => document.title);

test.describe('indicators: title prefix, badge, tab groups', () => {
  test('the title is prefixed with [name], once, and survives every way a page can change it', async ({ facet }) => {
    const W = await facet.container('Work');
    const page = await facet.openIn(W.name, at('a.localhost', '/spa'));
    const prefix = `[${W.name}] `;
    await expect.poll(() => titleOf(page)).toBe(`${prefix}Inbox`);

    await page.click('#t-prop');
    await expect.poll(() => titleOf(page)).toBe(`${prefix}Inbox (3)`);
    await page.click('#t-text');
    await expect.poll(() => titleOf(page)).toBe(`${prefix}Settings`);
    await page.click('#t-replace');
    await expect.poll(() => titleOf(page)).toBe(`${prefix}Replaced`);
    // The page reads the (already prefixed) title and appends to it: still one prefix.
    await page.click('#t-append');
    await expect.poll(() => titleOf(page)).toBe(`${prefix}Replaced !`);
    expect((await titleOf(page)).split(prefix).length - 1).toBe(1);

    // Chrome's own view of the tab (what tab lists and agents see).
    const info = await facet.tabInfo(await facet.tabIdOf(page));
    expect(info.title).toContain(`${prefix}Replaced`);

    // A document without a title that gets one late.
    const late = await facet.openIn(W.name, at('a.localhost', '/late-title'));
    await expect.poll(() => titleOf(late)).toBe(`${prefix}Late title`);
  });

  test('plain tabs keep their title, a rename follows, and the setting switches the prefix off and on live', async ({ facet }) => {
    const W = await facet.container('Work');
    const plain = await facet.plain(at('a.localhost', '/spa'));
    expect(await titleOf(plain)).toBe('Inbox');
    const page = await facet.openIn(W.name, at('a.localhost', '/spa'));
    await expect.poll(() => titleOf(page)).toBe(`[${W.name}] Inbox`);

    const renamed = `${W.name}-r`;
    await facet.api('renameContainer', W.id, renamed);
    await expect.poll(() => titleOf(page)).toBe(`[${renamed}] Inbox`);

    await facet.api('updateSettings', { titlePrefix: false });
    await expect.poll(() => titleOf(page)).toBe('Inbox');
    await page.click('#t-prop'); // a page change while the prefix is off stays unprefixed
    await expect.poll(() => titleOf(page)).toBe('Inbox (3)');
    await facet.api('updateSettings', { titlePrefix: true });
    await expect.poll(() => titleOf(page)).toBe(`[${renamed}] Inbox (3)`);
    expect(await titleOf(plain)).toBe('Inbox');
  });

  test('the toolbar badge shows the container, comes back after navigation and is empty on plain tabs', async ({ facet }) => {
    const W = await facet.container('Work');
    const id = (await facet.api<{ id: string }>('updateContainer', W.id, { color: 'orange' })).id;
    expect(id).toBe(W.id);
    const page = await facet.openIn(W.name, at('a.localhost', '/whoami'));
    const tabId = await facet.tabIdOf(page);
    await expect.poll(async () => (await facet.tabInfo(tabId)).badge).toBe('Wo');
    expect((await facet.tabInfo(tabId)).badgeColor.slice(0, 3)).toEqual([0xff, 0x9f, 0x00]);

    await go(page, at('b.localhost', '/whoami')); // navigation resets tab-specific action state
    await expect.poll(async () => (await facet.tabInfo(tabId)).badge).toBe('Wo');

    await facet.api('updateContainer', W.id, { color: 'purple' });
    await expect.poll(async () => (await facet.tabInfo(tabId)).badgeColor.slice(0, 3)).toEqual([0xaf, 0x51, 0xf5]);

    const plain = await facet.plain(at('a.localhost', '/whoami'));
    expect((await facet.tabInfo(await facet.tabIdOf(plain))).badge).toBe('');

    await facet.api('assignTab', tabId, null);
    await expect.poll(async () => (await facet.tabInfo(tabId)).badge).toBe('');
  });

  test('one tab group per container and window, titled and coloured; dragging tabs around never changes a container', async ({ facet }) => {
    const A = await facet.api<{ id: string; name: string }>('createContainer', { name: `Alpha-${Date.now().toString(36)}`, color: 'red' });
    const B = await facet.api<{ id: string; name: string }>('createContainer', { name: `Beta-${Date.now().toString(36)}`, color: 'turquoise' });
    const a1 = await facet.openIn(A.name, at('a.localhost', '/whoami'));
    const a2 = await facet.openIn(A.name, at('b.localhost', '/whoami'));
    const b1 = await facet.openIn(B.name, at('a.localhost', '/whoami'));
    const plain = await facet.plain(at('cdn.localhost', '/blank'));
    const [ta1, ta2, tb1, tp] = [await facet.tabIdOf(a1), await facet.tabIdOf(a2), await facet.tabIdOf(b1), await facet.tabIdOf(plain)];

    await expect.poll(async () => (await facet.tabInfo(ta1)).groupId).toBeGreaterThanOrEqual(0);
    await expect.poll(async () => (await facet.tabInfo(ta2)).groupId).toBeGreaterThanOrEqual(0);
    await expect.poll(async () => (await facet.tabInfo(tb1)).groupId).toBeGreaterThanOrEqual(0);
    const [ga1, ga2, gb1, gp] = [(await facet.tabInfo(ta1)).groupId, (await facet.tabInfo(ta2)).groupId, (await facet.tabInfo(tb1)).groupId, (await facet.tabInfo(tp)).groupId];
    expect(ga1).toBe(ga2);
    expect(gb1).not.toBe(ga1);
    expect(gp).toBe(-1);
    expect(await facet.groupInfo(ga1)).toMatchObject({ title: A.name, color: 'red' });
    expect(await facet.groupInfo(gb1)).toMatchObject({ title: B.name, color: 'cyan' });

    // Rename and recolour follow.
    await facet.api('updateContainer', A.id, { name: `${A.name}-2`, color: 'green' });
    await expect.poll(() => facet.groupInfo(ga1)).toMatchObject({ title: `${A.name}-2`, color: 'green' });

    // The group is a view: taking a tab out of it, or into another group, leaves its container alone,
    // and the tab is not pulled back.
    await facet.inWorker(async (id: number) => (globalThis as any).chrome.tabs.ungroup(id), ta1);
    expect((await facet.tabInfo(ta1)).groupId).toBe(-1);
    expect(await facet.api('getTabContainer', ta1)).toBe(A.id);
    await facet.inWorker(async (ids: number[]) => (globalThis as any).chrome.tabs.group({ tabIds: [ids[0]], groupId: ids[1] }), [ta2, gb1]);
    expect((await facet.tabInfo(ta2)).groupId).toBe(gb1); // A's tab sits in B's group now
    expect(await facet.api('getTabContainer', ta2)).toBe(A.id);
    expect(await facet.api('getTabContainer', tb1)).toBe(B.id);
    await settle();
    expect((await facet.tabInfo(ta1)).groupId).toBe(-1);
    expect((await facet.tabInfo(ta2)).groupId).toBe(gb1);

    // Re-group puts everything back where it belongs.
    await facet.api('regroupTabs');
    await expect.poll(async () => (await facet.tabInfo(ta1)).groupId).toBeGreaterThanOrEqual(0);
    const regrouped = (await facet.tabInfo(ta1)).groupId;
    await expect.poll(async () => (await facet.tabInfo(ta2)).groupId).toBe(regrouped);
    expect(await facet.groupInfo(regrouped)).toMatchObject({ title: `${A.name}-2` });

    // Switching the setting off ungroups; on groups again.
    await facet.api('updateSettings', { tabGroups: false });
    await expect.poll(async () => (await facet.tabInfo(ta1)).groupId).toBe(-1);
    await expect.poll(async () => (await facet.tabInfo(tb1)).groupId).toBe(-1);
    const c = await facet.openIn(B.name, at('b.localhost', '/whoami'));
    await settle();
    expect((await facet.tabInfo(await facet.tabIdOf(c))).groupId).toBe(-1); // off means off
    await facet.api('updateSettings', { tabGroups: true });
    await expect.poll(async () => (await facet.tabInfo(tb1)).groupId).toBeGreaterThanOrEqual(0);
    expect(await facet.api('getTabContainer', ta1)).toBe(A.id);
  });
});

/** Gives queued background work a moment (there is no event to wait for when nothing is supposed to happen). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 400));
