import { describe, expect, it } from "vitest";

import { type GroupSnapshot, groupTitle } from "../core";
import { MemoryStorageArea } from "../engine/storage/storage-area";
import {
  GroupRestore,
  type GroupRestoreDeps,
  type RestoreTab,
} from "./group-restore";

function setup(
  groups: GroupSnapshot[],
  tabs: Record<number, RestoreTab[]>,
  opts: {
    containers?: number;
    failTab?: number;
    /** Runs when a tab is assigned in place, to change what the tab looks like next (a navigation that began meanwhile). */
    onAssignInPlace?: (tab: number, live: Map<number, RestoreTab>) => void;
  } = {},
) {
  // What Chrome says about each tab now; `tabsOf` is the list taken earlier, and tests change this one behind its back.
  const live = new Map<number, RestoreTab>();
  for (const [groupId, list] of Object.entries(tabs))
    for (const t of list) live.set(t.id!, { ...t, groupId: Number(groupId) });
  const area = new MemoryStorageArea();
  const made: Array<{ id: string; name: string; color: string }> = [];
  const assigned: Array<{
    tab: number;
    id: string;
    how: "in place" | "reopened";
    url?: string;
  }> = [];
  let adopted = 0;
  const deps: GroupRestoreDeps = {
    area,
    containerCount: () => (opts.containers ?? 0) + made.length,
    groups: async () => groups,
    tabsOf: async (id) => tabs[id] ?? [],
    tab: async (id) => live.get(id) ?? null,
    createContainer: async (c) => void made.push(c),
    assignInPlace: async (tab, id) => {
      if (tab === opts.failTab) throw new Error("rules failed");
      assigned.push({ tab, id, how: "in place" });
      opts.onAssignInPlace?.(tab, live);
    },
    reopen: async (tab, id, url) => {
      if (tab === opts.failTab) throw new Error("rules failed");
      assigned.push({ tab, id, how: "reopened", url });
      return tab + 1000;
    },
    adopt: async () => void adopted++,
    log: () => {},
  };
  return {
    restore: new GroupRestore(deps),
    area,
    made,
    assigned,
    adopted: () => adopted,
    live,
  };
}

const g = (id: number, name: string, marker: string, color = "blue") => ({
  id,
  windowId: 1,
  title: groupTitle(name, marker),
  color,
});

