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
  opts: { containers?: number; failTab?: number } = {},
) {
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
    createContainer: async (c) => void made.push(c),
    assignInPlace: async (tab, id) => {
      if (tab === opts.failTab) throw new Error("rules failed");
      assigned.push({ tab, id, how: "in place" });
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
});
