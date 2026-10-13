import type { ContainerId } from "../../core";
import type { StorageAreaLike } from "./storage-area";

export const TABS_KEY = "tabs";
/** Same map in `storage.local`: session storage and session rules are wiped when the extension is updated. */
export const TABS_BACKUP_KEY = "tabsBackup";

export interface TabRecord {
  containerId: ContainerId;
  /** Top-level site of the tab's committed main frame (`siteOf`), or null before the first http(s) commit. */
  topLevelSite: string | null;
  /**
   * Epoch ms at which the tab's rules became active; null while the assignment is still being installed.
   * Requests sent before this moment carried the real profile's cookies: their Set-Cookie is not trusted.
   */
  activeSince: number | null;
  /** Window and last committed URL, to recognise the same tab after an extension update. */
  windowId?: number;
  url?: string;
}

function isTabRecord(x: unknown): x is TabRecord {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.containerId === "string" &&
    (r.topLevelSite === null || typeof r.topLevelSite === "string") &&
    (r.activeSince === null || typeof r.activeSince === "number") &&
    (r.windowId === undefined || typeof r.windowId === "number") &&
    (r.url === undefined || typeof r.url === "string")
  );
}

/**
 * `tabId -> container` in `chrome.storage.session` (survives service-worker restarts, cleared with the browser
 * session). Memory updates are synchronous so event handlers see an assignment immediately; writes are queued.
 */
export class TabRegistry {
  private readonly tabs = new Map<number, TabRecord>();
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly area: StorageAreaLike,
    private readonly backup?: StorageAreaLike,
  ) {}

  async load(): Promise<void> {
    this.tabs.clear();
    for (const [tabId, rec] of parseTabs(
      (await this.area.get(TABS_KEY))[TABS_KEY],
    ))
      this.tabs.set(tabId, rec);
  }

  /** The `storage.local` copy (what the registry looked like before an extension update). */
  async loadBackup(): Promise<Map<number, TabRecord>> {
    if (!this.backup) return new Map();
    return parseTabs((await this.backup.get(TABS_BACKUP_KEY))[TABS_BACKUP_KEY]);
  }

  async clearBackup(): Promise<void> {
    await this.backup?.remove(TABS_BACKUP_KEY);
  }

  get(tabId: number): TabRecord | undefined {
    const rec = this.tabs.get(tabId);
    return rec ? { ...rec } : undefined;
  }

  has(tabId: number): boolean {
    return this.tabs.has(tabId);
  }

  containerOf(tabId: number): ContainerId | undefined {
    return this.tabs.get(tabId)?.containerId;
  }

  entries(): Array<[number, TabRecord]> {
    return [...this.tabs].map(([id, rec]) => [id, { ...rec }]);
  }

  tabsOf(containerId: ContainerId): number[] {
    return [...this.tabs]
      .filter(([, rec]) => rec.containerId === containerId)
      .map(([id]) => id);
  }

  containerIds(): Set<ContainerId> {
    return new Set([...this.tabs.values()].map((rec) => rec.containerId));
  }

  set(tabId: number, record: TabRecord): Promise<void> {
    this.tabs.set(tabId, { ...record });
    return this.persist();
  }

  update(tabId: number, patch: Partial<TabRecord>): Promise<void> {
    const rec = this.tabs.get(tabId);
    if (!rec) return this.writing;
    Object.assign(rec, patch);
    return this.persist();
  }

  delete(tabId: number): Promise<void> {
    if (!this.tabs.delete(tabId)) return this.writing;
    return this.persist();
  }

  private persist(): Promise<void> {
    const snapshot = Object.fromEntries(
      [...this.tabs].map(([id, rec]) => [String(id), { ...rec }]),
    );
    this.writing = this.writing
      .then(() =>
        Promise.all([
          this.area.set({ [TABS_KEY]: snapshot }),
          this.backup?.set({ [TABS_BACKUP_KEY]: snapshot }),
        ]),
      )
      .then(() => undefined)
      .catch(() => {});
    return this.writing;
  }
}

function parseTabs(stored: unknown): Map<number, TabRecord> {
  const out = new Map<number, TabRecord>();
  if (typeof stored !== "object" || stored === null) return out;
  for (const [key, value] of Object.entries(stored)) {
    const tabId = Number(key);
    if (Number.isInteger(tabId) && tabId >= 0 && isTabRecord(value))
      out.set(tabId, { ...value });
  }
  return out;
}
