import { describe, expect, it } from 'vitest';
import { GroupDragIn, YOUNG_TAB_MS, type DragInTab } from './group-drag-in';

function setup() {
  const tabs = new Map<number, DragInTab>();
  const groups = new Map<number, string>(); // groupId -> container the group stands for
  const containers = new Map<number, string>(); // tabId -> container
  const calls: string[] = [];
  const state = { settling: new Set<number>(), failMoves: 0, clock: 100_000, nextTab: 500 };
  const drag = new GroupDragIn({
    getTab: async (id) => tabs.get(id) ?? null,
    groupContainer: async (g) => groups.get(g) ?? null,
    containerOf: (id) => containers.get(id) ?? null,
    isSettling: (id) => state.settling.has(id),
    containerName: (id) => id.toUpperCase(),
    move: async (id, target, url) => {
      if (state.failMoves > 0) {
        state.failMoves--;
        throw new Error('Tabs cannot be edited right now (user may be dragging a tab).');
      }
      const fresh = state.nextTab++;
      calls.push(`move ${id} -> ${fresh} ${target} ${url}`);
      tabs.delete(id);
      tabs.set(fresh, { url, groupId: -1 });
      containers.delete(id);
      containers.set(fresh, target);
      return fresh;
    },
    moved: (id, target, name) => void calls.push(`notice ${id} ${target} ${name}`),
    log: () => {},
    delay: async () => {},
    now: () => state.clock,
  });
  groups.set(10, 'reddit');
  groups.set(11, 'work');
  const tab = (id: number, groupId: number, container: string | null, url = 'https://gitlab.example/x') => {
    tabs.set(id, { url, groupId });
    if (container) containers.set(id, container);
    else containers.delete(id);
  };
  return { drag, tabs, calls, state, tab, containers };
}

describe('GroupDragIn', () => {
  it('reopens a plain tab dragged into a container group in that container, and says so', async () => {
    const { drag, tab, calls } = setup();
    tab(1, 10, null);
    await drag.groupChanged(1, 10);
    expect(calls).toEqual(['move 1 -> 500 reddit https://gitlab.example/x', 'notice 500 reddit REDDIT']);
  });

  it('reopens a container tab dragged from one container group into another', async () => {
    const { drag, tab, calls } = setup();
    tab(1, 11, 'reddit');
    await drag.groupChanged(1, 11);
    expect(calls[0]).toBe('move 1 -> 500 work https://gitlab.example/x');
  });

  it('leaves alone: a tab already in the group\'s container, leaving a group, groups that are not SplitSession\'s', async () => {
    const { drag, tab, calls } = setup();
    tab(1, 10, 'reddit'); // SplitSession grouped it itself
    tab(2, -1, 'reddit');
    tab(3, 99, null); // a group the user made
    tab(4, 99, 'reddit');
    await drag.groupChanged(1, 10);
    await drag.groupChanged(2, -1);
    await drag.groupChanged(3, 99);
    await drag.groupChanged(4, 99);
    expect(calls).toEqual([]);
  });

  it('leaves alone pages that are not websites, tabs still being assigned or restored, and tabs that moved on', async () => {
    const { drag, tab, calls, state } = setup();
    tab(1, 10, null, 'chrome://settings');
    tab(2, 10, null, 'chrome-extension://abc/held.html');
    tab(3, 10, null, 'about:blank#facet-abc123');
    tab(4, 10, null);
    state.settling.add(4);
    tab(5, 11, null); // dropped in another group by the time we look
    for (const id of [1, 2, 3, 4]) await drag.groupChanged(id, 10);
    await drag.groupChanged(5, 10);
    expect(calls).toEqual([]);
  });

  it('ignores a tab that has only just been created, and acts on the same tab later', async () => {
    const { drag, tab, calls, state } = setup();
    tab(1, 10, null);
    drag.tabCreated(1);
    await drag.groupChanged(1, 10);
    expect(calls).toEqual([]);
    state.clock += YOUNG_TAB_MS + 1;
    await drag.groupChanged(1, 10);
    expect(calls).toHaveLength(2);
  });

  it('waits while Chrome refuses edits during the drag, and checks again before acting', async () => {
    const { drag, tab, calls, state } = setup();
    tab(1, 10, null);
    state.failMoves = 3;
    await drag.groupChanged(1, 10);
    expect(calls[0]).toContain('move 1 -> 500 reddit');
    // Dropped elsewhere while it was refused: nothing happens.
    const second = setup();
    second.tab(2, 10, null);
    second.state.failMoves = 1;
    const pending = second.drag.groupChanged(2, 10);
    second.tab(2, 99, null);
    await pending;
    expect(second.calls).toEqual([]);
  });

  it('handles each change once and stops a runaway', async () => {
    const { drag, tab, calls } = setup();
    tab(1, 10, null);
    await Promise.all([drag.groupChanged(1, 10), drag.groupChanged(1, 10)]);
    expect(calls.filter((c) => c.startsWith('move'))).toHaveLength(1); // the second finds the tab gone
    for (let i = 0; i < 20; i++) {
      tab(100 + i, 10, null);
      await drag.groupChanged(100 + i, 10);
    }
    expect(calls.filter((c) => c.startsWith('move')).length).toBeLessThanOrEqual(10);
  });
});
