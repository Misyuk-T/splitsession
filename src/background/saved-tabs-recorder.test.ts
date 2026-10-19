import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BATCH_GAP_MS, type SavedTab } from "../core";
import { MemoryStorageArea } from "../engine/storage/storage-area";
import {
  SavedTabsRecorder,
  type SeenTab,
  WINDOW_CLOSE_GRACE_MS,
} from "./saved-tabs-recorder";

interface LiveTab extends SeenTab {
  id: number;
}

/** The browser and the engine's registry, as far as the recorder sees them. */
class World {
  live = new Map<number, LiveTab>();
  /** Tab id -> container (the engine's registry; closed tabs stay in it until `dropFromRegistry`). */
  registry = new Map<number, string>();
  windows = 1;
  enabled = true;
  names = new Map<string, string>([
    ["c1", "Work"],
    ["c2", "Home"],
  ]);

  saves: Array<[string, SavedTab[]]> = [];
  session = new MemoryStorageArea();
  recorder: SavedTabsRecorder;

  constructor() {
    this.recorder = this.makeRecorder();
  }

  makeRecorder(): SavedTabsRecorder {
    return new SavedTabsRecorder({
      session: this.session,
      queryTabs: async () => [...this.live.values()],
      windowCount: async () => this.windows,
      containerOf: (id) => this.registry.get(id),
      tabsOf: (c) =>
        [...this.registry].filter(([, v]) => v === c).map(([k]) => k),
      containerName: (c) => this.names.get(c),
      enabled: () => this.enabled,
      save: async (c, tabs) => void this.saves.push([c, tabs]),
      now: () => Date.now(),
    });
  }

  open(id: number, container: string, url: string, index = id, windowId = 1) {
    this.live.set(id, {
      id,
      url,
      title: `[${this.names.get(container)}] Title ${id}`,
      index,
      windowId,
    });
    this.registry.set(id, container);
  }

  /** The browser closes these tabs and tells the extension, `gap` ms apart. */
  async close(
    ids: number[],
    options: {
      windowClosing?: boolean;
      gap?: number;
      dropFromRegistry?: boolean;
    } = {},
  ) {
    for (const id of ids) {
      this.live.delete(id);
      if (options.dropFromRegistry) this.registry.delete(id);
      this.recorder.tabRemoved(id, options.windowClosing === true);
      await vi.advanceTimersByTimeAsync(options.gap ?? 20);
    }
  }

  get last(): SavedTab[] | undefined {
    return this.saves.at(-1)?.[1];
  }
}

const urls = (tabs: SavedTab[] | undefined) => tabs?.map((t) => t.url);