describe("GroupRestore", () => {
  it("offers the marked groups only, and only without containers", async () => {
    const groups = [
      g(1, "main", "aaa111"),
      { id: 2, windowId: 1, title: "⧉ fake", color: "red" },
    ];
    expect(await setup(groups, {}).restore.offer()).toEqual({
      containers: 1,
      groups: 1,
    });
    expect(
      await setup(groups, {}, { containers: 2 }).restore.offer(),
    ).toBeNull();
    expect(await setup([groups[1]!], {}).restore.offer()).toBeNull();
  });

  it("dismiss is remembered and ends the offer", async () => {
    const s = setup([g(1, "main", "aaa111")], {});
    expect(await s.restore.offer()).not.toBeNull();
    await s.restore.dismiss();
    expect(await s.restore.offer()).toBeNull();
    await expect(s.restore.restore()).rejects.toThrow();
  });

  it("creates the containers under the marker IDs and assigns the tabs: loaded websites are reopened in a fresh tab, the rest are assigned in place", async () => {
    const s = setup(
      [g(1, "main", "aaa111"), g(2, "secondline", "bbb222", "cyan")],
      {
        1: [
          { id: 11, url: "https://a.example/" },
          { id: 12, url: "https://b.example/", discarded: true },
          { id: 13, url: "https://c.example/", status: "unloaded" },
          { id: 14, url: "chrome://newtab/" },
        ],
        2: [{ id: 21, url: "https://d.example/" }],
      },
    );
    expect(await s.restore.restore()).toEqual({
      containers: 2,
      tabs: 5,
      failed: 0,
    });
    expect(s.made).toEqual([
      { id: "aaa111", name: "main", color: "blue" },
      { id: "bbb222", name: "secondline", color: "turquoise" },
    ]);
    expect(s.assigned).toEqual([
      { tab: 11, id: "aaa111", how: "reopened", url: "https://a.example/" },
      { tab: 12, id: "aaa111", how: "in place" },
      { tab: 13, id: "aaa111", how: "in place" },
      { tab: 14, id: "aaa111", how: "in place" },
      { tab: 21, id: "bbb222", how: "reopened", url: "https://d.example/" },
    ]);
    expect(s.adopted()).toBe(2); // after each container, before its tabs move
    expect(await s.restore.offer()).toBeNull();
  });

  it("counts a tab that cannot be assigned and goes on", async () => {
    const s = setup(
      [g(1, "main", "aaa111")],
      {
        1: [
          { id: 11, url: "https://a.example/" },
          { id: 12, url: "https://b.example/" },
        ],
      },
      { failTab: 11 },
    );
    expect(await s.restore.restore()).toEqual({
      containers: 1,
      tabs: 1,
      failed: 1,
    });
  });

  it("refuses when containers exist", async () => {
    const s = setup([g(1, "main", "aaa111")], {}, { containers: 1 });
    await expect(s.restore.restore()).rejects.toThrow(/no tab groups/);
    expect(s.made).toEqual([]);
  });

  describe("what happened to a tab after the list was taken", () => {
    const one = (tab: RestoreTab, opts: Parameters<typeof setup>[2] = {}) =>
      setup([g(1, "main", "aaa111")], { 1: [tab] }, opts);

    it("a tab that loaded meanwhile is reopened, not assigned in place", async () => {
      const s = one({ id: 11, url: "https://a.example/", status: "unloaded" });
      s.live.set(11, {
        id: 11,
        groupId: 1,
        url: "https://a.example/",
        status: "complete",
      });
      expect(await s.restore.restore()).toMatchObject({ tabs: 1, failed: 0 });
      expect(s.assigned).toEqual([
        { tab: 11, id: "aaa111", how: "reopened", url: "https://a.example/" },
      ]);
    });

    it("a discarded tab that was reloaded meanwhile (discarded flag gone) is reopened", async () => {
      const s = one({ id: 11, url: "https://a.example/", discarded: true });
      s.live.set(11, {
        id: 11,
        groupId: 1,
        url: "https://a.example/",
        status: "loading",
        discarded: false,
      });
      await s.restore.restore();
      expect(s.assigned.map((a) => a.how)).toEqual(["reopened"]);
    });

    it("a navigation that began while the tab was being assigned: assigned, then reopened", async () => {
      const s = one(
        { id: 11, url: "https://a.example/", discarded: true },
        {
          onAssignInPlace: (tab, live) =>
            live.set(tab, {
              id: tab,
              groupId: 1,
              url: "https://a.example/",
              pendingUrl: "https://a.example/next",
              status: "loading",
              discarded: false,
            }),
        },
      );
      expect(await s.restore.restore()).toMatchObject({ tabs: 1, failed: 0 });
      expect(s.assigned).toEqual([
        { tab: 11, id: "aaa111", how: "in place" },
        {
          tab: 11,
          id: "aaa111",
          how: "reopened",
          url: "https://a.example/next",
        },
      ]);
    });

    it("a tab that stayed unloaded is only assigned in place", async () => {
      const s = one({ id: 11, url: "https://a.example/", status: "unloaded" });
      await s.restore.restore();
      expect(s.assigned.map((a) => a.how)).toEqual(["in place"]);
    });

    it("a tab the user moved to another group is left to the group guard", async () => {
      const s = one({ id: 11, url: "https://a.example/" });
      s.live.get(11)!.groupId = 7;
      expect(await s.restore.restore()).toMatchObject({ tabs: 0, failed: 0 });
      expect(s.assigned).toEqual([]);
    });

    it("a tab that was ungrouped or closed meanwhile is skipped", async () => {
      const s = setup([g(1, "main", "aaa111")], {
        1: [
          { id: 11, url: "https://a.example/" },
          { id: 12, url: "https://b.example/" },
        ],
      });
      s.live.get(11)!.groupId = -1;
      s.live.delete(12);
      expect(await s.restore.restore()).toMatchObject({ tabs: 0, failed: 0 });
      expect(s.assigned).toEqual([]);
    });
  });
});
