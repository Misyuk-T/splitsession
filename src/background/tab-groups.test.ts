import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type Container,
  decodeGroupMarker,
  groupMarker,
  groupTitle,
  type Settings,
} from "../core";
import { MemoryStorageArea } from "../engine/storage/storage-area";
import {
  BLINK_MS,
  type GroupTab,
  OWNED_GROUPS_KEY,
  TabGroupProjection,
} from "./tab-groups";

/** Just enough of chrome.tabs / chrome.tabGroups: groups live in windows and vanish when empty. */
class FakeChrome {
  tabs = new Map<number, GroupTab>();
  groups = new Map<
    number,
    { id: number; windowId: number; title?: string; color: string }
  >();

  nextGroup = 100;
  failNextGroupCalls = 0;
  failNextUngroupCalls = 0;
  calls: string[] = [];

  addTab(id: number, windowId = 1, extra: Partial<GroupTab> = {}): void {
    this.tabs.set(id, { id, windowId, groupId: -1, pinned: false, ...extra });
  }

  /** Chrome moves the two tabs of a split view together: grouping or ungrouping one does it to both. */
  private withSplit(ids: number[]): number[] {
    const out = new Set(ids);
    for (const id of ids) {
      const split = this.tabs.get(id)?.splitViewId;
      if (split === undefined || split === -1) continue;
      for (const t of this.tabs.values())
        if (t.splitViewId === split) out.add(t.id!);
    }
    return [...out];
  }

  private prune(): void {
    for (const g of [...this.groups.keys()])
      if (![...this.tabs.values()].some((t) => t.groupId === g))
        this.groups.delete(g);
  }

  api = {
    tabs: {
      get: async (id: number) => {
        const tab = this.tabs.get(id);
        if (!tab) throw new Error("No tab with id");
        return { ...tab };
      },
      group: async ({
        tabIds,
        groupId,
        createProperties,
      }: {
        tabIds: number[];
        groupId?: number;
        createProperties?: { windowId: number };
      }) => {
        this.calls.push(`group ${tabIds.join(",")} ${groupId ?? "new"}`);
        if (this.failNextGroupCalls > 0) {
          this.failNextGroupCalls--;
          throw new Error(
            "Tabs cannot be edited right now (user may be dragging a tab).",
          );
        }
        let id = groupId;
        if (id === undefined) {
          id = this.nextGroup++;
          this.groups.set(id, {
            id,
            windowId:
              createProperties?.windowId ?? this.tabs.get(tabIds[0]!)!.windowId,
            color: "grey",
          });
        }
        for (const t of this.withSplit(tabIds)) this.tabs.get(t)!.groupId = id;
        this.prune();
        return id;
      },
      ungroup: async (ids: number[]) => {
        this.calls.push(`ungroup ${ids.join(",")}`);
        if (this.failNextUngroupCalls > 0) {
          this.failNextUngroupCalls--;
          throw new Error(
            "Tabs cannot be edited right now (user may be dragging a tab).",
          );
        }
        for (const t of this.withSplit(ids)) this.tabs.get(t)!.groupId = -1;
        this.prune();
      },
      query: async ({
        groupId,
        splitViewId,
      }: {
        groupId?: number;
        splitViewId?: number;
      }) =>
        [...this.tabs.values()]
          .filter((t) =>
            splitViewId !== undefined
              ? t.splitViewId === splitViewId
              : t.groupId === groupId,
          )
          .map((t) => ({ ...t })),
    },
    tabGroups: {
      get: async (id: number) => {
        const g = this.groups.get(id);
        if (!g) throw new Error("No group with id");
        return { ...g };
      },
      update: async (id: number, props: { title?: string; color?: string }) => {
        const g = this.groups.get(id);
        if (!g) throw new Error("No group with id");
        Object.assign(g, props);
      },
    },
  };
}

const containers = new Map<string, Container>([
  ["work", { id: "work", name: "Work", color: "blue", createdAt: 1 }],
  ["home", { id: "home", name: "Home", color: "turquoise", createdAt: 2 }],
]);

function setup(settings: Partial<Settings> = {}) {
  const chrome = new FakeChrome();
  const book = new Map([...containers].map(([id, c]) => [id, { ...c }]));
  const logs: Array<[string, string]> = [];
  const area = new MemoryStorageArea();
  const assigned: Array<{ tabId: number; containerId: string }> = [];
  const state = {
    tabGroups: true,
    titlePrefix: true,
    strictMode: true,
    showNameToPages: true,
    agentBridge: false,
    agentActivity: true,
    restoreTabs: true,
    markOutsideGroup: true,
    rememberTabs: true,
    ...settings,
  };
  const projection = new TabGroupProjection({
    tabs: chrome.api.tabs,
    tabGroups: chrome.api.tabGroups,
    area,
    settings: () => state,
    container: (id) => book.get(id),
    containers: () => [...book.values()],
    updateContainer: async (id, patch) => {
      const c = book.get(id);
      if (!c) throw new Error("no container");
      Object.assign(c, patch);
      void projection.containerUpdated(c); // what the engine's "container-updated" event does
    },
    containerTabs: () => assigned,
    log: (level, message) => void logs.push([level, message]),
    delay: async () => {},
    editSettleMs: 0,
  });
  const assign = async (tabId: number, containerId: string) => {
    assigned.push({ tabId, containerId });
    await projection.tabAssigned(tabId, containerId);
  };
  return { chrome, area, projection, assign, state, assigned, book, logs };
}

