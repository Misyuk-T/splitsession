/** The subset of `chrome.storage.StorageArea` the stores use (lets unit tests pass an in-memory fake). */
export interface StorageAreaLike {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

/** In-memory StorageArea for tests. Values are cloned like Chrome's structured serialisation. */
export class MemoryStorageArea implements StorageAreaLike {
  readonly data = new Map<string, unknown>();
  writes = 0;

  async get(keys?: string | string[] | null): Promise<Record<string, unknown>> {
    const wanted =
      keys == null
        ? [...this.data.keys()]
        : Array.isArray(keys)
          ? keys
          : [keys];
    const out: Record<string, unknown> = {};
    for (const key of wanted)
      if (this.data.has(key)) out[key] = structuredClone(this.data.get(key));
    return out;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    this.writes++;
    for (const [key, value] of Object.entries(items))
      this.data.set(key, structuredClone(value));
  }

  async remove(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys])
      this.data.delete(key);
  }
}
