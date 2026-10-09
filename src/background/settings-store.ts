import { applySettingsPatch, normalizeSettings, SETTINGS_KEY, type Settings } from '../core';
import type { StorageAreaLike } from '../engine/storage/storage-area';

export type SettingsListener = (next: Settings, previous: Settings) => void;

/**
 * Settings in `chrome.storage.local` under `settings`. The title-prefix content script reads the same key, so a
 * change here reaches open pages through `storage.onChanged` without a message from the background.
 */
export class SettingsStore {
  private value: Settings = normalizeSettings(undefined);
  private readonly listeners = new Set<SettingsListener>();

  constructor(private readonly area: StorageAreaLike) {}

  async load(): Promise<Settings> {
    this.value = normalizeSettings((await this.area.get(SETTINGS_KEY))[SETTINGS_KEY]);
    return this.get();
  }

  get(): Settings {
    return { ...this.value };
  }

  /** Validates, stores, then notifies listeners (also when nothing changed: callers compare). */
  async update(patch: unknown): Promise<Settings> {
    const previous = this.value;
    const next = applySettingsPatch(previous, patch);
    this.value = next;
    await this.area.set({ [SETTINGS_KEY]: next });
    for (const listener of [...this.listeners]) {
      try {
        listener({ ...next }, { ...previous });
      } catch (error) {
        console.error('[facet] settings listener failed', error);
      }
    }
    return this.get();
  }

  onChange(listener: SettingsListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
