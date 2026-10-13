import {
  applySettingsPatch,
  normalizeSettings,
  readSettings,
  type SettingKey,
  type Settings,
  SETTINGS_KEY,
  storedSettings,
} from "../core";
import type { StorageAreaLike } from "../engine/storage/storage-area";

export type SettingsListener = (next: Settings, previous: Settings) => void;

/**
 * Settings in `chrome.storage.local` under `settings`. The title-prefix content script reads the same key, so a
 * change here reaches open pages through `storage.onChanged` without a message from the background. Every key a patch
 * names is remembered as set explicitly; the others follow the defaults (src/core/settings.ts, `StoredSettings`).
 */
export class SettingsStore {
  private value: Settings = normalizeSettings(undefined);
  private explicit = new Set<SettingKey>();
  private readonly listeners = new Set<SettingsListener>();

  constructor(private readonly area: StorageAreaLike) {}

  async load(): Promise<Settings> {
    const read = readSettings(
      (await this.area.get(SETTINGS_KEY))[SETTINGS_KEY],
    );
    this.value = read.settings;
    this.explicit = new Set(read.explicit);
    // One-time rewrite of the format without `explicit` (the engine and content scripts read both the same way).
    if (read.legacy)
      await this.area.set({
        [SETTINGS_KEY]: storedSettings(this.value, this.explicit),
      });
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
    for (const key of Object.keys(patch as object))
      this.explicit.add(key as SettingKey);
    await this.area.set({
      [SETTINGS_KEY]: storedSettings(next, this.explicit),
    });
    for (const listener of [...this.listeners]) {
      try {
        listener({ ...next }, { ...previous });
      } catch (error) {
        console.error("[splitsession] settings listener failed", error);
      }
    }
    return this.get();
  }

  onChange(listener: SettingsListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
