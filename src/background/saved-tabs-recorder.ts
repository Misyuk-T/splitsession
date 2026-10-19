import {
  BATCH_GAP_MS,
  cleanTabTitle,
  type ClosedTab,
  ClosureLog,
  type ContainerId,
  mergeTabLists,
  type SavedTab,
  savedTabsOf,
} from "../core";
import type { StorageAreaLike } from "../engine/storage/storage-area";

/** `storage.session` key: the last known address, title and position of every container tab. */
export const TAB_MEMORY_KEY = "savedTabsMemory";
/** A container whose last tab closed with its window waits this long before its tabs are saved (see `windowClosing`). */
export const WINDOW_CLOSE_GRACE_MS = 2500;
const REFRESH_DELAY_MS = 300;
const PERSIST_DELAY_MS = 300;
/** Memory of a tab that is not seen alive any more goes after this long (its removal event is processed long before). */
const FORGET_AFTER_MS = 60_000;

/** A tab as `tabs.query` / `tabs.onUpdated` report it. */
export interface SeenTab {
  id?: number;
  url?: string;
  pendingUrl?: string;
  title?: string;
  index: number;
  windowId: number;
}

interface Remembered {
  containerId: ContainerId;
  url: string;
  title: string;
  windowId: number;
  index: number;
  /** When this worker last saw the tab alive (or loaded its memory). */
  seen: number;
}

export interface RecorderDeps {
  /** Memory survives the worker sleeping: a tab that closes while the worker is stopped is still known. */
  session: StorageAreaLike;
  queryTabs(): Promise<SeenTab[]>;
  /** How many browser windows exist now. */
  windowCount(): Promise<number>;
  /** The container of a tab (the engine's registry). */
  containerOf(tabId: number): ContainerId | undefined;
  /** The tabs the registry assigns to the container. */
  tabsOf(containerId: ContainerId): number[];
  containerName(containerId: ContainerId): string | undefined;
  /** The "Remember tabs" setting. */
  enabled(): boolean;
  save(containerId: ContainerId, tabs: SavedTab[]): Promise<void>;
  /** What the container has saved now (an unopened remainder of an earlier set). */
  existing?(containerId: ContainerId): SavedTab[];
  log?(
    level: "info" | "warn" | "error",
    message: string,
    detail?: unknown,
  ): void;
  now?(): number;
}

/**
 * Remembers a container's tabs when its last tab closes. It keeps the address, title and position of every container tab
 * (`tabs.onUpdated` and a refresh after layout changes), and on every `tabs.onRemoved` of such a tab it adds the closure
 * to the container's log (`ClosureLog`). When that closure leaves the container with no tab, the container's last batch
 * of closures (tabs closed within `BATCH_GAP_MS` of each other) is its saved set.
 *
 * Browser shutdown must not overwrite the set (Chrome puts those tabs back itself and the restore puts them in their
 * containers): a batch that includes tabs closed "with their window" (`isWindowClosing`: a window close, or the browser
 * quitting) is saved only `WINDOW_CLOSE_GRACE_MS` later, and only if a browser window still exists then. A worker that
 * dies with the browser never gets there, and the last window closing is treated as quitting too.
 */
export class SavedTabsRecorder {
  private memory = new Map<number, Remembered>();
  private readonly log = new ClosureLog();
  /** Tabs that closed lately (ids are not reused): not counted as open while the registry catches up with the closures. */
  private readonly closed = new Map<number, number>();
  /** Tabs SplitSession closes itself while moving them elsewhere: not a closure by the user. */
  private readonly moved = new Set<number>();
  private readonly deferred = new Map<
    ContainerId,
    ReturnType<typeof setTimeout>
  >();

  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private frozenUntil = 0;
  private working: Promise<unknown> = Promise.resolve();
  private loaded: Promise<void> | null = null;
  private readonly now: () => number;

  constructor(private readonly d: RecorderDeps) {
    this.now = d.now ?? Date.now;
  }

  /** Reads the persisted memory, then looks at the tabs now. Call once at start. */
  start(): Promise<void> {
    this.loaded ??= this.d.session
      .get(TAB_MEMORY_KEY)
      .then((stored) => {
        const raw = stored[TAB_MEMORY_KEY];
        const seen = this.now();
        if (typeof raw === "object" && raw !== null) {
          for (const [key, value] of Object.entries(raw)) {
            const id = Number(key);
            if (Number.isInteger(id) && isRemembered(value))
              this.memory.set(id, { ...value, seen });
          }
        }
      })
      .catch(() => {})
      .then(() => this.refresh());
    return this.loaded;
  }

