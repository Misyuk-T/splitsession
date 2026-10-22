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
  type GroupTab,
  OWNED_GROUPS_KEY,
  PULSE_MS,
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
      /** What `tabGroups.onUpdated` + `Extras.handleGroupUpdated` do with the latest state of the group. */
      const deliver = async (tab: number) => {
        const group = { ...t.chrome.groups.get(gid(tab))! };
        if (t.projection.takeMarkEcho(group)) return "dropped";
        await t.projection.groupUpdated(group);
        await t.projection.idle();
        return "synced";
      };
      return { ...t, gid, updates, title, deliver };
    }

    it("swaps only the glyph: ◉ while the agent works, ⧉ again after; name, marker and colour stay; one update per change", async () => {
      const { projection, chrome, gid, updates, title, book } = await marked();
      const before = chrome.groups.get(gid(1))!.color;
      await projection.setActivity(gid(1), true);
      expect(title(1)).toBe(groupTitle("Work", "work", true));
      expect(title(1)!.startsWith("◉ Work")).toBe(true);
      expect(decodeGroupMarker(title(1))).toBe("work");
      expect(updates).toHaveLength(1); // glyph and colour in one write
      expect(updates[0]!.props).toEqual({ title: title(1), color: "purple" });
      expect(chrome.groups.get(gid(1))!.color).toBe("purple");
      // A burst (every action of the agent) and a repeat change nothing.
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
      expect(chrome.groups.get(gid(1))!.color).toBe(before);
      expect(book.get("work")!.name).toBe("Work");
    });

    it("our own set and restore are not edits of the user's: the container keeps its name, nothing is written back, the guard is not woken", async () => {
      const { projection, gid, updates, book, logs, deliver } = await marked();
      await projection.setActivity(gid(1), true);
      expect(await deliver(1)).toBe("dropped"); // the echo of the set
      await projection.setActivity(gid(1), false);
      expect(await deliver(1)).toBe("dropped"); // the echo of the restore
      expect(await deliver(1)).toBe("synced"); // nothing left to drop: a plain update goes the normal way
      expect(updates).toHaveLength(2);
      expect(book.get("work")!.name).toBe("Work");
      expect(
        logs.filter(([, m]) => /changed from its tab group/.test(m)),
      ).toEqual([]);
    });

    it("even when the echo reaches the sync directly (no peek), it is consumed and changes nothing", async () => {
      const { projection, chrome, gid, updates, book } = await marked();
      await projection.setActivity(gid(1), true);
      await projection.groupUpdated({ ...chrome.groups.get(gid(1))! });
      await projection.idle();
      expect(updates).toHaveLength(1);
      expect(book.get("work")!.name).toBe("Work");
    });

    it("a rename by the user while marked still renames the container, and the mark stays on top of the new name", async () => {
      const { projection, chrome, gid, title, book, deliver } = await marked();
      await projection.setActivity(gid(1), true);
      await deliver(1);
      // The user types a new name in Chrome's editor (the glyph shown is the one in the title).
      chrome.groups.get(gid(1))!.title = `◉ Job${groupMarker("work")}`;
      expect(await deliver(1)).toBe("synced");
      expect(book.get("work")!.name).toBe("Job");
      expect(title(1)).toBe(groupTitle("Job", "work", true)); // not reverted to ⧉, not reverted to Work
      expect(title(2)).toBe(groupTitle("Job", "work", true));
      await projection.setActivity(gid(1), false);
      expect(title(1)).toBe(groupTitle("Job", "work")); // the restore keeps the new name too
      expect(book.get("work")!.name).toBe("Job");
    });

    it("a name typed without glyph and marker while marked is accepted, the title comes back marked", async () => {
      const { projection, chrome, gid, title, book, deliver } = await marked();
      await projection.setActivity(gid(1), true);
      chrome.groups.get(gid(1))!.title = "Job two";
      await deliver(1);
      expect(book.get("work")!.name).toBe("Job two");
      expect(title(1)).toBe(groupTitle("Job two", "work", true));
    });

    it("a container renamed elsewhere (popup, other group) while marked keeps the mark on its groups", async () => {
      const { projection, gid, title, book } = await marked();
      await projection.setActivity(gid(1), true);
      const work = book.get("work")!;
      work.name = "Work 2";
      await projection.containerUpdated(work);
      expect(title(1)).toBe(groupTitle("Work 2", "work", true));
      await projection.setActivity(gid(1), false);
      expect(title(1)).toBe(groupTitle("Work 2", "work"));
    });

    it("a user edit that lands between the set and the restore is not lost to the restore (the glyph is swapped on the live title)", async () => {
      const { projection, chrome, gid, title } = await marked();
      await projection.setActivity(gid(1), true);
      chrome.groups.get(gid(1))!.title = `◉ Typing${groupMarker("work")}`; // not synced yet
      await projection.setActivity(gid(1), false);
      expect(title(1)).toBe(`⧉ Typing${groupMarker("work")}`);
    });

    it("a title typed with spaces or no space after the glyph never puts a glyph into the container name, whether or not the mark has expired", async () => {
      for (const typed of [" ◉ Job", "◉Job", "   ◉   Job", " ⧉ Job"]) {
        for (const expired of [false, true]) {
          const { projection, chrome, gid, title, book } = await marked();
          await projection.setActivity(gid(1), true);
          const event = {
            id: gid(1),
            title: `${typed}${groupMarker("work")}`,
            color: chrome.groups.get(gid(1))!.color,
          };
          chrome.groups.get(gid(1))!.title = event.title;
          if (expired) await projection.setActivity(gid(1), false); // the mark ends before the pause is over
          await projection.groupUpdated(event);
          await projection.idle();
          expect(book.get("work")!.name).toBe("Job");
          expect(title(1)).toBe(groupTitle("Job", "work", !expired));
          expect(title(2)).toBe(groupTitle("Job", "work", !expired));
        }
      }
    });

    it("a second glyph typed after the first is refused as a name: the container keeps its name and the group shows it again", async () => {
      const { projection, chrome, gid, title, book, logs } = await marked();
      await projection.setActivity(gid(1), true);
      const event = {
        id: gid(1),
        title: `◉ ◉ Job${groupMarker("work")}`,
        color: chrome.groups.get(gid(1))!.color,
      };
      chrome.groups.get(gid(1))!.title = event.title;
      await projection.groupUpdated(event);
      await projection.idle();
      expect(book.get("work")!.name).toBe("Work");
      expect(title(1)).toBe(groupTitle("Work", "work", true));
      expect(
        logs.some(([l, m]) => l === "warn" && /rename refused/.test(m)),
      ).toBe(true);
    });

    it("a rename that lands between the read and the write of the mark is not overwritten: the swap is worked out again from the new title", async () => {
      const { projection, chrome, gid, title, book } = await marked();
      const g = gid(1);
      const real = chrome.api.tabGroups.get;
      let reads = 0;
      const user = `⧉ Job${groupMarker("work")}`;
      chrome.api.tabGroups.get = async (id: number) => {
        const out = await real(id);
        if (id === g && ++reads === 1) chrome.groups.get(g)!.title = user; // after the first read
        return out;
      };
      await projection.setActivity(g, true);
      chrome.api.tabGroups.get = real;
      expect(title(1)).toBe(groupTitle("Job", "work", true)); // the user's name, with the mark on top
      await projection.groupUpdated({ id: g, title: user, color: "blue" });
      await projection.idle();
      expect(book.get("work")!.name).toBe("Job");
      expect(title(1)).toBe(groupTitle("Job", "work", true));
      expect(title(2)).toBe(groupTitle("Job", "work", true));
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
      expect(title(1)).toBe(groupTitle("Work", "work", true)); // the stale write won in Chrome
      await projection.groupUpdated({ id: g, title: user, color: "blue" }); // the user's event arrives
      await projection.idle();
      expect(book.get("work")!.name).toBe("Job");
      expect(title(1)).toBe(groupTitle("Job", "work", true));
      expect(title(2)).toBe(groupTitle("Job", "work", true));
      await projection.setActivity(g, false);
      expect(title(1)).toBe(groupTitle("Job", "work"));
    });

    describe("agent colour and the pulse", () => {
      afterEach(() => vi.useRealTimers());

      it("the group takes the agent's purple (red for a purple container) and gets the container's colour back", async () => {
        const { projection, chrome, gid, book, updates } = await marked();
        await projection.setActivity(gid(1), true);
        expect(chrome.groups.get(gid(1))!.color).toBe("purple");
        await projection.setActivity(gid(1), false);
        expect(chrome.groups.get(gid(1))!.color).toBe("blue");
        // A purple container: the mark is red.
        const home = book.get("home")!;
        home.color = "purple";
        await projection.containerUpdated(home);
        expect(chrome.groups.get(gid(3))!.color).toBe("purple");
        const before = updates.length;
        await projection.setActivity(gid(3), true);
        expect(chrome.groups.get(gid(3))!.color).toBe("red");
        expect(updates).toHaveLength(before + 1);
        // The container becomes blue meanwhile (popup): the mark becomes purple, the restore gives blue.
        home.color = "blue";
        await projection.containerUpdated(home);
        expect(chrome.groups.get(gid(3))!.color).toBe("purple");
        await projection.setActivity(gid(3), false);
        expect(chrome.groups.get(gid(3))!.color).toBe("blue");
        expect(home.color).toBe("blue");
      });

      it("the colour writes are quiet echoes: nothing recolours the container, nothing reaches the guard", async () => {
        const { projection, gid, book, deliver, updates } = await marked();
        await projection.setActivity(gid(1), true);
        expect(await deliver(1)).toBe("dropped"); // title and colour together
        await projection.setActivity(gid(1), false);
        expect(await deliver(1)).toBe("dropped");
        expect(book.get("work")!.color).toBe("blue");
        expect(book.get("work")!.name).toBe("Work");
        expect(updates).toHaveLength(2);
      });

      it("while marked, a title edit that reports the agent's colour does not recolour the container; the state after it is the mark again", async () => {
        const { projection, chrome, gid, book, title } = await marked();
        await projection.setActivity(gid(1), true);
        await projection.groupUpdated({
          id: gid(1),
          title: `◉ Job${groupMarker("work")}`,
          color: "purple",
        });
        await projection.idle();
        expect(book.get("work")!.name).toBe("Job");
        expect(book.get("work")!.color).toBe("blue");
        expect(chrome.groups.get(gid(1))!.color).toBe("purple");
        expect(title(1)).toBe(groupTitle("Job", "work", true));
      });

      it("a rename made while marked, settled after the mark ended, keeps the container's real colour (the agent's colour is not saved into it)", async () => {
        const { projection, chrome, gid, book, title } = await marked();
        await projection.setActivity(gid(1), true);
        // The event arrives while the mark is on: title typed, colour as the group wears it (purple) ...
        const event = {
          id: gid(1),
          title: `◉ Job${groupMarker("work")}`,
          color: "purple",
        };
        chrome.groups.get(gid(1))!.title = event.title;
        // ... and the mark ends before the pause is over (a slow settle: the pause is 30 ms here).
        (
          projection as unknown as { deps: { editSettleMs?: number } }
        ).deps.editSettleMs = 30;
        const pending = projection.groupUpdated(event);
        await projection.setActivity(gid(1), false);
        await pending;
        await projection.idle();
        expect(book.get("work")!.name).toBe("Job");
        expect(book.get("work")!.color).toBe("blue");
        expect(chrome.groups.get(gid(1))!.color).toBe("blue");
        expect(title(1)).toBe(groupTitle("Job", "work"));
      });

      it("a purple pick made while NOT marked is the user's, even if the mark starts before the pause is over", async () => {
        const { projection, chrome, gid, book } = await marked();
        (
          projection as unknown as { deps: { editSettleMs?: number } }
        ).deps.editSettleMs = 30;
        const event = {
          id: gid(1),
          title: chrome.groups.get(gid(1))!.title,
          color: "purple",
        };
        chrome.groups.get(gid(1))!.color = "purple";
        const pending = projection.groupUpdated(event);
        await projection.setActivity(gid(1), true);
        await pending;
        await projection.idle();
        expect(book.get("work")!.color).toBe("purple");
      });

      it("a recolour by the user while marked recolours the container; the mark stays on top, and the restore uses the new colour", async () => {
        const { projection, chrome, gid, book, deliver } = await marked();
        await projection.setActivity(gid(1), true);
        chrome.groups.get(gid(1))!.color = "red"; // the user picks red in Chrome's menu
        expect(await deliver(1)).toBe("synced");
        expect(book.get("work")!.color).toBe("red");
        expect(chrome.groups.get(gid(1))!.color).toBe("purple"); // still the agent's colour while it works
        expect(chrome.groups.get(gid(2))!.color).toBe("purple"); // the other window of the container follows
        await projection.setActivity(gid(1), false);
        expect(chrome.groups.get(gid(1))!.color).toBe("red");
        expect(chrome.groups.get(gid(2))!.color).toBe("red");
        expect(book.get("work")!.color).toBe("red");
      });

      it("a recolour that lands between the read and the write of the mark is worked out again; one that beats the write by a hair is read from the user's event", async () => {
        const a = await marked();
        const g = a.gid(1);
        const real = a.chrome.api.tabGroups.get;
        let reads = 0;
        a.chrome.api.tabGroups.get = async (id: number) => {
          const out = await real(id);
          if (id === g && ++reads === 1) a.chrome.groups.get(g)!.color = "red";
          return out;
        };
        await a.projection.setActivity(g, true);
        a.chrome.api.tabGroups.get = real;
        expect(a.chrome.groups.get(g)!.color).toBe("purple");
        await a.projection.groupUpdated({
          ...a.chrome.groups.get(g)!,
          color: "red",
        }); // the user's event
        await a.projection.idle();
        expect(a.book.get("work")!.color).toBe("red");
        await a.projection.setActivity(g, false);
        expect(a.chrome.groups.get(g)!.color).toBe("red");

        const b = await marked();
        const g2 = b.gid(1);
        const update = b.chrome.api.tabGroups.update;
        b.chrome.api.tabGroups.update = async (id: number, props: object) => {
          b.chrome.groups.get(id)!.color = "pink"; // the user's write lands first, ours on top of it
          return update(id, props);
        };
        await b.projection.setActivity(g2, true);
        b.chrome.api.tabGroups.update = update;
        expect(b.chrome.groups.get(g2)!.color).toBe("purple");
        await b.projection.groupUpdated({
          id: g2,
          title: b.title(1),
          color: "pink",
        });
        await b.projection.idle();
        expect(b.book.get("work")!.color).toBe("pink");
        await b.projection.setActivity(g2, false);
        expect(b.chrome.groups.get(g2)!.color).toBe("pink");
      });

      it("a title-only write is not the echo of a group the user recoloured meanwhile", async () => {
        const { projection, chrome, gid } = await marked();
        vi.useFakeTimers();
        await projection.setActivity(gid(1), true);
        await vi.advanceTimersByTimeAsync(PULSE_MS); // ◎, written without a colour
        const group = { ...chrome.groups.get(gid(1))! };
        expect(group.title![0]).toBe("◎");
        expect(projection.takeMarkEcho({ ...group, color: "red" })).toBe(false); // someone recoloured: an edit
        expect(projection.takeMarkEcho(group)).toBe(true); // the tick's own echo, colour as it was
      });

      it("the glyph breathes ◉ ◎ ○ ◎ at one frame per PULSE_MS with one title-only write per tick; the colour stays; the timer stops with the mark", async () => {
        vi.useFakeTimers();
        const { projection, chrome, gid, updates, title, book } =
          await marked();
        expect(vi.getTimerCount()).toBe(0);
        await projection.setActivity(gid(1), true);
        expect(title(1)).toBe(groupTitle("Work", "work", true));
        expect(updates).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(1);
        expect(PULSE_MS).toBeLessThanOrEqual(500);
        await vi.advanceTimersByTimeAsync(PULSE_MS - 50);
        expect(updates).toHaveLength(1); // no tick yet: no write
        const glyphs: string[] = [];
        for (let i = 0; i < 8; i++) {
          await vi.advanceTimersByTimeAsync(i === 0 ? 50 : PULSE_MS);
          glyphs.push(title(1)![0]!);
        }
        expect(glyphs).toEqual(["◎", "○", "◎", "◉", "◎", "○", "◎", "◉"]); // two breaths
        expect(updates).toHaveLength(9); // the set and one write per tick
        for (const u of updates.slice(1))
          expect(Object.keys(u.props)).toEqual(["title"]);
        expect(chrome.groups.get(gid(1))!.color).toBe("purple");
        expect(book.get("work")!.name).toBe("Work");
        expect(decodeGroupMarker(title(1))).toBe("work");
        // Another marked group pulses with its own tick; the timer is shared.
        await projection.setActivity(gid(3), true);
        expect(vi.getTimerCount()).toBe(1);
        await projection.setActivity(gid(1), false); // ends on a hollow or solid half: the restore is "⧉" either way
        expect(title(1)).toBe(groupTitle("Work", "work"));
        expect(chrome.groups.get(gid(1))!.color).toBe("blue");
        expect(vi.getTimerCount()).toBe(1);
        await projection.setActivity(gid(3), false);
        expect(vi.getTimerCount()).toBe(0);
        const count = updates.length;
        await vi.advanceTimersByTimeAsync(5_000);
        expect(updates).toHaveLength(count); // nothing more is written
      });

      it("a removed group or a deleted container stops the timer; the pulse does not touch a title the user retyped", async () => {
        vi.useFakeTimers();
        const { projection, chrome, gid, updates } = await marked();
        await projection.setActivity(gid(3), true);
        const g = gid(3);
        chrome.tabs.get(3)!.groupId = -1;
        chrome.groups.delete(g);
        await projection.groupRemoved(g);
        expect(vi.getTimerCount()).toBe(0);
        await projection.setActivity(gid(1), true);
        const count = updates.length;
        chrome.groups.get(gid(1))!.title = "Mine";
        await vi.advanceTimersByTimeAsync(2_000);
        expect(updates).toHaveLength(count);
        await projection.containerDeleted("work");
        expect(vi.getTimerCount()).toBe(0);
      });

      it("a hollow ○ in a typed title never reaches the container name, and a second ○ is refused", async () => {
        for (const typed of ["○ Job", " ○Job", "◉ Job", "◎ Job", "  ◎Job"]) {
          const { projection, chrome, gid, book } = await marked();
          await projection.setActivity(gid(1), true);
          const event = {
            id: gid(1),
            title: `${typed}${groupMarker("work")}`,
            color: "purple",
          };
          chrome.groups.get(gid(1))!.title = event.title;
          await projection.groupUpdated(event);
          await projection.idle();
          expect(book.get("work")!.name).toBe("Job");
        }
        const { projection, chrome, gid, book, logs } = await marked();
        const event = {
          id: gid(1),
          title: `○ ◎ Job${groupMarker("work")}`,
          color: "blue",
        };
        chrome.groups.get(gid(1))!.title = event.title;
        await projection.groupUpdated(event);
        await projection.idle();
        expect(book.get("work")!.name).toBe("Work");
        expect(chrome.groups.get(gid(1))!.title).toBe(
          groupTitle("Work", "work"),
        );
        expect(
          logs.some(([l, m]) => l === "warn" && /rename refused/.test(m)),
        ).toBe(true);
      });

      it("a leftover mark (◉ ◎ or ○, the agent's colour) is cleaned at the next start: title to ⧉ and the container's colour back", async () => {
        const { chrome, startup } = await restarted([
          { id: 50, title: groupTitle("Work", "work", true), color: "purple" },
          {
            id: 51,
            title: groupTitle("Home", "home", "hollow"),
            color: "purple",
          },
          { id: 52, title: "○ mine", color: "purple" }, // no marker: the user's own
          { id: 53, title: groupTitle("Work", "work", "mid"), color: "purple" },
        ]);
        expect(chrome.groups.get(50)).toMatchObject({
          title: groupTitle("Work", "work"),
          color: "blue",
        });
        expect(chrome.groups.get(51)).toMatchObject({
          title: groupTitle("Home", "home"),
          color: "cyan",
        });
        expect(chrome.groups.get(52)).toMatchObject({
          title: "○ mine",
          color: "purple",
        });
        expect(chrome.groups.get(53)).toMatchObject({
          title: groupTitle("Work", "work"),
          color: "blue",
        });
        expect(startup.ownedGroups().map(([id]) => id)).toEqual([50, 51, 53]);
      });

      it("the cleanup of title and colour also runs with groups off", async () => {
        const { chrome } = await restarted(
          [
            {
              id: 50,
              title: groupTitle("Work", "work", "hollow"),
              color: "purple",
            },
            {
              id: 51,
              title: groupTitle("Old", "deleted", true),
              color: "purple",
            },
          ],
          false,
        );
        expect(chrome.groups.get(50)).toMatchObject({
          title: groupTitle("Work", "work"),
          color: "blue",
        });
        // A deleted container has no colour to go back to: the title is cleaned, the colour left.
        expect(chrome.groups.get(51)).toMatchObject({
          title: groupTitle("Old", "deleted"),
          color: "purple",
        });
      });
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

    it("a removed group forgets its mark; switching groups off forgets all of them", async () => {
      const { projection, chrome, gid, updates } = await marked();
      const g = gid(1);
      await projection.setActivity(g, true);
      chrome.tabs.get(1)!.groupId = -1;
      chrome.tabs.get(2)!.groupId = -1;
      chrome.groups.delete(g);
      await projection.groupRemoved(g);
      const count = updates.length;
      await projection.setActivity(g, false); // nothing to restore, nothing thrown
      expect(updates).toHaveLength(count);
      const g3 = gid(3);
      await projection.setActivity(g3, true);
      await projection.releaseAll(); // the groups go with their tabs
      await projection.setActivity(g3, false);
      expect(updates).toHaveLength(count + 1); // the set only: no restore of a group that is gone
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
      const area = new MemoryStorageArea();
      const startup = new TabGroupProjection({
        tabs: chrome.api.tabs,
        tabGroups: {
          ...chrome.api.tabGroups,
          query: async () => [...chrome.groups.values()],
        },
        area,
        settings: () =>
          ({
            tabGroups: keep,
            agentActivity: true,
          }) as Settings,
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

    it("a leftover ◉ (the worker died while marked) is cleaned at the next start, by the invisible marker", async () => {
      const { chrome, startup } = await restarted([
        { id: 50, title: groupTitle("Work", "work", true) },
        { id: 51, title: groupTitle("Home", "home") },
        { id: 52, title: "◉ looks like ours" }, // no marker: the user's own
      ]);
      expect(chrome.groups.get(50)!.title).toBe(groupTitle("Work", "work"));
      expect(chrome.groups.get(51)!.title).toBe(groupTitle("Home", "home"));
      expect(chrome.groups.get(52)!.title).toBe("◉ looks like ours");
      expect(startup.ownedGroups().map(([id]) => id)).toEqual([50, 51]);
    });

    it("the cleanup also runs with groups off and for a container that is gone, and still leaves user groups alone", async () => {
      const { chrome } = await restarted(
        [
          { id: 50, title: groupTitle("Work", "work", true) },
          { id: 51, title: groupTitle("Old", "deleted", true) },
          { id: 52, title: "◉ mine" },
        ],
        false,
      );
      expect(chrome.groups.get(50)!.title).toBe(groupTitle("Work", "work"));
      expect(chrome.groups.get(51)!.title).toBe(groupTitle("Old", "deleted"));
      expect(chrome.groups.get(52)!.title).toBe("◉ mine");
    });

    it("the cleanup does not undo a mark that is live: the agent started before the adoption ran", async () => {
      const { chrome, startup } = await restarted([
        { id: 50, title: groupTitle("Work", "work") },
      ]);
      await startup.setActivity(50, true);
      await startup.adoptExisting();
      expect(chrome.groups.get(50)!.title).toBe(
        groupTitle("Work", "work", true),
      );
    });
  });
});
