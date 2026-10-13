import { describe, expect, it } from 'vitest';
import { groupTitle, type Container, type Settings } from '../core';
import { MemoryStorageArea } from '../engine/storage/storage-area';
import { OWNED_GROUPS_KEY, TabGroupProjection, type GroupTab } from './tab-groups';

/** Just enough of chrome.tabs / chrome.tabGroups: groups live in windows and vanish when empty. */
class FakeChrome {
  tabs = new Map<number, GroupTab>();
  groups = new Map<number, { id: number; windowId: number; title?: string; color: string }>();
  nextGroup = 100;
  failNextGroupCalls = 0;
  calls: string[] = [];

  addTab(id: number, windowId = 1, extra: Partial<GroupTab> = {}): void {
    this.tabs.set(id, { id, windowId, groupId: -1, pinned: false, ...extra });
  }
  private prune(): void {
    for (const g of [...this.groups.keys()]) if (![...this.tabs.values()].some((t) => t.groupId === g)) this.groups.delete(g);
  }
  api = {
    tabs: {
      get: async (id: number) => {
        const tab = this.tabs.get(id);
        if (!tab) throw new Error('No tab with id');
        return { ...tab };
      },
      group: async ({ tabIds, groupId, createProperties }: { tabIds: number[]; groupId?: number; createProperties?: { windowId: number } }) => {
        this.calls.push(`group ${tabIds.join(',')} ${groupId ?? 'new'}`);
        if (this.failNextGroupCalls > 0) {
          this.failNextGroupCalls--;
          throw new Error('Tabs cannot be edited right now (user may be dragging a tab).');
        }
        let id = groupId;
        if (id === undefined) {
          id = this.nextGroup++;
          this.groups.set(id, { id, windowId: createProperties?.windowId ?? this.tabs.get(tabIds[0]!)!.windowId, color: 'grey' });
        }
        for (const t of tabIds) this.tabs.get(t)!.groupId = id;
        this.prune();
        return id;
      },
      ungroup: async (ids: number[]) => {
        this.calls.push(`ungroup ${ids.join(',')}`);
        for (const t of ids) this.tabs.get(t)!.groupId = -1;
        this.prune();
      },
      query: async ({ groupId }: { groupId?: number }) => [...this.tabs.values()].filter((t) => t.groupId === groupId).map((t) => ({ ...t })),
    },
    tabGroups: {
      get: async (id: number) => {
        const g = this.groups.get(id);
        if (!g) throw new Error('No group with id');
        return { ...g };
      },
      update: async (id: number, props: { title?: string; color?: string }) => {
        const g = this.groups.get(id);
        if (!g) throw new Error('No group with id');
        Object.assign(g, props);
      },
    },
  };
}

const containers = new Map<string, Container>([
  ['work', { id: 'work', name: 'Work', color: 'blue', createdAt: 1 }],
  ['home', { id: 'home', name: 'Home', color: 'turquoise', createdAt: 2 }],
]);

function setup(settings: Partial<Settings> = {}) {
  const chrome = new FakeChrome();
  const book = new Map([...containers].map(([id, c]) => [id, { ...c }]));
  const logs: Array<[string, string]> = [];
  const area = new MemoryStorageArea();
  const assigned: Array<{ tabId: number; containerId: string }> = [];
  const state = { tabGroups: true, titlePrefix: true, strictMode: true, showNameToPages: true, agentBridge: false, agentActivity: true, restoreTabs: true, ...settings };
  const projection = new TabGroupProjection({
    tabs: chrome.api.tabs,
    tabGroups: chrome.api.tabGroups,
    area,
    settings: () => state,
    container: (id) => book.get(id),
    containers: () => [...book.values()],
    updateContainer: async (id, patch) => {
      const c = book.get(id);
      if (!c) throw new Error('no container');
      Object.assign(c, patch);
      void projection.containerUpdated(c); // what the engine's "container-updated" event does
    },
    containerTabs: () => assigned,
    log: (level, message) => void logs.push([level, message]),
    delay: async () => {},
    editSettleMs: 0,
  });
  const assign = async (tabId: number, containerId: string) => {
    assigned.push({ tabId, containerId });
    await projection.tabAssigned(tabId, containerId);
  };
  return { chrome, area, projection, assign, state, assigned, book, logs };
}