  /** Tests: finishes the refresh, the saves and the memory write that are waiting. */
  async flush(): Promise<void> {
    await this.loaded;
    if (this.refreshTimer !== null) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    await this.refresh(true);
    await this.working;
    await this.persist();
  }

  // ---- what the tabs do ----

  /** A tab was assigned to, or taken out of, a container, or its layout changed: look at the tabs soon. */
  layoutChanged(): void {
    if (this.refreshTimer !== null) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, REFRESH_DELAY_MS);
  }

  /** `tabs.onUpdated`: a container tab navigated or retitled. */
  tabUpdated(tab: SeenTab): void {
    const id = tab.id;
    const containerId = id === undefined ? undefined : this.d.containerOf(id);
    if (id === undefined || containerId === undefined) return;
    this.remember(id, containerId, tab);
    this.schedulePersist();
  }

  /**
   * A tab SplitSession opened for a saved entry: it stands for that address and title before its navigation commits, so
   * closing it at once still saves it. Call it before the entry leaves the stored set.
   */
  seed(
    tabId: number,
    containerId: ContainerId,
    tab: SavedTab,
    place: { windowId: number; index: number },
  ): void {
    this.memory.set(tabId, {
      containerId,
      url: tab.url,
      title: tab.title,
      windowId: place.windowId,
      index: place.index,
      seen: this.now(),
    });
    this.schedulePersist();
  }

  /** `tabs.onReplaced`: the browser swapped the tab for another one (prerender, instant). */
  tabReplaced(added: number, removed: number): void {
    const entry = this.memory.get(removed);
    if (!entry) return;
    this.memory.delete(removed);
    this.memory.set(added, entry);
    this.schedulePersist();
  }

  /**
   * A tab was assigned to the container: a new open cycle begins, so the closures of the last one (tabs that were just
   * reopened and closed again within the gap) must not join the next batch.
   */
  tabAssigned(containerId: ContainerId): void {
    this.working = this.working
      .then(() => this.loaded)
      .then(() => this.log.forget(containerId))
      .catch(() => {});
  }

  /** SplitSession is about to close this tab itself because it moves the page elsewhere (a rule, the group guard). */
  willMove(tabId: number): void {
    this.moved.add(tabId);
  }

  /**
   * `tabs.onRemoved`. `at` is when the event arrived (the work itself follows the engine's start-up, so it may run
   * later; the batch is judged by the time of the closures, not of the work).
   */
  tabRemoved(tabId: number, windowClosing: boolean, at = this.now()): void {
    this.working = this.working
      .then(() => this.loaded)
      .then(() => this.handleRemoved(tabId, windowClosing, at))
      .catch((error) =>
        this.d.log?.("error", "saved tabs: closure failed", String(error)),
      );
  }

  // ---- internals ----

  private remember(id: number, containerId: ContainerId, tab: SeenTab): void {
    // The address it commits to, or the one it is loading (a blank page that is about to navigate shows about:blank as `url`).
    const real = [tab.url, tab.pendingUrl].find(
      (u) => u !== undefined && u !== "" && u !== "about:blank",
    );
    const old = this.memory.get(id);
    // While tabs are closing the positions of the others shift: a closing batch is ordered by where its tabs stood before.
    const frozen = old !== undefined && this.now() < this.frozenUntil;
    this.memory.set(id, {
      containerId,
      // A tab with no address yet (blank, nothing loading) keeps what it had: a seeded or earlier address and title.
      url: real ?? old?.url ?? tab.url ?? "",
      title:
        real === undefined && old ? old.title : (tab.title ?? old?.title ?? ""),
      windowId: frozen ? old.windowId : tab.windowId,
      index: frozen ? old.index : tab.index,
      seen: this.now(),
    });
  }

  private async refresh(force = false): Promise<void> {
    const now = this.now();
    // While tabs are closing, positions of the rest shift: the batch is ordered by where its tabs stood before.
    if (!force && now < this.frozenUntil) {
      this.layoutChanged();
      return;
    }
    let tabs: SeenTab[];
    try {
      tabs = await this.d.queryTabs();
    } catch {
      return;
    }
    for (const tab of tabs) {
      if (tab.id === undefined) continue;
      const containerId = this.d.containerOf(tab.id);
      if (containerId === undefined) this.memory.delete(tab.id);
      else this.remember(tab.id, containerId, tab);
    }
    for (const [id, entry] of this.memory)
      if (this.now() - entry.seen > FORGET_AFTER_MS) this.memory.delete(id);
    for (const [id, at] of this.closed)
      if (this.now() - at > FORGET_AFTER_MS) this.closed.delete(id);
    this.schedulePersist();
  }

  private async handleRemoved(
    tabId: number,
    windowClosing: boolean,
    at: number,
  ): Promise<void> {
    const entry = this.memory.get(tabId);
    this.memory.delete(tabId);
    this.closed.set(tabId, at);
    const containerId = entry?.containerId ?? this.d.containerOf(tabId);
    if (containerId === undefined) return;
    this.frozenUntil = Math.max(this.frozenUntil, at + BATCH_GAP_MS + 200);
    this.schedulePersist();

    const name = this.d.containerName(containerId);
    if (name === undefined) return; // the container is gone (deleted): nothing to save for it
    if (this.moved.delete(tabId)) {
      // A tab SplitSession moved to another container (or out of any): its page lives on elsewhere.
    } else {
      const tab: ClosedTab | null = entry
        ? {
            url: entry.url,
            title: cleanTabTitle(entry.title, name),
            windowId: entry.windowId,
            index: entry.index,
          }
        : null;
      this.log.add(containerId, { tab, at, windowClosing });
    }

    const open = this.d
      .tabsOf(containerId)
      .filter((id) => id !== tabId && !this.closed.has(id));
    if (open.length > 0) return;
    await this.lastTabClosed(containerId, at);
  }

  /** The container has no tab left: its last batch becomes its saved set. */
  private async lastTabClosed(
    containerId: ContainerId,
    at: number,
  ): Promise<void> {
    if (!this.d.enabled()) return;
    const batch = this.log.last(containerId);
    // The batch ends with the closure that emptied the container; an older one is not this closing.
    if (batch.length === 0 || at - batch[batch.length - 1]!.at > BATCH_GAP_MS)
      return;
    const tabs = savedTabsOf(batch);
    if (tabs.length === 0) return;
    const previous = this.deferred.get(containerId);
    if (previous !== undefined) clearTimeout(previous);
    this.deferred.delete(containerId);
    if (batch.some((c) => c.windowClosing)) {
      this.deferred.set(
        containerId,
        setTimeout(() => {
          this.deferred.delete(containerId);
          this.working = this.working
            .then(() => this.saveIfStillClosed(containerId, tabs))
            .catch(() => {});
        }, WINDOW_CLOSE_GRACE_MS),
      );
      return;
    }
    await this.saveBatch(containerId, tabs);
  }

  /**
   * The batch comes first, in its order; what the container still has saved (tabs of an earlier set that were not
   * reopened) follows, so closing a partly reopened set does not delete the rest. One entry per address, at most 50.
   */
  private async saveBatch(
    containerId: ContainerId,
    batch: SavedTab[],
  ): Promise<void> {
    const merged = mergeTabLists(batch, this.d.existing?.(containerId) ?? []);
    await this.d.save(containerId, merged);
    this.d.log?.("info", `saved ${merged.length} tabs of ${containerId}`);
  }

  /** After the grace period of a window close: not the browser quitting (a window is left), and no tab came back. */
  private async saveIfStillClosed(
    containerId: ContainerId,
    tabs: SavedTab[],
  ): Promise<void> {
    if (!this.d.enabled() || this.d.containerName(containerId) === undefined)
      return;
    if (this.d.tabsOf(containerId).some((id) => !this.closed.has(id))) return;
    if ((await this.d.windowCount().catch(() => 0)) === 0) return;
    await this.saveBatch(containerId, tabs);
  }

  private schedulePersist(): void {
    if (this.persistTimer !== null) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persist();
    }, PERSIST_DELAY_MS);
  }

  private async persist(): Promise<void> {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    const snapshot = Object.fromEntries(
      [...this.memory].map(([id, entry]) => [String(id), entry]),
    );
    await this.d.session.set({ [TAB_MEMORY_KEY]: snapshot }).catch(() => {});
  }
}

function isRemembered(x: unknown): x is Remembered {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.containerId === "string" &&
    typeof r.url === "string" &&
    typeof r.title === "string" &&
    typeof r.windowId === "number" &&
    typeof r.index === "number"
  );
}
