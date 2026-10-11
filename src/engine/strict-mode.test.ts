import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, readSettings, SETTINGS_KEY } from '../core';
import { MemoryStorageArea } from './storage/storage-area';
import { migrateStrictMode, StrictMode, STRICT_STATE_KEY } from './strict-mode';
import type { ServiceWorkerPolicy } from './sw-policy';

const settingsOf = (area: MemoryStorageArea) => readSettings(area.data.get(SETTINGS_KEY));

describe('migrateStrictMode (consent prompt -> plain setting, default off)', () => {
  it('an install that had agreed keeps strict mode on (explicit, so a changed default does not reach it)', async () => {
    const area = new MemoryStorageArea();
    await area.set({ [STRICT_STATE_KEY]: { consentAt: 1_700_000_000_000, prompt: false } });
    await migrateStrictMode(area);
    expect(settingsOf(area).settings.strictMode).toBe(true);
    expect(settingsOf(area).explicit).toContain('strictMode');
    expect(area.data.get(STRICT_STATE_KEY)).toEqual({ v: 2 });
  });

  it('keeps the other choices of an install that had agreed', async () => {
    const area = new MemoryStorageArea();
    await area.set({
      [SETTINGS_KEY]: { ...DEFAULT_SETTINGS, strictMode: true, tabGroups: false, explicit: ['tabGroups'] },
      [STRICT_STATE_KEY]: { consentAt: 5, prompt: false },
    });
    await migrateStrictMode(area);
    expect(settingsOf(area)).toMatchObject({ settings: { strictMode: true, tabGroups: false }, explicit: expect.arrayContaining(['tabGroups', 'strictMode']) });
  });

  it('an install still waiting for the answer (prompt pending, "Not now", never asked) gets it off', async () => {
    for (const state of [{ consentAt: null, prompt: true }, { consentAt: null, prompt: false }, undefined]) {
      const area = new MemoryStorageArea();
      await area.set({ [SETTINGS_KEY]: { ...DEFAULT_SETTINGS, strictMode: true, explicit: ['strictMode'] } });
      if (state) await area.set({ [STRICT_STATE_KEY]: state });
      await migrateStrictMode(area);
      expect(settingsOf(area).settings.strictMode).toBe(false);
      expect(settingsOf(area).explicit).not.toContain('strictMode');
      expect(area.data.get(STRICT_STATE_KEY)).toEqual({ v: 2 });
    }
  });

  it('a fresh install writes only the marker; an old-format `true` with no consent becomes off', async () => {
    const fresh = new MemoryStorageArea();
    await migrateStrictMode(fresh);
    expect(fresh.data.has(SETTINGS_KEY)).toBe(false);
    expect(fresh.data.get(STRICT_STATE_KEY)).toEqual({ v: 2 });

    const legacy = new MemoryStorageArea();
    await legacy.set({ [SETTINGS_KEY]: { tabGroups: true, titlePrefix: true, strictMode: true, showNameToPages: true } });
    await migrateStrictMode(legacy);
    expect(settingsOf(legacy).settings.strictMode).toBe(false);
    expect(settingsOf(legacy).legacy).toBe(false);
  });

  it('runs once: a later start does not undo what the user chose in Settings', async () => {
    const area = new MemoryStorageArea();
    await migrateStrictMode(area);
    await area.set({ [SETTINGS_KEY]: { ...DEFAULT_SETTINGS, strictMode: true, explicit: ['strictMode'] } });
    await migrateStrictMode(area);
    expect(settingsOf(area).settings.strictMode).toBe(true);
  });
});

describe('StrictMode', () => {
  const policy = () => {
    const calls: string[] = [];
    const sw = {
      removeAll: vi.fn(async () => void calls.push('removeAll')),
      setGuard: vi.fn(async (on: boolean) => void calls.push(`guard:${on}`)),
    };
    return { sw: sw as unknown as ServiceWorkerPolicy, calls, raw: sw };
  };

  it('is off by default; the setting alone decides the guard at start', () => {
    expect(new StrictMode(policy().sw).load(false)).toBe(false);
    expect(new StrictMode(policy().sw).load(true)).toBe(true);
  });

  it('turning on removes every worker, then raises the guard; turning off only drops the guard', async () => {
    const { sw, calls } = policy();
    const strict = new StrictMode(sw);
    strict.load(false);
    await strict.setEnabled(true);
    expect(calls).toEqual(['removeAll', 'guard:true']);
    expect(strict.status()).toEqual({ enabled: true, active: true });
    await strict.setEnabled(true); // already on: nothing again
    await strict.turnOn();
    expect(calls).toEqual(['removeAll', 'guard:true']);
    await strict.setEnabled(false);
    expect(calls).toEqual(['removeAll', 'guard:true', 'guard:false']);
    expect(strict.status()).toEqual({ enabled: false, active: false });
  });

  it('stays off when the removal fails', async () => {
    const { sw, raw } = policy();
    raw.removeAll.mockRejectedValueOnce(new Error('boom'));
    const strict = new StrictMode(sw);
    strict.load(false);
    await expect(strict.turnOn()).rejects.toThrow('boom');
    expect(strict.active).toBe(false);
    expect(raw.setGuard).not.toHaveBeenCalled();
  });

  it('sweeps again at start and on install/update only while on', async () => {
    const { sw, raw } = policy();
    const strict = new StrictMode(sw);
    strict.load(false);
    await strict.startup();
    await strict.installed('update');
    expect(raw.removeAll).not.toHaveBeenCalled();
    strict.load(true);
    await strict.startup();
    await strict.installed('update');
    await strict.installed('chrome_update');
    expect(raw.removeAll).toHaveBeenCalledTimes(2);
  });
});
