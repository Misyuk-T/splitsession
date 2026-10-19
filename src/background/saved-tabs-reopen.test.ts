import { describe, expect, it } from "vitest";

import { SAVED_TABS_KEY } from "../core";
import { SavedTabsStore } from "../engine/storage/saved-tabs-store";
import { MemoryStorageArea } from "../engine/storage/storage-area";
import { SavedTabsReopener } from "./saved-tabs-reopen";

const five = Array.from({ length: 5 }, (_, i) => ({
  url: `https://a.com/${i + 1}`,
  title: `T${i + 1}`,
}));

async function setup() {
  const area = new MemoryStorageArea();
  const store = new SavedTabsStore(area);
  await store.load(() => true);
  await store.set("c", five);
  return { area, store, reopener: new SavedTabsReopener(store) };
}

const storedUrls = (area: MemoryStorageArea) =>
  (
    (
      (area.data.get(SAVED_TABS_KEY) as Record<
        string,
        Array<{ url: string }>
      >) ?? {}
    ).c ?? []
  ).map((t) => t.url);

describe("SavedTabsReopener", () => {
  it("opens every tab in order, the first one active, and leaves nothing saved", async () => {
    const { area, store, reopener } = await setup();
    const opened: Array<[string, boolean]> = [];
    const result = await reopener.reopen("c", async (tab, first) => {
      opened.push([tab.url, first]);
    });
    expect(result).toEqual({ opened: 5, failed: 0 });
    expect(opened.map(([u]) => u)).toEqual(five.map((t) => t.url));
    expect(opened.map(([, f]) => f)).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
    expect(store.count("c")).toBe(0);
    expect(storedUrls(area)).toEqual([]);
  });

  it("an interrupted reopening (the worker or browser dies half way) leaves the unopened rest saved, in storage too", async () => {
    const { area, store, reopener } = await setup();
    let calls = 0;
    void reopener.reopen("c", async () => {
      if (++calls === 3) await new Promise(() => {}); // never returns: the process is gone
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(3);
    expect(storedUrls(area)).toEqual([
      "https://a.com/3",
      "https://a.com/4",
      "https://a.com/5",
    ]);
    // A new worker reads the same storage and still has the rest.
    const next = new SavedTabsStore(area);
    await next.load(() => true);
    expect(next.get("c").map((t) => t.url)).toEqual(storedUrls(area));
    expect(store.count("c")).toBe(3);
  });

  it("two requests at once open the tabs once: the second gets the first's result", async () => {
    const { store, reopener } = await setup();
    const opened: string[] = [];
    const open = async (tab: { url: string }) => {
      opened.push(tab.url);
      await new Promise((r) => setTimeout(r, 2));
    };
    const [a, b] = await Promise.all([
      reopener.reopen("c", open),
      reopener.reopen("c", open),
    ]);
    expect(opened).toHaveLength(5);
    expect(a).toBe(b === a ? a : a); // same outcome
    expect(a).toEqual({ opened: 5, failed: 0 });
    expect(b).toEqual(a);
    expect(store.count("c")).toBe(0);
    // Once it is over, a later request starts anew (nothing saved: nothing opens).
    expect(await reopener.reopen("c", open)).toEqual({ opened: 0, failed: 0 });
    expect(opened).toHaveLength(5);
  });

  it("a tab that fails to open stays saved; the others open and go", async () => {
    const { store, reopener } = await setup();
    const result = await reopener.reopen("c", async (tab) => {
      if (tab.url.endsWith("/2") || tab.url.endsWith("/4"))
        throw new Error("no");
    });
    expect(result).toEqual({ opened: 3, failed: 2 });
    expect(store.get("c").map((t) => t.url)).toEqual([
      "https://a.com/2",
      "https://a.com/4",
    ]);
  });

  it("when nothing opens the error is thrown and the whole set stays", async () => {
    const { store, reopener } = await setup();
    await expect(
      reopener.reopen("c", async () => {
        throw new Error("window gone");
      }),
    ).rejects.toThrow("window gone");
    expect(store.count("c")).toBe(5);
    // The lock is released: a new try runs.
    expect(await reopener.reopen("c", async () => {})).toMatchObject({
      opened: 5,
    });
  });
});
