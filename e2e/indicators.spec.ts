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

  test('the toolbar badge is a dot in the container colour (no letters), comes back after navigation and is empty on plain tabs', async ({ facet }) => {
    const W = await facet.container('Work');
    const id = (await facet.api<{ id: string }>('updateContainer', W.id, { color: 'orange' })).id;
    expect(id).toBe(W.id);
    const page = await facet.openIn(W.name, at('a.localhost', '/whoami'));
    const tabId = await facet.tabIdOf(page);
    await expect.poll(async () => (await facet.tabInfo(tabId)).badge).toBe(' ');
    expect((await facet.tabInfo(tabId)).badgeColor.slice(0, 3)).toEqual([0xff, 0x9f, 0x00]);

    await go(page, at('b.localhost', '/whoami')); // navigation resets tab-specific action state
    await expect.poll(async () => (await facet.tabInfo(tabId)).badge).toBe(' ');

    await facet.api('updateContainer', W.id, { color: 'purple' });
    await expect.poll(async () => (await facet.tabInfo(tabId)).badgeColor.slice(0, 3)).toEqual([0xaf, 0x51, 0xf5]);

    const plain = await facet.plain(at('a.localhost', '/whoami'));
    expect((await facet.tabInfo(await facet.tabIdOf(plain))).badge).toBe('');

    await facet.api('assignTab', tabId, null);
    await expect.poll(async () => (await facet.tabInfo(tabId)).badge).toBe('');
  });

  test('one tab group per container and window, titled and coloured; taking a tab out of a group never changes its container', async ({ facet }) => {
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
    expect(await facet.groupInfo(ga1)).toMatchObject({ title: `⧉ ${A.name}`, color: 'red', marker: A.id });
    expect(await facet.groupInfo(gb1)).toMatchObject({ title: `⧉ ${B.name}`, color: 'cyan' });

    // Rename and recolour follow.
    await facet.api('updateContainer', A.id, { name: `${A.name}-2`, color: 'green' });
    await expect.poll(() => facet.groupInfo(ga1)).toMatchObject({ title: `⧉ ${A.name}-2`, color: 'green' });

    // Taking a tab out of its group, or into a group of the user's own, leaves its container alone, and the tab is not
    // pulled back. (A tab dragged into another container's group is reopened there: e2e/group-drag.spec.ts.)
    await facet.inWorker(async (id: number) => (globalThis as any).chrome.tabs.ungroup(id), ta1);
    expect((await facet.tabInfo(ta1)).groupId).toBe(-1);
    expect(await facet.api('getTabContainer', ta1)).toBe(A.id);
    const mine = await facet.inWorker(async (id: number) => {
      const c = (globalThis as any).chrome;
      const group = await c.tabs.group({ tabIds: [id] });
      await c.tabGroups.update(group, { title: 'Mine' });
      return group as number;
    }, ta2);
    expect((await facet.tabInfo(ta2)).groupId).toBe(mine); // A's tab sits in the user's own group now
    expect(await facet.api('getTabContainer', ta2)).toBe(A.id);
    expect(await facet.api('getTabContainer', tb1)).toBe(B.id);
    await settle();
    expect((await facet.tabInfo(ta1)).groupId).toBe(-1);
    expect((await facet.tabInfo(ta2)).groupId).toBe(mine);
    expect(await facet.api('getTabContainer', ta2)).toBe(A.id);

    // Re-group puts everything back where it belongs.
    await facet.api('regroupTabs');
    await expect.poll(async () => (await facet.tabInfo(ta1)).groupId).toBeGreaterThanOrEqual(0);
    const regrouped = (await facet.tabInfo(ta1)).groupId;
    await expect.poll(async () => (await facet.tabInfo(ta2)).groupId).toBe(regrouped);
    expect(await facet.groupInfo(regrouped)).toMatchObject({ title: `⧉ ${A.name}-2` });

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

/** SplitSession's invisible group marker for a container ID (the same encoding as `src/core/restore.ts`). */
const markerOf = (id: string) => {
  const digits = ['\u200b', '\u200c', '\u200d', '\u2060'];
  let out = '\u2063';
  for (const ch of id) {
    const n = '0123456789abcdefghijklmnopqrstuvwxyz'.indexOf(ch);
    out += digits[(n >> 4) & 3]! + digits[(n >> 2) & 3]! + digits[n & 3]!;
  }
  return out + '\u2063';
};

test.describe('tab groups: the ⧉ glyph and two-way sync with Chrome’s group editor', () => {
  const unique = (label: string) => `${label}-${Date.now().toString(36)}`;
  // The profile is shared by the specs: containers made here are removed (other specs count and list containers).
  const made: string[] = [];
  test.afterEach(async ({ facet }) => {
    for (const id of made.splice(0)) await facet.api('deleteContainer', id).catch(() => {});
  });
  const create = async (facet: import('./fixtures').Facet, name: string, color: string) => {
    const c = await facet.api<{ id: string; name: string }>('createContainer', { name, color });
    made.push(c.id);
    return c;
  };
  const groupOf = async (facet: import('./fixtures').Facet, tabId: number) => {
    await expect.poll(async () => (await facet.tabInfo(tabId)).groupId).toBeGreaterThanOrEqual(0);
    return (await facet.tabInfo(tabId)).groupId;
  };
  const editGroup = (facet: import('./fixtures').Facet, groupId: number, props: { title?: string; color?: string }) =>
    facet.inWorker(async ([id, p]: [number, { title?: string; color?: string }]) => (globalThis as any).chrome.tabGroups.update(id, p), [groupId, props] as [number, { title?: string; color?: string }]);
  const containerNow = async (facet: import('./fixtures').Facet, id: string) =>
    (await facet.api<Array<{ id: string; name: string; color: string }>>('listContainers')).find((c) => c.id === id)!;

  test('a rename and a recolour from Chrome’s group menu change the container and its groups in every window; deleting the glyph or the marker puts it back', async ({ facet }) => {
    const A = await create(facet, unique('Sync'), 'blue');
    const page = await facet.openIn(A.name, at('a.localhost', '/whoami'));
    const tabId = await facet.tabIdOf(page);
    const group = await groupOf(facet, tabId);
    expect((await facet.groupInfo(group))!.title).toBe(`⧉ ${A.name}`);

    // Another window with a tab of the same container: its own group.
    const other = await facet.inWorker(async ([url]: [string]) => {
      const c = (globalThis as any).chrome;
      const w = await c.windows.create({ url: 'about:blank' });
      return w.id as number;
    }, [at('a.localhost', '/whoami')] as [string]);
    const second = await facet.inWorker(async ([id, win]: [string, number]) => {
      const c = (globalThis as any).chrome;
      const tab = await c.tabs.create({ windowId: win, url: 'about:blank' });
      return tab.id as number;
    }, [A.id, other] as [string, number]);
    await facet.api('assignTab', second, A.id);
    const group2 = await groupOf(facet, second);
    expect(group2).not.toBe(group);

    const name = unique('Zed');
    await editGroup(facet, group, { title: `⧉ ${name}`, color: 'red' });
    await expect.poll(async () => (await containerNow(facet, A.id)).name).toBe(name);
    expect((await containerNow(facet, A.id)).color).toBe('red');
    await expect.poll(() => facet.groupInfo(group2)).toMatchObject({ title: `⧉ ${name}`, color: 'red', marker: A.id });
    await expect.poll(() => facet.groupInfo(group)).toMatchObject({ title: `⧉ ${name}`, color: 'red', marker: A.id });

    // Glyph and marker deleted (a plain name typed over the title): the same name, glyph and marker back.
    await editGroup(facet, group, { title: name });
    await expect.poll(() => facet.groupInfo(group)).toMatchObject({ title: `⧉ ${name}`, marker: A.id });
    expect((await containerNow(facet, A.id)).name).toBe(name);

    // A name that is empty or another container's: refused, the group shows the container's name again.
    const B = await create(facet, unique('Other'), 'green');
    for (const title of ['⧉ ', `⧉ ${B.name}`]) {
      await editGroup(facet, group, { title });
      await expect.poll(() => facet.groupInfo(group)).toMatchObject({ title: `⧉ ${name}`, marker: A.id });
      expect((await containerNow(facet, A.id)).name).toBe(name);
    }
    // Collapsing is not a rename.
    await editGroup(facet, group, { collapsed: true } as never);
    await settle();
    expect((await containerNow(facet, A.id)).name).toBe(name);
  });

  test('a user’s own group titled “⧉ fake” (no marker) decides nothing: its plain tab stays plain, no container appears', async ({ facet }) => {
    const before = (await facet.api<unknown[]>('listContainers')).length;
    const plain = await facet.plain(at('a.localhost', '/whoami?t=fake'));
    const plainId = await facet.tabIdOf(plain);
    const group = await facet.inWorker(async (id: number) => {
      const c = (globalThis as any).chrome;
      const g = await c.tabs.group({ tabIds: [id] });
      await c.tabGroups.update(g, { title: '⧉ fake', color: 'red' });
      return g as number;
    }, plainId);
    await new Promise((resolve) => setTimeout(resolve, 2_500)); // the guard's sweep and the sync's pause have both run
    expect(await facet.api('getTabContainer', plainId)).toBeNull();
    expect((await facet.tabInfo(plainId)).groupId).toBe(group);
    expect(plain.isClosed()).toBe(false);
    expect(await facet.inWorker(async (id: number) => (await (globalThis as any).chrome.tabGroups.get(id)).title as string, group)).toBe('⧉ fake');
    expect((await facet.api<unknown[]>('listContainers')).length).toBe(before);
  });

  test('a group with an earlier version’s title (name + marker, no glyph) is recognised and rewritten with the glyph', async ({ facet }) => {
    const A = await create(facet, unique('Legacy'), 'purple');
    const tabId = await facet.inWorker(async () => (await (globalThis as any).chrome.tabs.create({ url: 'about:blank', active: false })).id as number, null);
    const group = await facet.inWorker(
      async ([id, title]: [number, string]) => {
        const c = (globalThis as any).chrome;
        const g = await c.tabs.group({ tabIds: [id] });
        await c.tabGroups.update(g, { title, color: 'purple' });
        return g as number;
      },
      [tabId, A.name + markerOf(A.id)] as [number, string],
    );
    // The guard recognises the marker (the empty tab joins the container), and the title is migrated.
    await expect.poll(() => facet.groupInfo(group), { timeout: 10_000 }).toMatchObject({ title: `⧉ ${A.name}`, marker: A.id });
    await expect.poll(() => facet.api('getTabContainer', tabId)).toBe(A.id);
  });
});

/** Gives queued background work a moment (there is no event to wait for when nothing is supposed to happen). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 400));
