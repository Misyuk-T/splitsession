import { describe, expect, it } from "vitest";

import { SAVED_TABS_KEY } from "../../core";
import { SavedTabsStore } from "./saved-tabs-store";
import { MemoryStorageArea } from "./storage-area";

const tabs = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    url: `https://a.com/${i}`,
    title: `T${i}`,
  }));

describe("SavedTabsStore", () => {
  it("stores a set per container, survives a reload and clears it", async () => {
    const area = new MemoryStorageArea();
    const store = new SavedTabsStore(area);
    await store.load(() => true);
    await store.set("c1", tabs(3));
    expect(store.count("c1")).toBe(3);
    expect(store.count("c2")).toBe(0);

    const again = new SavedTabsStore(area);
    await again.load(() => true);
    expect(again.get("c1")).toEqual(tabs(3));
    expect(await again.clear("c1")).toBe(3);
    expect(again.count("c1")).toBe(0);
    expect(area.data.has(SAVED_TABS_KEY)).toBe(false); // nothing saved: no key
    expect(await again.clear("c1")).toBe(0);
  });

  it("keeps web addresses only, at most 50, and an empty set removes the entry", async () => {
    const store = new SavedTabsStore(new MemoryStorageArea());
    await store.load(() => true);
    await store.set("c", [
      ...tabs(60),
      { url: "chrome://settings", title: "" },
    ]);
    expect(store.count("c")).toBe(50);
    await store.set("c", [{ url: "about:blank", title: "" }]);
    expect(store.count("c")).toBe(0);
  });

  it("drops the sets of containers that no longer exist when it loads", async () => {
    const area = new MemoryStorageArea();
    const first = new SavedTabsStore(area);
    await first.load(() => true);
    await first.set("keep", tabs(2));
    await first.set("gone", tabs(2));
    const second = new SavedTabsStore(area);
    await second.load((id) => id === "keep");
    expect(second.count("keep")).toBe(2);
    expect(second.count("gone")).toBe(0);
    expect(Object.keys(area.data.get(SAVED_TABS_KEY) as object)).toEqual([
      "keep",
    ]);
  });

  it("ignores a malformed value in storage", async () => {
    const area = new MemoryStorageArea();
    await area.set({ [SAVED_TABS_KEY]: ["not", "an", "object"] });
    const store = new SavedTabsStore(area);
    await store.load(() => true);
    expect(store.count("0")).toBe(0);
  });

  it("clearAll forgets every set", async () => {
    const store = new SavedTabsStore(new MemoryStorageArea());
    await store.load(() => true);
    await store.set("a", tabs(1));
    await store.set("b", tabs(1));
    await store.clearAll();
    expect(store.count("a") + store.count("b")).toBe(0);
  });
});