describe('TabGroupProjection', () => {
  it('makes one titled, coloured group per container and window, and reuses it', async () => {
    const { chrome, assign, projection } = setup();
    chrome.addTab(1);
    chrome.addTab(2);
    chrome.addTab(3);
    chrome.addTab(4, 2); // another window
    await assign(1, 'work');
    await assign(2, 'work');
    await assign(3, 'home');
    await assign(4, 'work');
    const g = (id: number) => chrome.tabs.get(id)!.groupId;
    expect(g(1)).toBe(g(2));
    expect(g(3)).not.toBe(g(1));
    expect(g(4)).not.toBe(g(1));
    expect(chrome.groups.get(g(1))).toMatchObject({ title: groupTitle('Work', 'work'), color: 'blue', windowId: 1 });
    expect(chrome.groups.get(g(3))).toMatchObject({ title: groupTitle('Home', 'home'), color: 'cyan' });
    expect(chrome.groups.get(g(4))).toMatchObject({ title: groupTitle('Work', 'work'), windowId: 2 });
    expect(chrome.groups.size).toBe(3);
    expect(projection.ownedGroups()).toHaveLength(3);
  });

  it('does nothing while the setting is off, and for pinned or closed tabs', async () => {
    const off = setup({ tabGroups: false });
    off.chrome.addTab(1);
    await off.assign(1, 'work');
    expect(off.chrome.groups.size).toBe(0);

    const on = setup();
    on.chrome.addTab(1, 1, { pinned: true });
    await on.assign(1, 'work');
    await on.assign(99, 'work'); // never existed
    expect(on.chrome.groups.size).toBe(0);
  });

  it('serialises concurrent assignments: two tabs arriving together share one new group', async () => {
    const { chrome, projection } = setup();
    chrome.addTab(1);
    chrome.addTab(2);
    await Promise.all([projection.tabAssigned(1, 'work'), projection.tabAssigned(2, 'work')]);
    expect(chrome.groups.size).toBe(1);
    expect(chrome.tabs.get(1)!.groupId).toBe(chrome.tabs.get(2)!.groupId);
  });

  it('never pulls a tab back: only assignment, re-group and setting changes regroup', async () => {
    const { chrome, assign, projection } = setup();
    chrome.addTab(1);
    chrome.addTab(2);
    await assign(1, 'work');
    await assign(2, 'work');
    await chrome.api.tabs.ungroup([1]); // the user drags it out
    await projection.containerUpdated(containers.get('work')!); // unrelated housekeeping
    await projection.groupRemoved(12345);
    expect(chrome.tabs.get(1)!.groupId).toBe(-1);
    // Explicit re-group puts it back.
    await projection.reconcileAll();
    expect(chrome.tabs.get(1)!.groupId).toBe(chrome.tabs.get(2)!.groupId);
    expect(chrome.groups.size).toBe(1);
  });

  it('a tab the user put in somebody else\'s group stays there until re-group', async () => {
    const { chrome, assign, projection } = setup();
    chrome.addTab(1);
    chrome.addTab(2);
    chrome.addTab(3);
    await assign(1, 'work');
    await assign(2, 'home');
    await chrome.api.tabs.group({ tabIds: [1], groupId: chrome.tabs.get(2)!.groupId }); // Work tab dragged into Home's group
    expect(chrome.tabs.get(1)!.groupId).toBe(chrome.tabs.get(2)!.groupId);
    await assign(3, 'work'); // a new Work tab: gets a Work group (the old one is gone: it was empty)
    expect(chrome.groups.get(chrome.tabs.get(3)!.groupId)).toMatchObject({ title: groupTitle('Work', 'work') });
    expect(chrome.tabs.get(1)!.groupId).toBe(chrome.tabs.get(2)!.groupId);
    await projection.reconcileAll();
    expect(chrome.tabs.get(1)!.groupId).toBe(chrome.tabs.get(3)!.groupId);
  });

  it('renames and recolours the groups of a container', async () => {
    const { chrome, assign, projection } = setup();
    chrome.addTab(1);
    await assign(1, 'work');
    await projection.containerUpdated({ id: 'work', name: 'Job', color: 'red', createdAt: 1 });
    expect(chrome.groups.get(chrome.tabs.get(1)!.groupId)).toMatchObject({ title: groupTitle('Job', 'work'), color: 'red' });
  });

  it('takes a tab that left its container out of our group, but not out of the user\'s', async () => {
    const { chrome, assign, projection } = setup();
    chrome.addTab(1);
    chrome.addTab(2);
    await assign(1, 'work');
    await projection.tabUnassigned(1, 'work');
    expect(chrome.tabs.get(1)!.groupId).toBe(-1);
    const own = await chrome.api.tabs.group({ tabIds: [2] }); // a group the user made
    await projection.tabUnassigned(2, 'work');
    expect(chrome.tabs.get(2)!.groupId).toBe(own);
    await projection.tabUnassigned(404, 'work'); // closed tab: no error
  });

  it('releaseAll ungroups only what it made; reconcileAll groups again', async () => {
    const { chrome, assign, projection, state } = setup();
    chrome.addTab(1);
    chrome.addTab(2);
    chrome.addTab(3);
    await assign(1, 'work');
    await assign(2, 'home');
    const own = await chrome.api.tabs.group({ tabIds: [3] });
    state.tabGroups = false;
    await projection.releaseAll();
    expect(chrome.tabs.get(1)!.groupId).toBe(-1);
    expect(chrome.tabs.get(2)!.groupId).toBe(-1);
    expect(chrome.tabs.get(3)!.groupId).toBe(own);
    expect(projection.ownedGroups()).toEqual([]);
    state.tabGroups = true;
    await projection.reconcileAll();
    expect(chrome.tabs.get(1)!.groupId).toBeGreaterThanOrEqual(0);
    expect(chrome.groups.size).toBe(3);
  });

  it('retries while Chrome refuses edits during a drag, and gives up with a logged failure', async () => {
    const { chrome, projection } = setup();
    chrome.addTab(1);
    chrome.failNextGroupCalls = 3;
    await projection.tabAssigned(1, 'work');
    expect(chrome.tabs.get(1)!.groupId).toBeGreaterThanOrEqual(0);

    chrome.addTab(2);
    chrome.failNextGroupCalls = 99;
    await projection.tabAssigned(2, 'home'); // swallowed by the queue: never rejects
    expect(chrome.tabs.get(2)!.groupId).toBe(-1);
  });

  it('forgets groups that no longer exist and survives a worker restart through storage', async () => {
    const { chrome, area, assign, projection } = setup();
    chrome.addTab(1);
    await assign(1, 'work');
    const groupId = chrome.tabs.get(1)!.groupId;
    expect((await area.get(OWNED_GROUPS_KEY))[OWNED_GROUPS_KEY]).toEqual({ [groupId]: 'work' });

    // "Restart": a new instance over the same storage finds its group again instead of making a second one.
    const again = new TabGroupProjection({
      tabs: chrome.api.tabs,
      tabGroups: chrome.api.tabGroups,
      area,
      settings: () => ({ tabGroups: true, titlePrefix: true, strictMode: true, showNameToPages: true, agentBridge: false, agentActivity: true, restoreTabs: true }),
      container: (id) => containers.get(id),
      containers: () => [...containers.values()],
      updateContainer: async () => {},
      containerTabs: () => [],
      log: () => {},
      delay: async () => {},
    });
    await again.load();
    chrome.addTab(2);
    await again.tabAssigned(2, 'work');
    expect(chrome.tabs.get(2)!.groupId).toBe(groupId);

    // The group disappears (both tabs closed): the next assignment makes a fresh one and the stale entry is dropped.
    chrome.tabs.delete(1);
    chrome.tabs.delete(2);
    chrome.groups.delete(groupId);
    chrome.addTab(3);
    await again.tabAssigned(3, 'work');
    expect(chrome.tabs.get(3)!.groupId).not.toBe(groupId);
    expect(again.ownedGroups().map(([id]) => id)).toEqual([chrome.tabs.get(3)!.groupId]);
    await projection.groupRemoved(chrome.tabs.get(3)!.groupId);
  });

  it('containerDeleted drops its groups from the books', async () => {
    const { chrome, assign, projection } = setup();
    chrome.addTab(1);
    await assign(1, 'work');
    await projection.containerDeleted('work');
    expect(projection.ownedGroups()).toEqual([]);
  });

  it('takes over a group Chrome brought back with the container marker, not a look-alike the user made', async () => {
    const { chrome, assign, projection } = setup();
    // Session restore: a group with Work's marker, unknown to this (fresh) projection, holding tab 1.
    chrome.groups.set(500, { id: 500, windowId: 1, title: groupTitle('Work', 'work'), color: 'blue' });
    chrome.addTab(1, 1, { groupId: 500 });
    chrome.addTab(2);
    await assign(1, 'work');
    await assign(2, 'work');
    expect(chrome.tabs.get(1)!.groupId).toBe(500);
    expect(chrome.tabs.get(2)!.groupId).toBe(500);
    expect(projection.ownedGroups()).toEqual([[500, 'work']]);
    // The user's own group called "Home", without the marker: the tab leaves it for SplitSession's own group.
    chrome.groups.set(600, { id: 600, windowId: 1, title: 'Home', color: 'cyan' });
    chrome.addTab(3, 1, { groupId: 600 });
    await assign(3, 'home');
    expect(chrome.tabs.get(3)!.groupId).not.toBe(600);
    expect(chrome.groups.get(chrome.tabs.get(3)!.groupId)).toMatchObject({ title: groupTitle('Home', 'home') });
  });
  it('tells which container a group stands for from its marker, and takes over a marked group it did not make', async () => {
    const { chrome, projection } = setup();
    chrome.addTab(1);
    chrome.groups.set(50, { id: 50, windowId: 1, title: groupTitle('Work', 'work'), color: 'blue' });
    chrome.groups.set(51, { id: 51, windowId: 1, title: 'Work', color: 'blue' }); // typed by hand: no marker
    chrome.groups.set(52, { id: 52, windowId: 1, title: groupTitle('Gone', 'deleted'), color: 'blue' });
    expect(await projection.containerOfGroup(50)).toBe('work');
    expect(projection.ownedGroups()).toEqual([[50, 'work']]);
    expect(await projection.containerOfGroup(51)).toBeNull();
    expect(await projection.containerOfGroup(52)).toBeNull(); // no such container any more
    expect(await projection.containerOfGroup(404)).toBeNull();
    expect(projection.ownedGroups()).toEqual([[50, 'work']]);
  });

  it("placeOwn reports a refusal that outlasts the retries (a long drag) and then works when asked again; the queue keeps going", async () => {
    const { chrome, projection, assigned } = setup();
    chrome.groups.set(50, { id: 50, windowId: 1, title: groupTitle('Work', 'work'), color: 'blue' });
    chrome.addTab(1, 1, { groupId: 50 });
    chrome.addTab(9, 1, { groupId: 50 });
    assigned.push({ tabId: 1, containerId: 'home' });
    chrome.failNextGroupCalls = 6; // every retry of one call
    await expect(projection.placeOwn(1, 'home')).rejects.toThrow(/dragging/);
    expect(chrome.tabs.get(1)!.groupId).toBe(50);
    await projection.idle();
    await projection.placeOwn(1, 'home');
    expect(chrome.groups.get(chrome.tabs.get(1)!.groupId)).toMatchObject({ title: groupTitle('Home', 'home') });
  });

  it("never leaves a tab in a group that names another container: placeOwn regroups or ungroups, also with groups off", async () => {
    const { chrome, projection, assigned } = setup();
    chrome.groups.set(50, { id: 50, windowId: 1, title: groupTitle('Work', 'work'), color: 'blue' });
    chrome.groups.set(60, { id: 60, windowId: 1, title: 'Mine', color: 'red' });
    chrome.addTab(1, 1, { groupId: 50 });
    chrome.addTab(2, 1, { groupId: 50 });
    chrome.addTab(3, 1, { groupId: 60 });
    chrome.addTab(9, 1, { groupId: 50 });
    // A tab SplitSession opened in Home landed inside Work's group: into Home's group.
    assigned.push({ tabId: 1, containerId: 'home' });
    await projection.placeOwn(1, 'home');
    expect(chrome.groups.get(chrome.tabs.get(1)!.groupId)).toMatchObject({ title: groupTitle('Home', 'home') });
    // A plain one: out of the group. In a group of the user's: left there.
    await projection.placeOwn(2, null);
    expect(chrome.tabs.get(2)!.groupId).toBe(-1);
    await projection.placeOwn(3, null);
    expect(chrome.tabs.get(3)!.groupId).toBe(60);

    const off = setup({ tabGroups: false });
    off.chrome.groups.set(50, { id: 50, windowId: 1, title: groupTitle('Work', 'work'), color: 'blue' });
    off.chrome.addTab(1, 1, { groupId: 50 });
    off.chrome.addTab(2, 1, { groupId: 50 });
    off.chrome.addTab(3, 1, { groupId: 50 });
    off.chrome.addTab(9, 1, { groupId: 50 });
    await off.assign(1, 'home'); // assigned elsewhere (the popup's "Move here"): leaves Work's group
    await off.assign(2, 'work'); // its own container's group: stays
    expect(off.chrome.tabs.get(1)!.groupId).toBe(-1);
    expect(off.chrome.tabs.get(2)!.groupId).toBe(50);
    await off.projection.tabUnassigned(2, 'work'); // left its container: out of the marked group
    expect(off.chrome.tabs.get(2)!.groupId).toBe(-1);
    expect(off.chrome.groups.size).toBe(1);
  });

  describe('two-way sync with Chrome\'s group editor', () => {
    async function twoWindows() {
      const t = setup();
      t.chrome.addTab(1);
      t.chrome.addTab(2, 2);
      t.chrome.addTab(3);
      await t.assign(1, 'work');
      await t.assign(2, 'work');
      await t.assign(3, 'home');
      const gid = (tab: number) => t.chrome.tabs.get(tab)!.groupId;
      const edit = async (tab: number, props: { title?: string; color?: string }) => {
        const id = gid(tab);
        await t.chrome.api.tabGroups.update(id, props);
        await t.projection.groupUpdated({ ...t.chrome.groups.get(id)! });
        await t.projection.idle();
      };
      return { ...t, gid, edit };
    }

    it('titles carry the glyph and the marker', async () => {
      const { chrome, gid } = await twoWindows();
      expect(chrome.groups.get(gid(1))!.title).toMatch(/^⧉ Work/);
    });

    it('a rename in the editor renames the container and every group of it, glyph re-applied', async () => {
      const { chrome, book, gid, edit, logs } = await twoWindows();
      await edit(1, { title: '⧉ Job' });
      expect(book.get('work')!.name).toBe('Job');
      expect(chrome.groups.get(gid(1))!.title).toBe(groupTitle('Job', 'work'));
      expect(chrome.groups.get(gid(2))!.title).toBe(groupTitle('Job', 'work')); // the other window
      expect(logs.some(([l, m]) => l === 'info' && /changed from its tab group/.test(m))).toBe(true);
    });

    it('a name typed without the glyph (and without the marker) is accepted and the glyph and marker come back', async () => {
      const { chrome, book, gid, edit } = await twoWindows();
      await edit(1, { title: '  Job   two ' });
      expect(book.get('work')!.name).toBe('Job two');
      expect(chrome.groups.get(gid(1))!.title).toBe(groupTitle('Job two', 'work'));
    });

    it('deleting only the glyph or only the marker puts it back without touching the name', async () => {
      const { chrome, book, gid, edit } = await twoWindows();
      await edit(1, { title: 'Work' });
      expect(chrome.groups.get(gid(1))!.title).toBe(groupTitle('Work', 'work'));
      await edit(1, { title: '⧉ Work' });
      expect(chrome.groups.get(gid(1))!.title).toBe(groupTitle('Work', 'work'));
      expect(book.get('work')!.name).toBe('Work');
    });

    it('an empty, duplicate or too long name is refused: the group shows the container again, and it is logged', async () => {
      const { chrome, book, gid, edit, logs } = await twoWindows();
      for (const title of ['⧉ ', '', '⧉ home', '⧉ ' + 'x'.repeat(40)]) {
        await edit(1, { title });
        expect(book.get('work')!.name).toBe('Work');
        expect(chrome.groups.get(gid(1))!.title).toBe(groupTitle('Work', 'work'));
      }
      expect(logs.filter(([l, m]) => l === 'warn' && /rename refused/.test(m))).toHaveLength(4);
    });

    it('a recolour maps back to the container colour (cyan -> turquoise); grey is refused', async () => {
      const { chrome, book, gid, edit } = await twoWindows();
      await edit(1, { color: 'cyan' });
      expect(book.get('work')!.color).toBe('turquoise');
      expect(chrome.groups.get(gid(2))!.color).toBe('cyan');
      await edit(1, { color: 'grey' });
      expect(book.get('work')!.color).toBe('turquoise');
      expect(chrome.groups.get(gid(1))!.color).toBe('cyan');
    });

    it('name and colour in one edit; the burst of keystrokes is acted on once, after the pause', async () => {
      const t = setup();
      t.chrome.addTab(1);
      await t.assign(1, 'work');
      const id = t.chrome.tabs.get(1)!.groupId;
      const slow = new TabGroupProjection({
        tabs: t.chrome.api.tabs,
        tabGroups: t.chrome.api.tabGroups,
        area: t.area,
        settings: () => t.state,
        container: (cid) => t.book.get(cid),
        containers: () => [...t.book.values()],
        updateContainer: async (cid, patch) => void Object.assign(t.book.get(cid)!, patch),
        containerTabs: () => [],
        log: () => {},
        delay: async () => {},
        editSettleMs: 20,
      });
      await slow.load();
      const calls: unknown[] = [];
      const real = t.book.get('work')!;
      const done: Array<Promise<void>> = [];
      for (const title of ['⧉ J', '⧉ Jo', '⧉ Job']) {
        t.chrome.groups.get(id)!.title = title;
        t.chrome.groups.get(id)!.color = 'purple';
        done.push(slow.groupUpdated({ id, title, color: 'purple' }));
        calls.push({ ...real });
      }
      expect(real.name).toBe('Work'); // nothing yet: the user is still typing
      await Promise.all(done);
      await slow.idle();
      expect(real.name).toBe('Job');
      expect(real.color).toBe('purple');
    });

    it('ignores its own updates (a rename from the popup), collapsing, groups it does not keep, and a deleted container', async () => {
      const { chrome, book, projection, gid, edit, logs } = await twoWindows();
      // SplitSession's own rename: the echo carries the new state and changes nothing.
      book.get('work')!.name = 'Popup';
      await projection.containerUpdated(book.get('work')!);
      await projection.groupUpdated({ ...chrome.groups.get(gid(1))! });
      await projection.groupUpdated({ ...chrome.groups.get(gid(2))! });
      await projection.idle();
      expect(book.get('work')!.name).toBe('Popup');
      // Collapsing: same title, same colour.
      await edit(1, {});
      expect(book.get('work')!.name).toBe('Popup');
      // A user's group titled like ours is not ours.
      chrome.groups.set(900, { id: 900, windowId: 1, title: '⧉ fake', color: 'red' });
      chrome.addTab(9, 1, { groupId: 900 });
      await projection.groupUpdated({ id: 900, title: '⧉ fake', color: 'red' });
      await projection.idle();
      expect(book.get('work')!.color).toBe('blue');
      expect(logs.filter(([l]) => l === 'warn')).toEqual([]);
      // The container is gone.
      book.delete('home');
      const home = chrome.tabs.get(3)!.groupId;
      chrome.groups.get(home)!.title = '⧉ Whatever';
      await projection.groupUpdated({ id: home, title: '⧉ Whatever', color: 'cyan' });
      await projection.idle();
    });

    it('legacy titles (marker only) are recognised and rewritten with the glyph: when taken over, and at startup', async () => {
      const { chrome, projection, area } = setup();
      const legacy = (name: string, id: string) => name + groupTitle('', id).slice(2);
      chrome.groups.set(50, { id: 50, windowId: 1, title: legacy('Work', 'work'), color: 'blue' });
      chrome.addTab(1, 1, { groupId: 50 });
      expect(await projection.containerOfGroup(50)).toBe('work');
      await projection.idle();
      expect(chrome.groups.get(50)!.title).toBe(groupTitle('Work', 'work'));

      chrome.groups.set(51, { id: 51, windowId: 1, title: legacy('Old name', 'home'), color: 'red' });
      chrome.groups.set(52, { id: 52, windowId: 1, title: '⧉ fake', color: 'red' });
      chrome.groups.set(53, { id: 53, windowId: 1, title: 'Plain', color: 'red' });
      chrome.addTab(2, 1, { groupId: 51 });
      chrome.addTab(3, 1, { groupId: 52 });
      chrome.addTab(4, 1, { groupId: 53 });
      const startup = new TabGroupProjection({
        tabs: chrome.api.tabs,
        tabGroups: { ...chrome.api.tabGroups, query: async () => [...chrome.groups.values()] },
        area,
        settings: () => ({ tabGroups: true, titlePrefix: true, strictMode: true, showNameToPages: true, agentBridge: false, agentActivity: true, restoreTabs: true }),
        container: (id) => containers.get(id),
        containers: () => [...containers.values()],
        updateContainer: async () => {},
        containerTabs: () => [],
        log: () => {},
        delay: async () => {},
      });
      await startup.load();
      await startup.adoptExisting();
      // The container is the truth: name and colour of the container, glyph included.
      expect(chrome.groups.get(51)).toMatchObject({ title: groupTitle('Home', 'home'), color: 'cyan' });
      expect(chrome.groups.get(52)).toMatchObject({ title: '⧉ fake', color: 'red' });
      expect(chrome.groups.get(53)).toMatchObject({ title: 'Plain' });
      expect(startup.ownedGroups().map(([id]) => id).sort()).toEqual([50, 51]);
    });
  });
});