describe("TabGroupProjection", () => {
  it("makes one titled, coloured group per container and window, and reuses it", async () => {
    const { chrome, assign, projection } = setup();
    chrome.addTab(1);
    chrome.addTab(2);
    chrome.addTab(3);
    chrome.addTab(4, 2); // another window
    await assign(1, "work");
    await assign(2, "work");
    await assign(3, "home");
    await assign(4, "work");
    const g = (id: number) => chrome.tabs.get(id)!.groupId;
    expect(g(1)).toBe(g(2));
    expect(g(3)).not.toBe(g(1));
    expect(g(4)).not.toBe(g(1));
    expect(chrome.groups.get(g(1))).toMatchObject({
      title: groupTitle("Work", "work"),
      color: "blue",
      windowId: 1,
    });
    expect(chrome.groups.get(g(3))).toMatchObject({
      title: groupTitle("Home", "home"),
      color: "cyan",
    });
    expect(chrome.groups.get(g(4))).toMatchObject({
      title: groupTitle("Work", "work"),
      windowId: 2,
    });
    expect(chrome.groups.size).toBe(3);
    expect(projection.ownedGroups()).toHaveLength(3);
  });

  it("does nothing while the setting is off, and for pinned or closed tabs", async () => {
    const off = setup({ tabGroups: false });
    off.chrome.addTab(1);
    await off.assign(1, "work");
    expect(off.chrome.groups.size).toBe(0);

    const on = setup();
    on.chrome.addTab(1, 1, { pinned: true });
    await on.assign(1, "work");
    await on.assign(99, "work"); // never existed
    expect(on.chrome.groups.size).toBe(0);
  });

  it("serialises concurrent assignments: two tabs arriving together share one new group", async () => {
    const { chrome, projection } = setup();
    chrome.addTab(1);
    chrome.addTab(2);
    await Promise.all([
      projection.tabAssigned(1, "work"),
      projection.tabAssigned(2, "work"),
    ]);
    expect(chrome.groups.size).toBe(1);
    expect(chrome.tabs.get(1)!.groupId).toBe(chrome.tabs.get(2)!.groupId);
  });

  it("never pulls a tab back: only assignment, re-group and setting changes regroup", async () => {
    const { chrome, assign, projection } = setup();
    chrome.addTab(1);
    chrome.addTab(2);
    await assign(1, "work");
    await assign(2, "work");
    await chrome.api.tabs.ungroup([1]); // the user drags it out
    await projection.containerUpdated(containers.get("work")!); // unrelated housekeeping
    await projection.groupRemoved(12345);
    expect(chrome.tabs.get(1)!.groupId).toBe(-1);
    // Explicit re-group puts it back.
    await projection.reconcileAll();
    expect(chrome.tabs.get(1)!.groupId).toBe(chrome.tabs.get(2)!.groupId);
    expect(chrome.groups.size).toBe(1);
  });

  it("a tab the user put in somebody else's group stays there until re-group", async () => {
    const { chrome, assign, projection } = setup();
    chrome.addTab(1);
    chrome.addTab(2);
    chrome.addTab(3);
    await assign(1, "work");
    await assign(2, "home");
    await chrome.api.tabs.group({
      tabIds: [1],
      groupId: chrome.tabs.get(2)!.groupId,
    }); // Work tab dragged into Home's group
    expect(chrome.tabs.get(1)!.groupId).toBe(chrome.tabs.get(2)!.groupId);
    await assign(3, "work"); // a new Work tab: gets a Work group (the old one is gone: it was empty)
    expect(chrome.groups.get(chrome.tabs.get(3)!.groupId)).toMatchObject({
      title: groupTitle("Work", "work"),
    });
    expect(chrome.tabs.get(1)!.groupId).toBe(chrome.tabs.get(2)!.groupId);
    await projection.reconcileAll();
    expect(chrome.tabs.get(1)!.groupId).toBe(chrome.tabs.get(3)!.groupId);
  });

  it("renames and recolours the groups of a container", async () => {
    const { chrome, assign, projection } = setup();
    chrome.addTab(1);
    await assign(1, "work");
    await projection.containerUpdated({
      id: "work",
      name: "Job",
      color: "red",
      createdAt: 1,
    });
    expect(chrome.groups.get(chrome.tabs.get(1)!.groupId)).toMatchObject({
      title: groupTitle("Job", "work"),
      color: "red",
    });
  });

  it("takes a tab that left its container out of our group, but not out of the user's", async () => {
    const { chrome, assign, projection } = setup();
    chrome.addTab(1);
    chrome.addTab(2);
    await assign(1, "work");
    await projection.tabUnassigned(1, "work");
    expect(chrome.tabs.get(1)!.groupId).toBe(-1);
    const own = await chrome.api.tabs.group({ tabIds: [2] }); // a group the user made
    await projection.tabUnassigned(2, "work");
    expect(chrome.tabs.get(2)!.groupId).toBe(own);
    await projection.tabUnassigned(404, "work"); // closed tab: no error
  });

  it("releaseAll ungroups only what it made; reconcileAll groups again", async () => {
    const { chrome, assign, projection, state } = setup();
    chrome.addTab(1);
    chrome.addTab(2);
    chrome.addTab(3);
    await assign(1, "work");
    await assign(2, "home");
    const own = await chrome.api.tabs.group({ tabIds: [3] });
    state.tabGroups = false;
    await projection.releaseAll();
    expect(chrome.tabs.get(1)!.groupId).toBe(-1);
    expect(chrome.tabs.get(2)!.groupId).toBe(-1);
    expect(chrome.tabs.get(3)!.groupId).toBe(own);
    expect(projection.ownedGroups()).toEqual([]);
    state.tabGroups = true;
    await projection.reconcileAll();
    expect(chrome.tabs.get(1)!.groupId).toBeGreaterThanOrEqual(0);
    expect(chrome.groups.size).toBe(3);
  });

  it("retries while Chrome refuses edits during a drag, and gives up with a logged failure", async () => {
    const { chrome, projection } = setup();
    chrome.addTab(1);
    chrome.failNextGroupCalls = 3;
    await projection.tabAssigned(1, "work");
    expect(chrome.tabs.get(1)!.groupId).toBeGreaterThanOrEqual(0);

    chrome.addTab(2);
    chrome.failNextGroupCalls = 99;
    await projection.tabAssigned(2, "home"); // swallowed by the queue: never rejects
    expect(chrome.tabs.get(2)!.groupId).toBe(-1);
  });

  it("forgets groups that no longer exist and survives a worker restart through storage", async () => {
    const { chrome, area, assign, projection } = setup();
    chrome.addTab(1);
    await assign(1, "work");
    const groupId = chrome.tabs.get(1)!.groupId;
    expect((await area.get(OWNED_GROUPS_KEY))[OWNED_GROUPS_KEY]).toEqual({
      [groupId]: "work",
    });

    // "Restart": a new instance over the same storage finds its group again instead of making a second one.
    const again = new TabGroupProjection({
      tabs: chrome.api.tabs,
      tabGroups: chrome.api.tabGroups,
      area,
      settings: () => ({
        tabGroups: true,
        titlePrefix: true,
        strictMode: true,
        showNameToPages: true,
        agentBridge: false,
        agentActivity: true,
        restoreTabs: true,
        markOutsideGroup: true,
        rememberTabs: true,
      }),
      container: (id) => containers.get(id),
      containers: () => [...containers.values()],
      updateContainer: async () => {},
      containerTabs: () => [],
      log: () => {},
      delay: async () => {},
    });
    await again.load();
    chrome.addTab(2);
    await again.tabAssigned(2, "work");
    expect(chrome.tabs.get(2)!.groupId).toBe(groupId);

    // The group disappears (both tabs closed): the next assignment makes a fresh one and the stale entry is dropped.
    chrome.tabs.delete(1);
    chrome.tabs.delete(2);
    chrome.groups.delete(groupId);
    chrome.addTab(3);
    await again.tabAssigned(3, "work");
    expect(chrome.tabs.get(3)!.groupId).not.toBe(groupId);
    expect(again.ownedGroups().map(([id]) => id)).toEqual([
      chrome.tabs.get(3)!.groupId,
    ]);
    await projection.groupRemoved(chrome.tabs.get(3)!.groupId);
  });

  it("containerDeleted drops its groups from the books", async () => {
    const { chrome, assign, projection } = setup();
    chrome.addTab(1);
    await assign(1, "work");
    await projection.containerDeleted("work");
    expect(projection.ownedGroups()).toEqual([]);
  });

  it("takes over a group Chrome brought back with the container marker, not a look-alike the user made", async () => {
    const { chrome, assign, projection } = setup();
    // Session restore: a group with Work's marker, unknown to this (fresh) projection, holding tab 1.
    chrome.groups.set(500, {
      id: 500,
      windowId: 1,
      title: groupTitle("Work", "work"),
      color: "blue",
    });
    chrome.addTab(1, 1, { groupId: 500 });
    chrome.addTab(2);
    await assign(1, "work");
    await assign(2, "work");
    expect(chrome.tabs.get(1)!.groupId).toBe(500);
    expect(chrome.tabs.get(2)!.groupId).toBe(500);
    expect(projection.ownedGroups()).toEqual([[500, "work"]]);
    // The user's own group called "Home", without the marker: the tab leaves it for SplitSession's own group.
    chrome.groups.set(600, {
      id: 600,
      windowId: 1,
      title: "Home",
      color: "cyan",
    });
    chrome.addTab(3, 1, { groupId: 600 });
    await assign(3, "home");
    expect(chrome.tabs.get(3)!.groupId).not.toBe(600);
    expect(chrome.groups.get(chrome.tabs.get(3)!.groupId)).toMatchObject({
      title: groupTitle("Home", "home"),
    });
  });
  it("tells which container a group stands for from its marker, and takes over a marked group it did not make", async () => {
    const { chrome, projection } = setup();
    chrome.addTab(1);
    chrome.groups.set(50, {
      id: 50,
      windowId: 1,
      title: groupTitle("Work", "work"),
      color: "blue",
    });
    chrome.groups.set(51, {
      id: 51,
      windowId: 1,
      title: "Work",
      color: "blue",
    }); // typed by hand: no marker
    chrome.groups.set(52, {
      id: 52,
      windowId: 1,
      title: groupTitle("Gone", "deleted"),
      color: "blue",
    });
    expect(await projection.containerOfGroup(50)).toBe("work");
    expect(projection.ownedGroups()).toEqual([[50, "work"]]);
    expect(await projection.containerOfGroup(51)).toBeNull();
    expect(await projection.containerOfGroup(52)).toBeNull(); // no such container any more
    expect(await projection.containerOfGroup(404)).toBeNull();
    expect(projection.ownedGroups()).toEqual([[50, "work"]]);
  });

  it("placeOwn reports a refusal that outlasts the retries (a long drag) and then works when asked again; the queue keeps going", async () => {
    const { chrome, projection, assigned } = setup();
    chrome.groups.set(50, {
      id: 50,
      windowId: 1,
      title: groupTitle("Work", "work"),
      color: "blue",
    });
    chrome.addTab(1, 1, { groupId: 50 });
    chrome.addTab(9, 1, { groupId: 50 });
    assigned.push({ tabId: 1, containerId: "home" });
    chrome.failNextGroupCalls = 6; // every retry of one call
    await expect(projection.placeOwn(1, "home")).rejects.toThrow(/dragging/);
    expect(chrome.tabs.get(1)!.groupId).toBe(50);
    await projection.idle();
    await projection.placeOwn(1, "home");
    expect(chrome.groups.get(chrome.tabs.get(1)!.groupId)).toMatchObject({
      title: groupTitle("Home", "home"),
    });
  });

  it("never leaves a tab in a group that names another container: placeOwn regroups or ungroups, also with groups off", async () => {
    const { chrome, projection, assigned } = setup();
    chrome.groups.set(50, {
      id: 50,
      windowId: 1,
      title: groupTitle("Work", "work"),
      color: "blue",
    });
    chrome.groups.set(60, { id: 60, windowId: 1, title: "Mine", color: "red" });
    chrome.addTab(1, 1, { groupId: 50 });
    chrome.addTab(2, 1, { groupId: 50 });
    chrome.addTab(3, 1, { groupId: 60 });
    chrome.addTab(9, 1, { groupId: 50 });
    // A tab SplitSession opened in Home landed inside Work's group: into Home's group.
    assigned.push({ tabId: 1, containerId: "home" });
    await projection.placeOwn(1, "home");
    expect(chrome.groups.get(chrome.tabs.get(1)!.groupId)).toMatchObject({
      title: groupTitle("Home", "home"),
    });
    // A plain one: out of the group. In a group of the user's: left there.
    await projection.placeOwn(2, null);
    expect(chrome.tabs.get(2)!.groupId).toBe(-1);
    await projection.placeOwn(3, null);
    expect(chrome.tabs.get(3)!.groupId).toBe(60);

    const off = setup({ tabGroups: false });
    off.chrome.groups.set(50, {
      id: 50,
      windowId: 1,
      title: groupTitle("Work", "work"),
      color: "blue",
    });
    off.chrome.addTab(1, 1, { groupId: 50 });
    off.chrome.addTab(2, 1, { groupId: 50 });
    off.chrome.addTab(3, 1, { groupId: 50 });
    off.chrome.addTab(9, 1, { groupId: 50 });
    await off.assign(1, "home"); // assigned elsewhere (the popup's "Move here"): leaves Work's group
    await off.assign(2, "work"); // its own container's group: stays
    expect(off.chrome.tabs.get(1)!.groupId).toBe(-1);
    expect(off.chrome.tabs.get(2)!.groupId).toBe(50);
    await off.projection.tabUnassigned(2, "work"); // left its container: out of the marked group
    expect(off.chrome.tabs.get(2)!.groupId).toBe(-1);
    expect(off.chrome.groups.size).toBe(1);
  });

  describe("two-way sync with Chrome's group editor", () => {
    async function twoWindows() {
      const t = setup();
      t.chrome.addTab(1);
      t.chrome.addTab(2, 2);
      t.chrome.addTab(3);
      await t.assign(1, "work");
      await t.assign(2, "work");
      await t.assign(3, "home");
      const gid = (tab: number) => t.chrome.tabs.get(tab)!.groupId;
      const edit = async (
        tab: number,
        props: { title?: string; color?: string },
      ) => {
        const id = gid(tab);
        await t.chrome.api.tabGroups.update(id, props);
        await t.projection.groupUpdated({ ...t.chrome.groups.get(id)! });
        await t.projection.idle();
      };
      return { ...t, gid, edit };
    }

    it("titles carry the glyph and the marker", async () => {
      const { chrome, gid } = await twoWindows();
      expect(chrome.groups.get(gid(1))!.title).toMatch(/^⧉ Work/);
    });

    it("a rename in the editor renames the container and every group of it, glyph re-applied", async () => {
      const { chrome, book, gid, edit, logs } = await twoWindows();
      await edit(1, { title: "⧉ Job" });
      expect(book.get("work")!.name).toBe("Job");
      expect(chrome.groups.get(gid(1))!.title).toBe(groupTitle("Job", "work"));
      expect(chrome.groups.get(gid(2))!.title).toBe(groupTitle("Job", "work")); // the other window
      expect(
        logs.some(
          ([l, m]) => l === "info" && /changed from its tab group/.test(m),
        ),
      ).toBe(true);
    });

    it("a name typed without the glyph (and without the marker) is accepted and the glyph and marker come back", async () => {
      const { chrome, book, gid, edit } = await twoWindows();
      await edit(1, { title: "  Job   two " });
      expect(book.get("work")!.name).toBe("Job two");
      expect(chrome.groups.get(gid(1))!.title).toBe(
        groupTitle("Job two", "work"),
      );
    });

    it("deleting only the glyph or only the marker puts it back without touching the name", async () => {
      const { chrome, book, gid, edit } = await twoWindows();
      await edit(1, { title: "Work" });
      expect(chrome.groups.get(gid(1))!.title).toBe(groupTitle("Work", "work"));
      await edit(1, { title: "⧉ Work" });
      expect(chrome.groups.get(gid(1))!.title).toBe(groupTitle("Work", "work"));
      expect(book.get("work")!.name).toBe("Work");
    });

    it("an empty, duplicate or too long name is refused: the group shows the container again, and it is logged", async () => {
      const { chrome, book, gid, edit, logs } = await twoWindows();
      for (const title of ["⧉ ", "", "⧉ home", `⧉ ${"x".repeat(40)}`]) {
        await edit(1, { title });
        expect(book.get("work")!.name).toBe("Work");
        expect(chrome.groups.get(gid(1))!.title).toBe(
          groupTitle("Work", "work"),
        );
      }
      expect(
        logs.filter(([l, m]) => l === "warn" && /rename refused/.test(m)),
      ).toHaveLength(4);
    });

    it("a recolour maps back to the container colour (cyan -> turquoise); grey is refused", async () => {
      const { chrome, book, gid, edit } = await twoWindows();
      await edit(1, { color: "cyan" });
      expect(book.get("work")!.color).toBe("turquoise");
      expect(chrome.groups.get(gid(2))!.color).toBe("cyan");
      await edit(1, { color: "grey" });
      expect(book.get("work")!.color).toBe("turquoise");
      expect(chrome.groups.get(gid(1))!.color).toBe("cyan");
    });

    it("name and colour in one edit; the burst of keystrokes is acted on once, after the pause", async () => {
      const t = setup();
      t.chrome.addTab(1);
      await t.assign(1, "work");
      const id = t.chrome.tabs.get(1)!.groupId;
      const slow = new TabGroupProjection({
        tabs: t.chrome.api.tabs,
        tabGroups: t.chrome.api.tabGroups,
        area: t.area,
        settings: () => t.state,
        container: (cid) => t.book.get(cid),
        containers: () => [...t.book.values()],
        updateContainer: async (cid, patch) =>
          void Object.assign(t.book.get(cid)!, patch),
        containerTabs: () => [],
        log: () => {},
        delay: async () => {},
        editSettleMs: 20,
      });
      await slow.load();
      const calls: unknown[] = [];
      const real = t.book.get("work")!;
      const done: Array<Promise<void>> = [];
      for (const title of ["⧉ J", "⧉ Jo", "⧉ Job"]) {
        t.chrome.groups.get(id)!.title = title;
        t.chrome.groups.get(id)!.color = "purple";
        done.push(slow.groupUpdated({ id, title, color: "purple" }));
        calls.push({ ...real });
      }
      expect(real.name).toBe("Work"); // nothing yet: the user is still typing
      await Promise.all(done);
      await slow.idle();
      expect(real.name).toBe("Job");
      expect(real.color).toBe("purple");
    });

    it("ignores its own updates (a rename from the popup), collapsing, groups it does not keep, and a deleted container", async () => {
      const { chrome, book, projection, gid, edit, logs } = await twoWindows();
      // SplitSession's own rename: the echo carries the new state and changes nothing.
      book.get("work")!.name = "Popup";
      await projection.containerUpdated(book.get("work")!);
      await projection.groupUpdated({ ...chrome.groups.get(gid(1))! });
      await projection.groupUpdated({ ...chrome.groups.get(gid(2))! });
      await projection.idle();
      expect(book.get("work")!.name).toBe("Popup");
      // Collapsing: same title, same colour.
      await edit(1, {});
      expect(book.get("work")!.name).toBe("Popup");
      // A user's group titled like ours is not ours.
      chrome.groups.set(900, {
        id: 900,
        windowId: 1,
        title: "⧉ fake",
        color: "red",
      });
      chrome.addTab(9, 1, { groupId: 900 });
      await projection.groupUpdated({ id: 900, title: "⧉ fake", color: "red" });
      await projection.idle();
      expect(book.get("work")!.color).toBe("blue");
      expect(logs.filter(([l]) => l === "warn")).toEqual([]);
      // The container is gone.
      book.delete("home");
      const home = chrome.tabs.get(3)!.groupId;
      chrome.groups.get(home)!.title = "⧉ Whatever";
      await projection.groupUpdated({
        id: home,
        title: "⧉ Whatever",
        color: "cyan",
      });
      await projection.idle();
    });

    it("legacy titles (marker only) are recognised and rewritten with the glyph: when taken over, and at startup", async () => {
      const { chrome, projection, area } = setup();
      const legacy = (name: string, id: string) =>
        name + groupTitle("", id).slice(2);
      chrome.groups.set(50, {
        id: 50,
        windowId: 1,
        title: legacy("Work", "work"),
        color: "blue",
      });
      chrome.addTab(1, 1, { groupId: 50 });
      expect(await projection.containerOfGroup(50)).toBe("work");
      await projection.idle();
      expect(chrome.groups.get(50)!.title).toBe(groupTitle("Work", "work"));

      chrome.groups.set(51, {
        id: 51,
        windowId: 1,
        title: legacy("Old name", "home"),
        color: "red",
      });
      chrome.groups.set(52, {
        id: 52,
        windowId: 1,
        title: "⧉ fake",
        color: "red",
      });
      chrome.groups.set(53, {
        id: 53,
        windowId: 1,
        title: "Plain",
        color: "red",
      });
      chrome.addTab(2, 1, { groupId: 51 });
      chrome.addTab(3, 1, { groupId: 52 });
      chrome.addTab(4, 1, { groupId: 53 });
      const startup = new TabGroupProjection({
        tabs: chrome.api.tabs,
        tabGroups: {
          ...chrome.api.tabGroups,
          query: async () => [...chrome.groups.values()],
        },
        area,
        settings: () => ({
          tabGroups: true,
          titlePrefix: true,
          strictMode: true,
          showNameToPages: true,
          agentBridge: false,
          agentActivity: true,
          restoreTabs: true,
          markOutsideGroup: true,
          rememberTabs: true,
        }),
        container: (id) => containers.get(id),
        containers: () => [...containers.values()],
        updateContainer: async () => {},
        containerTabs: () => [],
        log: () => {},
        delay: async () => {},
      });
      await startup.load();
      await startup.adoptExisting();
      // The container is the truth: name and colour of the container, glyph included.
      expect(chrome.groups.get(51)).toMatchObject({
        title: groupTitle("Home", "home"),
        color: "cyan",
      });
      expect(chrome.groups.get(52)).toMatchObject({
        title: "⧉ fake",
        color: "red",
      });
      expect(chrome.groups.get(53)).toMatchObject({ title: "Plain" });
      expect(
        startup
          .ownedGroups()
          .map(([id]) => id)
          .sort(),
      ).toEqual([50, 51]);
    });
  });

  describe("split view", () => {
    it("never groups a split view of two containers, or of a container tab and a plain one; takes it out of a container group", async () => {
      const { chrome, assign, projection, assigned } = setup();
      chrome.addTab(1, 1, { splitViewId: 7 });
      chrome.addTab(2, 1, { splitViewId: 7 });
      await assign(1, "work"); // partner plain: mixed
      expect(chrome.tabs.get(1)!.groupId).toBe(-1);
      expect(chrome.tabs.get(2)!.groupId).toBe(-1);
      await assign(2, "home"); // two containers: mixed
      expect(chrome.tabs.get(2)!.groupId).toBe(-1);
      await projection.reconcileAll();
      expect(chrome.tabs.get(1)!.groupId).toBe(-1);
      expect(chrome.tabs.get(2)!.groupId).toBe(-1);
      expect(chrome.calls.filter((c) => c.startsWith("group"))).toEqual([]);

      // A mixed pair inside a container's group (Chrome put it there): out of it, containers kept.
      chrome.groups.set(50, {
        id: 50,
        windowId: 1,
        title: groupTitle("Work", "work"),
        color: "blue",
      });
      chrome.tabs.get(1)!.groupId = 50;
      chrome.tabs.get(2)!.groupId = 50;
      await projection.tabAssigned(1, "work");
      expect(chrome.tabs.get(1)!.groupId).toBe(-1);
      expect(chrome.tabs.get(2)!.groupId).toBe(-1);
      expect(assigned).toEqual([
        { tabId: 1, containerId: "work" },
        { tabId: 2, containerId: "home" },
      ]);

      // The split view dissolved: "Re-group" puts each tab into its own container's group.
      chrome.tabs.get(1)!.splitViewId = -1;
      chrome.tabs.get(2)!.splitViewId = -1;
      await projection.reconcileAll();
      const g1 = chrome.tabs.get(1)!.groupId;
      const g2 = chrome.tabs.get(2)!.groupId;
      expect(chrome.groups.get(g1)).toMatchObject({
        title: groupTitle("Work", "work"),
      });
      expect(chrome.groups.get(g2)).toMatchObject({
        title: groupTitle("Home", "home"),
      });
    });

    it("groups a split view of one container like any of its tabs (both tabs join the group)", async () => {
      const { chrome, assign } = setup();
      chrome.addTab(1, 1, { splitViewId: 7 });
      chrome.addTab(2, 1, { splitViewId: 7 });
      await assign(1, "work");
      await assign(2, "work");
      const g = chrome.tabs.get(1)!.groupId;
      expect(g).toBeGreaterThanOrEqual(0);
      expect(chrome.tabs.get(2)!.groupId).toBe(g);
      expect(chrome.groups.get(g)).toMatchObject({
        title: groupTitle("Work", "work"),
      });
    });

    it("ungroupSplit takes both tabs out and reports a refusal that outlasts the retries", async () => {
      const { chrome, projection } = setup();
      chrome.groups.set(50, {
        id: 50,
        windowId: 1,
        title: groupTitle("Work", "work"),
        color: "blue",
      });
      chrome.addTab(1, 1, { groupId: 50, splitViewId: 7 });
      chrome.addTab(2, 1, { groupId: 50, splitViewId: 7 });
      chrome.failNextUngroupCalls = 6; // every retry of one call
      await expect(projection.ungroupSplit([1, 2])).rejects.toThrow(/dragging/);
      expect(chrome.tabs.get(1)!.groupId).toBe(50);
      await projection.idle(); // the queue keeps going
      await projection.ungroupSplit([1, 2]);
      expect(chrome.tabs.get(1)!.groupId).toBe(-1);
      expect(chrome.tabs.get(2)!.groupId).toBe(-1);
    });
  });
  describe("agent-activity mark on the group title (Full)", () => {
    afterEach(() => vi.useRealTimers());
    const ON = "🟣";
    const OFF = "⚪";

    async function marked(settings: Partial<Settings> = {}) {
      const t = setup(settings);
      t.chrome.addTab(1);
      t.chrome.addTab(2);
      t.chrome.addTab(3);
      await t.assign(1, "work");
      await t.assign(2, "work");
      await t.assign(3, "home");
      const gid = (tab: number) => t.chrome.tabs.get(tab)!.groupId;
      const updates: Array<{ id: number; props: object }> = [];
      const realUpdate = t.chrome.api.tabGroups.update;
      t.chrome.api.tabGroups.update = async (id, props) => {
        updates.push({ id, props });
        return realUpdate(id, props);
      };
      const title = (tab: number) => t.chrome.groups.get(gid(tab))!.title;
      const color = (tab: number) => t.chrome.groups.get(gid(tab))!.color;
      /** What `tabGroups.onUpdated` + `Extras.handleGroupUpdated` do with the latest state of the group. */
      const deliver = async (tab: number) => {
        const group = { ...t.chrome.groups.get(gid(tab))! };
        if (t.projection.takeMarkEcho(group)) return "dropped";
        await t.projection.groupUpdated(group);
        await t.projection.idle();
        return "synced";
      };
      const slowSettle = () => {
        (
          t.projection as unknown as { deps: { editSettleMs?: number } }
        ).deps.editSettleMs = 30;
      };
      return { ...t, gid, updates, title, color, deliver, slowSettle };
    }

    it("the glyph becomes 🟣 while the agent works and ⧉ again after; name, marker and colour stay; the colour is never written; one title-only write each way", async () => {
      const { projection, gid, updates, title, color, book } = await marked();
      await projection.setActivity(gid(1), true);
      expect(title(1)).toBe(groupTitle("Work", "work", 0));
      expect(title(1)!.startsWith(`${ON} Work`)).toBe(true);
      expect(decodeGroupMarker(title(1))).toBe("work");
      expect(color(1)).toBe("blue");
      expect(updates).toHaveLength(1);
      expect(updates[0]!.props).toEqual({ title: title(1) });
      // A burst of actions and a repeat change nothing.
      await Promise.all([
        projection.setActivity(gid(1), true),
        projection.setActivity(gid(1), true),
        projection.setActivity(gid(1), true),
      ]);
      expect(updates).toHaveLength(1);
      expect(title(3)).toBe(groupTitle("Home", "home")); // another container's group is untouched

      await projection.setActivity(gid(1), false);
      expect(title(1)).toBe(groupTitle("Work", "work"));
      await projection.setActivity(gid(1), false);
      expect(updates).toHaveLength(2);
      expect(updates[1]!.props).toEqual({ title: groupTitle("Work", "work") });
      expect(color(1)).toBe("blue");
      expect(book.get("work")).toMatchObject({ name: "Work", color: "blue" });
    });

    it("the glyph blinks 🟣 ⚪ every BLINK_MS with one title-only write per tick; the colour is never written; the timer stops with the mark", async () => {
      vi.useFakeTimers();
      const { projection, gid, updates, title, color, book } = await marked();
      expect(vi.getTimerCount()).toBe(0);
      await projection.setActivity(gid(1), true);
      expect(vi.getTimerCount()).toBe(1);
      expect(BLINK_MS).toBeLessThanOrEqual(700);
      await vi.advanceTimersByTimeAsync(BLINK_MS - 50);
      expect(updates).toHaveLength(1); // no tick yet: no write
      const seen: string[] = [title(1)![0]! + title(1)![1]!];
      for (let i = 0; i < 6; i++) {
        await vi.advanceTimersByTimeAsync(i === 0 ? 50 : BLINK_MS);
        seen.push([...title(1)!][0]!);
      }
      expect(seen[0]).toBe(ON);
      expect(seen.slice(1)).toEqual([OFF, ON, OFF, ON, OFF, ON]);
      expect(updates).toHaveLength(7); // the start and one write per tick
      for (const u of updates) expect(Object.keys(u.props)).toEqual(["title"]);
      expect(color(1)).toBe("blue");
      expect(book.get("work")).toMatchObject({ name: "Work", color: "blue" });
      expect(decodeGroupMarker(title(1))).toBe("work");
      // Another marked group shares the timer; each ends on its own.
      await projection.setActivity(gid(3), true);
      expect(vi.getTimerCount()).toBe(1);
      await projection.setActivity(gid(1), false);
      expect(title(1)).toBe(groupTitle("Work", "work"));
      expect(vi.getTimerCount()).toBe(1);
      await projection.setActivity(gid(3), false);
      expect(vi.getTimerCount()).toBe(0);
      const count = updates.length;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(updates).toHaveLength(count); // nothing more is written
    });

    it("our own writes are quiet echoes: nothing renames the container, nothing reaches the guard", async () => {
      vi.useFakeTimers();
      const { projection, gid, book, deliver, updates } = await marked();
      await projection.setActivity(gid(1), true);
      expect(await deliver(1)).toBe("dropped");
      await vi.advanceTimersByTimeAsync(BLINK_MS);
      expect(await deliver(1)).toBe("dropped"); // a tick
      await projection.setActivity(gid(1), false);
      expect(await deliver(1)).toBe("dropped");
      expect(await deliver(1)).toBe("synced"); // nothing left to drop: a plain update goes the normal way
      expect(book.get("work")).toMatchObject({ name: "Work", color: "blue" });
      expect(updates).toHaveLength(3);
    });

    it("the echo of a write is the echo only while title and colour are what we wrote: a recolour or a rename meanwhile is an edit", async () => {
      const { projection, chrome, gid } = await marked();
      await projection.setActivity(gid(1), true);
      const group = { ...chrome.groups.get(gid(1))! };
      expect(projection.takeMarkEcho({ ...group, color: "green" })).toBe(false);
      expect(projection.takeMarkEcho({ ...group, title: "Job" })).toBe(false);
      expect(projection.takeMarkEcho(group)).toBe(true);
    });

    it("a rename by the user while marked renames the container, and the mark stays on the new name", async () => {
      const { projection, chrome, gid, title, book, deliver } = await marked();
      await projection.setActivity(gid(1), true);
      await deliver(1);
      chrome.groups.get(gid(1))!.title = `${ON} Job${groupMarker("work")}`;
      expect(await deliver(1)).toBe("synced");
      expect(book.get("work")!.name).toBe("Job");
      expect(title(1)).toBe(groupTitle("Job", "work", 0)); // not reverted to the old name, not to ⧉
      expect(title(2)).toBe(groupTitle("Job", "work", 0)); // the other window follows
      await projection.setActivity(gid(1), false);
      expect(title(1)).toBe(groupTitle("Job", "work")); // the restore keeps the new name
      expect(book.get("work")!.name).toBe("Job");
    });

    it("a name typed without glyph and marker while marked is accepted, the title comes back marked", async () => {
      const { projection, chrome, gid, title, book, deliver } = await marked();
      await projection.setActivity(gid(1), true);
      chrome.groups.get(gid(1))!.title = "Job two";
      await deliver(1);
      expect(book.get("work")!.name).toBe("Job two");
      expect(title(1)).toBe(groupTitle("Job two", "work", 0));
    });

    it("a container renamed elsewhere (popup) while marked keeps the mark on its groups", async () => {
      const { projection, gid, title, book } = await marked();
      await projection.setActivity(gid(1), true);
      const work = book.get("work")!;
      work.name = "Work 2";
      await projection.containerUpdated(work);
      expect(title(1)).toBe(groupTitle("Work 2", "work", 0));
      await projection.setActivity(gid(1), false);
      expect(title(1)).toBe(groupTitle("Work 2", "work"));
    });

    it("a recolour by the user while marked simply syncs, whatever the colour (purple and pink included): the group keeps what the user picked", async () => {
      for (const picked of ["red", "purple", "pink", "orange"]) {
        const { projection, chrome, gid, book, color, title, deliver } =
          await marked();
        await projection.setActivity(gid(1), true);
        chrome.groups.get(gid(1))!.color = picked;
        expect(await deliver(1)).toBe("synced");
        expect(book.get("work")!.color).toBe(picked);
        expect(color(1)).toBe(picked); // nothing writes the colour back
        expect(color(2)).toBe(picked); // the other window follows
        expect(title(1)).toBe(groupTitle("Work", "work", 0)); // the mark stays
        await projection.setActivity(gid(1), false);
        expect(color(1)).toBe(picked);
      }
    });

    it("a user edit that lands between the set and the restore is not lost to the restore (the glyph is swapped on the live title)", async () => {
      const { projection, chrome, gid, title } = await marked();
      await projection.setActivity(gid(1), true);
      chrome.groups.get(gid(1))!.title = `${ON} Typing${groupMarker("work")}`; // not synced yet
      await projection.setActivity(gid(1), false);
      expect(title(1)).toBe(`⧉ Typing${groupMarker("work")}`);
    });

    it("a rename that lands between the read and the write of the mark is not overwritten: the swap is worked out again from the new title", async () => {
      const { projection, chrome, gid, title, book } = await marked();
      const g = gid(1);
      const real = chrome.api.tabGroups.get;
      let reads = 0;
      const user = `⧉ Job${groupMarker("work")}`;
      chrome.api.tabGroups.get = async (id: number) => {
        const out = await real(id);
        if (id === g && ++reads === 1) chrome.groups.get(g)!.title = user;
        return out;
      };
      await projection.setActivity(g, true);
      chrome.api.tabGroups.get = real;
      expect(title(1)).toBe(groupTitle("Job", "work", 0)); // the user's name, with the mark on top
      await projection.groupUpdated({ id: g, title: user, color: "blue" });
      await projection.idle();
      expect(book.get("work")!.name).toBe("Job");
      expect(title(1)).toBe(groupTitle("Job", "work", 0));
    });

    it("a rename that beats the mark's write by a hair is overwritten in Chrome but not lost: the sync reads the user's title from their event", async () => {
      const { projection, chrome, gid, title, book } = await marked();
      const g = gid(1);
      const real = chrome.api.tabGroups.update;
      const user = `⧉ Job${groupMarker("work")}`;
      chrome.api.tabGroups.update = async (id: number, props: object) => {
        chrome.groups.get(id)!.title = user; // the user's write lands first ...
        return real(id, props); // ... and the mark's, worked out from the old title, lands on top of it
      };
      await projection.setActivity(g, true);
      chrome.api.tabGroups.update = real;
      expect(title(1)).toBe(groupTitle("Work", "work", 0)); // the stale write won in Chrome
      await projection.groupUpdated({ id: g, title: user, color: "blue" });
      await projection.idle();
      expect(book.get("work")!.name).toBe("Job");
      expect(title(1)).toBe(groupTitle("Job", "work", 0));
      expect(title(2)).toBe(groupTitle("Job", "work", 0));
      await projection.setActivity(g, false);
      expect(title(1)).toBe(groupTitle("Job", "work"));
    });

    it("a recolour that lands between the read and the write of the mark is not undone by it; the sync takes it from the event", async () => {
      const { projection, chrome, gid, book, color, title } = await marked();
      const g = gid(1);
      const real = chrome.api.tabGroups.get;
      let reads = 0;
      chrome.api.tabGroups.get = async (id: number) => {
        const out = await real(id);
        if (id === g && ++reads === 1) chrome.groups.get(g)!.color = "green";
        return out;
      };
      await projection.setActivity(g, true);
      chrome.api.tabGroups.get = real;
      expect(color(1)).toBe("green");
      expect(title(1)).toBe(groupTitle("Work", "work", 0));
      // The user's own event (the title as it was before the mark's write, their colour); the mark's echo is a separate event.
      await projection.groupUpdated({
        id: g,
        title: groupTitle("Work", "work"),
        color: "green",
      });
      await projection.idle();
      expect(book.get("work")!.color).toBe("green");
    });

    it("🟣 ⚪ (with or without U+FE0F, with spaces or none) ◉ ◎ ○ in a typed title never reach the container name; a second glyph is refused", async () => {
      for (const typed of [
        `${ON} Job`,
        ` ${ON}Job`,
        `${OFF} Job`,
        `${OFF}️ Job`,
        `  ${OFF}️Job`,
        "◉ Job",
        " ◎Job",
        "○ Job",
      ]) {
        for (const active of [true, false]) {
          const { projection, chrome, gid, book, title } = await marked();
          if (active) await projection.setActivity(gid(1), true);
          const event = {
            id: gid(1),
            title: `${typed}${groupMarker("work")}`,
            color: "blue",
          };
          chrome.groups.get(gid(1))!.title = event.title;
          await projection.groupUpdated(event);
          await projection.idle();
          expect(book.get("work")!.name).toBe("Job");
          expect(title(1)).toBe(groupTitle("Job", "work", active ? 0 : false));
        }
      }
      const { projection, chrome, gid, book, logs } = await marked();
      const event = {
        id: gid(1),
        title: `${ON} ${OFF} Job${groupMarker("work")}`,
        color: "blue",
      };
      chrome.groups.get(gid(1))!.title = event.title;
      await projection.groupUpdated(event);
      await projection.idle();
      expect(book.get("work")!.name).toBe("Work");
      expect(chrome.groups.get(gid(1))!.title).toBe(groupTitle("Work", "work"));
      expect(
        logs.some(([l, m]) => l === "warn" && /rename refused/.test(m)),
      ).toBe(true);
    });

    it("never marks a group SplitSession does not keep: a user's group, an unknown id, or any group with groups off", async () => {
      const t = await marked();
      t.chrome.groups.set(70, {
        id: 70,
        windowId: 1,
        title: "Plain",
        color: "red",
      });
      t.chrome.groups.set(71, {
        id: 71,
        windowId: 1,
        title: "⧉ fake",
        color: "red",
      });
      await t.projection.setActivity(70, true);
      await t.projection.setActivity(71, true);
      await t.projection.setActivity(999, true);
      expect(t.updates).toEqual([]);
      expect(t.chrome.groups.get(70)!.title).toBe("Plain");
      expect(t.chrome.groups.get(71)!.title).toBe("⧉ fake");
      t.state.tabGroups = false;
      await t.projection.setActivity(t.gid(1), true);
      expect(t.updates).toEqual([]);
    });

    it("a title the user retyped without the marker is not edited by the mark", async () => {
      const { projection, chrome, gid, updates } = await marked();
      chrome.groups.get(gid(1))!.title = "Mine";
      await projection.setActivity(gid(1), true);
      expect(updates).toEqual([]);
      expect(chrome.groups.get(gid(1))!.title).toBe("Mine");
    });

    it("a removed group or a deleted container stops the timer; a removed group is not restored", async () => {
      vi.useFakeTimers();
      const { projection, chrome, gid, updates } = await marked();
      const g = gid(3);
      await projection.setActivity(g, true);
      chrome.tabs.get(3)!.groupId = -1;
      chrome.groups.delete(g);
      await projection.groupRemoved(g);
      expect(vi.getTimerCount()).toBe(0);
      const count = updates.length;
      await projection.setActivity(g, false);
      expect(updates).toHaveLength(count);
      await projection.setActivity(gid(1), true);
      await projection.containerDeleted("work");
      expect(vi.getTimerCount()).toBe(0);
      await projection.setActivity(gid(2), true); // no longer owned: ignored
      expect(vi.getTimerCount()).toBe(0);
    });

    it("releaseAll (groups switched off) forgets every mark and stops the timer", async () => {
      vi.useFakeTimers();
      const { projection, gid } = await marked();
      const g = gid(3);
      await projection.setActivity(g, true);
      await projection.releaseAll();
      expect(vi.getTimerCount()).toBe(0);
      await projection.setActivity(g, false);
    });

    async function restarted(
      groups: Array<{ id: number; title: string; color?: string }>,
      keep = true,
    ) {
      const chrome = new FakeChrome();
      for (const g of groups) {
        chrome.groups.set(g.id, {
          id: g.id,
          windowId: 1,
          title: g.title,
          color: g.color ?? "blue",
        });
        chrome.addTab(g.id, 1, { groupId: g.id });
      }
      const startup = new TabGroupProjection({
        tabs: chrome.api.tabs,
        tabGroups: {
          ...chrome.api.tabGroups,
          query: async () => [...chrome.groups.values()],
        },
        area: new MemoryStorageArea(),
        settings: () => ({ tabGroups: keep, agentActivity: true }) as Settings,
        container: (id) => containers.get(id),
        containers: () => [...containers.values()],
        updateContainer: async () => {},
        containerTabs: () => [],
        log: () => {},
        delay: async () => {},
      });
      await startup.load();
      await startup.adoptExisting();
      return { chrome, startup };
    }
    const leftover = (glyph: string, name: string, id: string) =>
      `${glyph} ${name}${groupMarker(id)}`;

    it("a mark left by a worker that died (a blink emoji, or a ◉ ◎ ○ of 0.1.5-dev) is cleaned at the next start, by the invisible marker", async () => {
      const { chrome, startup } = await restarted([
        { id: 50, title: leftover(ON, "Work", "work") },
        { id: 51, title: leftover(OFF, "Home", "home"), color: "cyan" },
        { id: 52, title: leftover("◉", "Work", "work") },
        { id: 53, title: leftover("○", "Home", "home"), color: "cyan" },
        { id: 54, title: leftover(`${OFF}️`, "Work", "work") },
        { id: 55, title: `${ON} looks like ours` }, // no marker: the user's own
      ]);
      for (const id of [50, 52, 54])
        expect(chrome.groups.get(id)!.title).toBe(groupTitle("Work", "work"));
      for (const id of [51, 53])
        expect(chrome.groups.get(id)!.title).toBe(groupTitle("Home", "home"));
      expect(chrome.groups.get(55)!.title).toBe(`${ON} looks like ours`);
      expect(startup.ownedGroups().map(([id]) => id)).toEqual([
        50, 51, 52, 53, 54,
      ]);
    });

    it("0.1.6's stuck pulse colour goes back to the container's colour at the next start (also red and orange for a purple or pink container)", async () => {
      const { chrome } = await restarted([
        { id: 50, title: groupTitle("Work", "work"), color: "purple" },
        { id: 51, title: groupTitle("Work", "work"), color: "pink" },
        { id: 52, title: groupTitle("Home", "home"), color: "purple" },
        { id: 53, title: "Mine", color: "purple" }, // the user's own: no marker
      ]);
      expect(chrome.groups.get(50)!.color).toBe("blue");
      expect(chrome.groups.get(51)!.color).toBe("blue");
      expect(chrome.groups.get(52)!.color).toBe("cyan");
      expect(chrome.groups.get(53)).toMatchObject({
        title: "Mine",
        color: "purple",
      });
    });

    it("the cleanup also runs with groups off: glyph back to ⧉, a pulse colour that is not the container's back; other colours, user groups and a deleted container's colour stay", async () => {
      const { chrome } = await restarted(
        [
          { id: 50, title: leftover(ON, "Work", "work"), color: "purple" },
          { id: 51, title: groupTitle("Work", "work"), color: "green" }, // not a pulse colour: the user's choice
          { id: 52, title: leftover(OFF, "Old", "deleted"), color: "purple" }, // deleted container: title only
          { id: 53, title: `${OFF} mine`, color: "pink" },
        ],
        false,
      );
      expect(chrome.groups.get(50)).toMatchObject({
        title: groupTitle("Work", "work"),
        color: "blue",
      });
      expect(chrome.groups.get(51)).toMatchObject({ color: "green" });
      expect(chrome.groups.get(52)).toMatchObject({
        title: groupTitle("Old", "deleted"),
        color: "purple",
      });
      expect(chrome.groups.get(53)).toMatchObject({
        title: `${OFF} mine`,
        color: "pink",
      });
    });

    it("the cleanup does not undo a mark that is live: the agent started before the adoption ran", async () => {
      vi.useFakeTimers();
      const { chrome, startup } = await restarted([
        { id: 50, title: groupTitle("Work", "work") },
      ]);
      await startup.setActivity(50, true);
      await startup.adoptExisting();
      expect(chrome.groups.get(50)!.title).toBe(groupTitle("Work", "work", 0));
      await startup.setActivity(50, false);
    });
  });
});
