import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContainerError, ContainerStore, CONTAINERS_KEY, generateContainerId, jarKey } from './container-store';
import { MemoryStorageArea } from './storage-area';
import { TabRegistry, TABS_KEY } from './tab-registry';

afterEach(() => vi.useRealTimers());

describe('ContainerStore', () => {
  it('creates containers with safe IDs, unique names and cycling colours, and persists them', async () => {
    const area = new MemoryStorageArea();
    const store = new ContainerStore(area, { now: () => 42 });
    const a = await store.create({ name: '  Work  account ' });
    const b = await store.create({ name: 'alt', color: 'red' });
    expect(a).toMatchObject({ name: 'Work account', color: 'blue', createdAt: 42 });
    expect(a.id).toMatch(/^[a-z0-9]{10}$/);
    expect(b.color).toBe('red');
    await expect(store.create({ name: 'ALT' })).rejects.toThrow(ContainerError);
    await expect(store.create({ name: '   ' })).rejects.toThrow(ContainerError);
    await expect(store.create({ name: 'x', color: 'beige' as never })).rejects.toThrow(ContainerError);
    expect((area.data.get(CONTAINERS_KEY) as unknown[]).length).toBe(2);
    expect(store.resolve(a.id)?.name).toBe('Work account');
    expect(store.resolve('work ACCOUNT')?.id).toBe(a.id);
  });

  it('renames (refusing clashes) and deletes with the jar', async () => {
    const area = new MemoryStorageArea();
    const store = new ContainerStore(area);
    const a = await store.create({ name: 'a' });
    await store.create({ name: 'b' });
    await expect(store.update(a.id, { name: 'B' })).rejects.toThrow(ContainerError);
    expect((await store.update(a.id, { name: 'c', color: 'green' })).color).toBe('green');
    store.jar(a.id).setFromHeader('x=1', { url: 'http://a.localhost/' });
    store.touchJar(a.id);
    await store.flush();
    expect(area.data.has(jarKey(a.id))).toBe(true);
    expect(await store.delete(a.id)).toBe(true);
    expect(area.data.has(jarKey(a.id))).toBe(false);
    expect(store.get(a.id)).toBeUndefined();
    expect(await store.delete(a.id)).toBe(false);
  });

  it('debounces jar writes and reloads jars from storage', async () => {
    vi.useFakeTimers();
    const area = new MemoryStorageArea();
    const store = new ContainerStore(area, { debounceMs: 100 });
    const c = await store.create({ name: 'a' });
    const writes = area.writes;
    for (let i = 0; i < 5; i++) {
      store.jar(c.id).setFromHeader(`k${i}=v`, { url: 'http://a.localhost/' });
      store.touchJar(c.id);
    }
    expect(area.writes).toBe(writes);
    await vi.advanceTimersByTimeAsync(150);
    expect(area.writes).toBe(writes + 1);

    const reloaded = new ContainerStore(area);
    await reloaded.load();
    expect(reloaded.jar(c.id).all().map((k) => k.name)).toEqual(['k0', 'k1', 'k2', 'k3', 'k4']);
  });

  it('ignores malformed stored data', async () => {
    const area = new MemoryStorageArea();
    await area.set({ [CONTAINERS_KEY]: [{ id: 'BAD ID', name: 'x', color: 'blue', createdAt: 1 }, { id: 'ok1', name: 'y', color: 'blue', createdAt: 1 }, 7] });
    await area.set({ [jarKey('ok1')]: { version: 9 } });
    const store = new ContainerStore(area);
    await store.load();
    expect(store.list().map((c) => c.id)).toEqual(['ok1']);
    expect(store.jar('ok1').size).toBe(0);
  });

  it('generateContainerId is lowercase alphanumeric', () => {
    expect(generateContainerId(() => 0.999)).toBe('zzzzzzzzzz');
    expect(generateContainerId(() => 0)).toBe('0000000000');
  });
});

describe('TabRegistry', () => {
  it('updates memory synchronously, persists to session storage and reloads', async () => {
    const area = new MemoryStorageArea();
    const reg = new TabRegistry(area);
    const write = reg.set(5, { containerId: 'a', topLevelSite: null, activeSince: null });
    expect(reg.containerOf(5)).toBe('a');
    await write;
    await reg.update(5, { activeSince: 10, topLevelSite: 'http://a.localhost' });
    await reg.set(6, { containerId: 'a', topLevelSite: null, activeSince: 11 });
    await reg.set(7, { containerId: 'b', topLevelSite: null, activeSince: 12 });
    expect(reg.tabsOf('a')).toEqual([5, 6]);
    expect([...reg.containerIds()].sort()).toEqual(['a', 'b']);
    await reg.delete(6);

    const again = new TabRegistry(area);
    await again.load();
    expect(again.entries()).toEqual([
      [5, { containerId: 'a', topLevelSite: 'http://a.localhost', activeSince: 10 }],
      [7, { containerId: 'b', topLevelSite: null, activeSince: 12 }],
    ]);
  });

  it('mirrors the map to a backup area that survives an extension update', async () => {
    const session = new MemoryStorageArea();
    const local = new MemoryStorageArea();
    const reg = new TabRegistry(session, local);
    await reg.set(3, { containerId: 'a', topLevelSite: null, activeSince: 1, windowId: 9, url: 'http://a.localhost/' });
    session.data.clear(); // what Chrome does on update
    const after = new TabRegistry(session, local);
    await after.load();
    expect(after.entries()).toEqual([]);
    expect([...(await after.loadBackup())]).toEqual([[3, { containerId: 'a', topLevelSite: null, activeSince: 1, windowId: 9, url: 'http://a.localhost/' }]]);
    await after.clearBackup();
    expect((await after.loadBackup()).size).toBe(0);
  });

  it('drops malformed entries on load', async () => {
    const area = new MemoryStorageArea();
    await area.set({ [TABS_KEY]: { '1': { containerId: 'a', topLevelSite: null, activeSince: 1 }, '-1': { containerId: 'a' }, x: 1, '2': { containerId: 3 } } });
    const reg = new TabRegistry(area);
    await reg.load();
    expect(reg.entries().map(([id]) => id)).toEqual([1]);
  });
});