describe("SavedTabsRecorder", () => {
  let world: World;
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    world = new World();
    world.open(1, "c1", "https://a.com/1");
    world.open(2, "c1", "https://a.com/2");
    world.open(3, "c1", "https://a.com/3");
    await world.recorder.start();
  });
  afterEach(() => vi.useRealTimers());

  it("saves the tabs closed together when the container's last tab closes, in their order, without our marks in titles", async () => {
    await world.close([3, 1, 2]); // closed in another order than they stand
    expect(urls(world.last)).toEqual([
      "https://a.com/1",
      "https://a.com/2",
      "https://a.com/3",
    ]);
    expect(world.last![0]!.title).toBe("Title 1");
    expect(world.saves).toHaveLength(1);
  });

  it("does not save while the container still has a tab, even when the registry lags behind the closures", async () => {
    await world.close([1, 2]); // 3 stays
    expect(world.saves).toHaveLength(0);
    await world.close([3], { dropFromRegistry: true });
    expect(world.saves).toHaveLength(1);
  });

  it("closing one by one over time saves only the last batch", async () => {
    await world.close([1], { gap: 10_000 });
    await world.close([2], { gap: 10_000 });
    await world.close([3]);
    expect(urls(world.last)).toEqual(["https://a.com/3"]);
  });

  it("closures within the gap of each other are one batch; one gap longer is not", async () => {
    world.open(4, "c1", "https://a.com/4");
    await world.recorder.flush();
    await world.close([1], { gap: BATCH_GAP_MS - 100 });
    await world.close([2], { gap: BATCH_GAP_MS - 100 });
    await world.close([3], { gap: BATCH_GAP_MS + 100 });
    await world.close([4]);
    expect(urls(world.last)).toEqual(["https://a.com/4"]);
    expect(world.saves).toHaveLength(1);
  });

  it("skips tabs that are not web pages, and keeps the old set when nothing is left to save", async () => {
    world.open(4, "c2", "chrome-extension://x/held.html");
    world.open(5, "c2", "about:blank");
    world.open(6, "c2", "https://b.com/6");
    await world.recorder.flush();
    await world.close([4, 5, 6]);
    expect(world.saves).toEqual([
      ["c2", [{ url: "https://b.com/6", title: "Title 6" }]],
    ]);
    await vi.advanceTimersByTimeAsync(10_000);
    world.open(7, "c2", "chrome://settings");
    await world.recorder.flush();
    await world.close([7]);
    expect(world.saves).toHaveLength(1); // nothing savable: the set is not overwritten
  });

  it("keeps at most 50 tabs", async () => {
    for (let i = 10; i < 90; i++) world.open(i, "c2", `https://b.com/${i}`);
    await world.recorder.flush();
    await world.close(
      Array.from({ length: 80 }, (_, i) => 10 + i),
      { gap: 1 },
    );
    expect(world.last).toHaveLength(50);
    expect(world.last![0]!.url).toBe("https://b.com/10");
  });

  it("saves nothing when the setting is off", async () => {
    world.enabled = false;
    await world.close([1, 2, 3]);
    expect(world.saves).toHaveLength(0);
  });

  it("saves nothing for a container that was deleted", async () => {
    world.names.delete("c1");
    await world.close([1, 2, 3]);
    expect(world.saves).toHaveLength(0);
  });

  it("does not count tabs SplitSession closes while moving them elsewhere", async () => {
    world.recorder.willMove(3);
    await world.close([1, 2]);
    await world.close([3]);
    expect(urls(world.last)).toEqual(["https://a.com/1", "https://a.com/2"]);
    // A container whose only tab was moved away saves nothing.
    world.open(8, "c2", "https://b.com/8");
    await world.recorder.flush();
    world.recorder.willMove(8);
    await world.close([8]);
    expect(world.saves.some(([c]) => c === "c2")).toBe(false);
  });

  it("follows a navigation: the address at the time of closing is saved", async () => {
    world.recorder.tabUpdated({
      id: 2,
      url: "https://a.com/moved",
      title: "[Work] New title",
      index: 1,
      windowId: 1,
    });
    await world.close([1, 2, 3]);
    expect(world.last![1]).toEqual({
      url: "https://a.com/moved",
      title: "New title",
    });
  });

  it("a tab that had not committed an address yet keeps the one it showed before", async () => {
    world.recorder.tabUpdated({
      id: 2,
      url: "about:blank",
      title: "",
      index: 1,
      windowId: 1,
    });
    await world.close([1, 2, 3]);
    expect(world.last![1]!.url).toBe("https://a.com/2");
  });

  it("remembers positions from before the closing started, not from the shifting list", async () => {
    // Tab 1 closes first; the others' positions shift, and an update of tab 3 reports its new position.
    await world.close([1], { gap: 50 });
    world.recorder.tabUpdated({
      id: 3,
      url: "https://a.com/3",
      title: "T",
      index: 1,
      windowId: 1,
    });
    await world.close([2, 3]);
    expect(urls(world.last)).toEqual([
      "https://a.com/1",
      "https://a.com/2",
      "https://a.com/3",
    ]);
  });

  it("a set reopened and closed again within the gap is saved once, not twice", async () => {
    world.open(4, "c2", "https://b.com/1");
    world.open(5, "c2", "https://b.com/2");
    await world.recorder.flush();
    await world.close([4, 5]);
    expect(urls(world.last)).toEqual(["https://b.com/1", "https://b.com/2"]);
    // Reopened (new tab ids, same addresses; each assignment begins a new cycle), closed again 0.4 s after the first closing.
    world.open(14, "c2", "https://b.com/1");
    world.recorder.tabAssigned("c2");
    world.open(15, "c2", "https://b.com/2");
    world.recorder.tabAssigned("c2");
    await vi.advanceTimersByTimeAsync(100);
    await world.recorder.flush();
    await world.close([14, 15]);
    expect(urls(world.last)).toEqual(["https://b.com/1", "https://b.com/2"]);
  });

  it("without the cycle reset, the same addresses are still saved once", async () => {
    world.open(4, "c2", "https://b.com/1");
    world.open(5, "c2", "https://b.com/2");
    await world.recorder.flush();
    await world.close([4, 5]);
    world.open(14, "c2", "https://b.com/1");
    world.open(15, "c2", "https://b.com/2");
    await world.recorder.flush();
    await world.close([14, 15]);
    expect(urls(world.last)).toEqual(["https://b.com/1", "https://b.com/2"]);
  });

  describe("browser shutdown", () => {
    it("a window close is saved after the grace period, when a window is left", async () => {
      world.windows = 1;
      await world.close([1, 2, 3], { windowClosing: true });
      expect(world.saves).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(WINDOW_CLOSE_GRACE_MS + 50);
      expect(urls(world.last)).toHaveLength(3);
    });

    it("the last window closing (the browser quitting) saves nothing", async () => {
      world.windows = 0;
      await world.close([1, 2, 3], { windowClosing: true });
      await vi.advanceTimersByTimeAsync(WINDOW_CLOSE_GRACE_MS + 50);
      expect(world.saves).toHaveLength(0);
    });

    it("a worker that dies with the browser never saves", async () => {
      await world.close([1, 2, 3], { windowClosing: true });
      // The worker is gone before the grace period ends: its timer never fires.
      vi.clearAllTimers();
      await vi.advanceTimersByTimeAsync(WINDOW_CLOSE_GRACE_MS * 2);
      expect(world.saves).toHaveLength(0);
    });

    it("a tab that came back during the grace period cancels the save", async () => {
      await world.close([1, 2, 3], { windowClosing: true });
      world.open(9, "c1", "https://a.com/9");
      await vi.advanceTimersByTimeAsync(WINDOW_CLOSE_GRACE_MS + 50);
      expect(world.saves).toHaveLength(0);
    });

    it("tabs closed one window at a time: the window that closes last decides", async () => {
      world.open(4, "c1", "https://a.com/4", 0, 2);
      await world.recorder.flush();
      await world.close([4], { windowClosing: true, gap: 5_000 });
      expect(world.saves).toHaveLength(0); // the container still has tabs in window 1
      await world.close([1, 2, 3]);
      expect(urls(world.last)).toEqual([
        "https://a.com/1",
        "https://a.com/2",
        "https://a.com/3",
      ]);
    });
  });

  it("knows a tab that closed while the worker slept (memory survives in session storage)", async () => {
    await world.recorder.flush();
    // A new worker: nothing in memory, the session storage has the tabs.
    world.recorder = world.makeRecorder();
    await world.recorder.start();
    // The tabs were closed while it slept and the engine's registry already forgot them.
    world.live.clear();
    world.registry.clear();
    for (const id of [1, 2, 3]) world.recorder.tabRemoved(id, false);
    await vi.advanceTimersByTimeAsync(50);
    // Tabs 1 and 2 may have been judged on their own first; the final set is the whole batch.
    expect(urls(world.last)).toEqual([
      "https://a.com/1",
      "https://a.com/2",
      "https://a.com/3",
    ]);
  });
});
