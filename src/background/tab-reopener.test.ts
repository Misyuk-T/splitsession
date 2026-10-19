import { describe, expect, it } from "vitest";

import { TabReopener, type TabReopenerDeps } from "./tab-reopener";

/** Two callers (the group guard, the restore) on one tab; each replacement creates a tab and each removal closes one. */
function setup(opts: { failFirst?: boolean } = {}) {
  const created: number[] = [];
  const removed: number[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let calls = 0;
  const deps: TabReopenerDeps = {
    replaceTab: async (tabId) => {
      calls++;
      await gate; // the first move is still under way when the second caller arrives
      if (opts.failFirst && calls === 1) throw new Error("rules failed");
      const fresh = 1000 + created.length;
      created.push(fresh);
      return fresh + tabId * 0;
    },
    groupsIdle: async () => {},
    removeTab: async (tabId) => void removed.push(tabId),
  };
  return { reopener: new TabReopener(deps), created, removed, release };
}

describe("TabReopener", () => {
  it("one move per original tab: a second caller gets the first one's result, one tab is created and one closed", async () => {
    const s = setup();
    const guard = s.reopener.reopen(5, "aaa111", "https://a.example/");
    const restore = s.reopener.reopen(5, "aaa111", "https://a.example/");
    s.release();
    expect(await guard).toBe(1000);
    expect(await restore).toBe(1000);
    expect(s.created).toEqual([1000]);
    expect(s.removed).toEqual([5]);
  });

  it("different tabs are moved independently", async () => {
    const s = setup();
    const a = s.reopener.reopen(5, "aaa111", "https://a.example/");
    const b = s.reopener.reopen(6, "aaa111", "https://b.example/");
    s.release();
    await Promise.all([a, b]);
    expect(s.created).toHaveLength(2);
    expect(s.removed.sort()).toEqual([5, 6]);
  });

  it("forgets a move once it is over, and after a failure the tab can be tried again", async () => {
    const s = setup({ failFirst: true });
    const first = s.reopener.reopen(5, "aaa111", "https://a.example/");
    s.release();
    await expect(first).rejects.toThrow("rules failed");
    expect(s.removed).toEqual([]);
    expect(await s.reopener.reopen(5, "aaa111", "https://a.example/")).toBe(
      1000,
    );
    expect(s.removed).toEqual([5]);
  });
});
