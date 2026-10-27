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
 * A rule a setting must pass beyond its type (Full: the agent bridge needs consent, src/background/bridge/consent.ts).
 * `loaded` may correct what storage holds (the correction is written back); `check` refuses a change by throwing.
 */
export interface SettingsGuard {
  loaded(settings: Settings): Promise<Settings>;
  check(next: Settings, previous: Settings): Promise<void>;
}

/**
 * Settings in `chrome.storage.local` under `settings`. The title-prefix content script reads the same key, so a
 * change here reaches open pages through `storage.onChanged` without a message from the background. Every key a patch
 * names is remembered as set explicitly; the others follow the defaults (src/core/settings.ts, `StoredSettings`).
 */
export class SettingsStore {
  private value: Settings = normalizeSettings(undefined);
  private explicit = new Set<SettingKey>();
  private readonly listeners = new Set<SettingsListener>();

  constructor(
    private readonly area: StorageAreaLike,
    private readonly guard?: SettingsGuard,
  ) {}

  async load(): Promise<Settings> {
    const read = readSettings(
      (await this.area.get(SETTINGS_KEY))[SETTINGS_KEY],
    );
    this.value = read.settings;
    this.explicit = new Set(read.explicit);
    let corrected = false;
    if (this.guard) {
      const allowed = await this.guard.loaded(this.value);
      for (const key of Object.keys(allowed) as SettingKey[])
        if (allowed[key] !== this.value[key]) {
          corrected = true;
          // Back to the default (which the guard always allows), not an explicit choice of the user.
          this.explicit.delete(key);
        }
      this.value = { ...allowed };
    }
    // One-time rewrite of the format without `explicit` (the engine and content scripts read both the same way); a
    // guard's correction is written in the same format, so an older build reads it as before.
    if (read.legacy || corrected)
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
    if (this.guard) {
      const before = this.value;
      await this.guard.check(applySettingsPatch(before, patch), before);
    }
    // After the guard's wait another update may have landed: merge into what is current now.
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
