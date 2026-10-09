import { describe, expect, it } from 'vitest';
import type { Container, Settings } from '../core';
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
  const area = new MemoryStorageArea();
  const assigned: Array<{ tabId: number; containerId: string }> = [];
  const state = { tabGroups: true, titlePrefix: true, strictMode: true, showNameToPages: true, ...settings };
  const projection = new TabGroupProjection({
    tabs: chrome.api.tabs,
    tabGroups: chrome.api.tabGroups,
    area,
    settings: () => state,
    container: (id) => containers.get(id),
    containerTabs: () => assigned,
    log: () => {},
    delay: async () => {},
  });
  const assign = async (tabId: number, containerId: string) => {
    assigned.push({ tabId, containerId });
    await projection.tabAssigned(tabId, containerId);
  };
  return { chrome, area, projection, assign, state, assigned };
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
    expect(chrome.groups.get(g(1))).toMatchObject({ title: 'Work', color: 'blue', windowId: 1 });
    expect(chrome.groups.get(g(3))).toMatchObject({ title: 'Home', color: 'cyan' });
    expect(chrome.groups.get(g(4))).toMatchObject({ title: 'Work', windowId: 2 });
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
    expect(chrome.groups.get(chrome.tabs.get(3)!.groupId)).toMatchObject({ title: 'Work' });
    expect(chrome.tabs.get(1)!.groupId).toBe(chrome.tabs.get(2)!.groupId);
    await projection.reconcileAll();
    expect(chrome.tabs.get(1)!.groupId).toBe(chrome.tabs.get(3)!.groupId);
  });

  it('renames and recolours the groups of a container', async () => {
    const { chrome, assign, projection } = setup();
    chrome.addTab(1);
    await assign(1, 'work');
    await projection.containerUpdated({ id: 'work', name: 'Job', color: 'red', createdAt: 1 });
    expect(chrome.groups.get(chrome.tabs.get(1)!.groupId)).toMatchObject({ title: 'Job', color: 'red' });
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
      settings: () => ({ tabGroups: true, titlePrefix: true, strictMode: true, showNameToPages: true }),
      container: (id) => containers.get(id),
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
});
