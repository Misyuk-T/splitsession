import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StorageAreaLike } from '../engine/storage/storage-area';
import { RESTORE_STATE_KEY, windowSignature } from '../core';
import { TabRestore, type RestoreBrowser, type RestoreDeps } from './restore';

const HELD = 'chrome-extension://abc/held.html';
const U = (p: string) => `https://a.example.com/${p}`;

function area(): StorageAreaLike & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => data.has(k)).map((k) => [k, data.get(k)])),
    set: async (items: Record<string, unknown>) => void Object.entries(items).forEach(([k, v]) => data.set(k, structuredClone(v))),
    remove: async (keys: string | string[]) => void (Array.isArray(keys) ? keys : [keys]).forEach((k) => data.delete(k)),
  } as never;
}

function make(tabs: Array<{ id: number; windowId: number; index: number; url: string; groupId?: number }>) {
  const local = area();
  const session = area();
  const updates: Array<[number, string]> = [];
  const held: number[][] = [];
  const b = {
    tabs: {
      query: async () => tabs.map((t) => ({ groupId: -1, ...t })),
      get: async (id: number) => ({ groupId: -1, ...tabs.find((t) => t.id === id)! }),
      reload: async () => {},
      update: async (id: number, props: { url: string }) => void updates.push([id, props.url]),
    },
    tabGroups: { query: async () => [] },
    sessions: { getRecentlyClosed: async () => [] },
    webNavigation: { getFrame: async () => null },
    declarativeNetRequest: { getDynamicRules: async () => [], updateDynamicRules: async () => {} },
  } as unknown as RestoreBrowser;
  const deps: RestoreDeps = {
    b,
    local,
    session,
    log: Object.assign(() => {}, { entries: () => [] }) as never,
    containerTabs: () => [[2, 'work']],
    hasContainer: () => true,
    isContainerTab: (id) => id === 2,
    assign: async () => {},
    invalidate: async () => true,
    prepareNavigation: async () => {},
    heldPage: HELD,
    heldChanged: (ids) => void held.push(ids),
  };
  return { restore: new TabRestore(deps), local, updates, held, tabs };
}

describe('TabRestore: the window snapshot follows a closed plain tab', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const windowsOf = (local: ReturnType<typeof area>) => (local.data.get(RESTORE_STATE_KEY) as { windows: Array<{ sig: string }> }).windows.map((w) => w.sig);

  it('a plain tab that closed is written within moments, so a quit right after leaves no stale signature', async () => {
    const tabs = [
      { id: 1, windowId: 1, index: 0, url: U('plain') },
      { id: 2, windowId: 1, index: 1, url: U('work') },
      { id: 3, windowId: 1, index: 2, url: U('other') },
    ];
    const { restore, local } = make(tabs);
    if (await restore.load(tabs, true)) await restore.startupPass();
    await restore.snapshot();
    expect(windowsOf(local)).toEqual([windowSignature([U('plain'), U('work'), U('other')])]);

    tabs.splice(0, 1); // the user closes the plain tab
    restore.tabRemoved(1, false);
    await vi.advanceTimersByTimeAsync(250);
    expect(windowsOf(local)).toEqual([windowSignature([U('work'), U('other')])]);
  });

  it('a closing window writes nothing for each of its tabs; a pending write is flushed on suspend', async () => {
    const tabs = [{ id: 2, windowId: 1, index: 0, url: U('work') }];
    const { restore, local } = make(tabs);
    if (await restore.load(tabs, true)) await restore.startupPass();
    await restore.snapshot();
    const writes = vi.spyOn(local, 'set');
    restore.tabRemoved(9, true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(writes).not.toHaveBeenCalled();
    restore.scheduleSnapshot();
    restore.flushPending();
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toHaveBeenCalled();
  });

  it('a burst of changes is written at the latest half a second after its first', async () => {
    const tabs = [{ id: 2, windowId: 1, index: 0, url: U('work') }];
    const { restore, local } = make(tabs);
    if (await restore.load(tabs, true)) await restore.startupPass();
    await restore.snapshot();
    const writes = vi.spyOn(local, 'set');
    for (let i = 0; i < 20; i++) {
      restore.scheduleSnapshot();
      await vi.advanceTimersByTimeAsync(60);
    }
    expect(writes).toHaveBeenCalled();
  });
});
