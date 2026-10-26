import { describe, expect, it, vi } from "vitest";

import {
  chooseAddress,
  GroupGuard,
  type GuardTab,
  SETTLE_MS,
  SPLIT_TICK_MS,
} from "./group-guard";

function setup() {
  const tabs = new Map<number, GuardTab>();
  const groups = new Map<number, string>(); // groupId -> container the group stands for
  const containers = new Map<number, string>(); // tabId -> container
  const calls: string[] = [];
  const logs: Array<{ message: string; data?: unknown }> = [];
  const state = {
    assigning: new Set<number>(),
    waiting: new Set<number>(),
    own: new Map<number, "busy" | "own">(),
    failMoves: 0,
    failPlaces: 0,
    placeError: "Tabs cannot be edited right now (user may be dragging a tab).",
    failError: "Tabs cannot be edited right now (user may be dragging a tab).",
    clock: 100_000,
    nextTab: 500,
    periodic: [] as boolean[],
    failSplits: 0,
    delays: [] as number[],
    /** Runs on every delay (a settle, a retry): lets a test change Chrome's state while the guard waits. */
    onDelay: null as ((ms: number) => void) | null,
  };
  const guard = new GroupGuard({
    getTab: async (id) => tabs.get(id) ?? null,
    groupedTabs: async () => [...tabs.values()].filter((t) => t.groupId >= 0),
    groupContainer: async (g) => groups.get(g) ?? null,
    groupsIdle: async () => {},
    containerOf: (id) => containers.get(id) ?? null,
    isAssigning: (id) => state.assigning.has(id),
    isWaiting: (id) => state.waiting.has(id),
    ownTab: async (id) => state.own.get(id) ?? null,
    containerName: (id) => id.toUpperCase(),
    assignInPlace: async (id, target) => {
      calls.push(`assign ${id} ${target}`);
      containers.set(id, target);
    },
    move: async (id, target, url) => {
      if (state.failMoves > 0) {
        state.failMoves--;
        throw new Error(state.failError);
      }
      const fresh = state.nextTab++;
      calls.push(`move ${id} -> ${fresh} ${target} ${url}`);
      const old = tabs.get(id)!;
      tabs.delete(id);
      tabs.set(fresh, { id: fresh, url, groupId: old.groupId });
      containers.delete(id);
      containers.set(fresh, target);
      return fresh;
    },
    splitTabs: async (splitViewId) =>
      [...tabs.values()].filter((t) => t.splitViewId === splitViewId),
    ungroupSplit: async (ids) => {
      if (state.failSplits > 0) {
        state.failSplits--;
        calls.push(`ungroup-split-refused ${ids.join(",")}`);
        throw new Error(state.failError);
      }
      calls.push(`ungroup-split ${ids.join(",")}`);
      for (const id of ids) tabs.get(id)!.groupId = -1;
    },
    placeOwn: async (id, container) => {
      if (state.failPlaces > 0) {
        state.failPlaces--;
        calls.push(`place-refused ${id}`);
        throw new Error(state.placeError);
      }
      calls.push(`place ${id} ${container}`);
      tabs.get(id)!.groupId = -1;
    },
    moved: (id, target, name) =>
      void calls.push(`notice ${id} ${target} ${name}`),
    periodic: (on) => void state.periodic.push(on),
    log: (_level, message, data) => void logs.push({ message, data }),
    delay: async (ms) => {
      state.delays.push(ms);
      state.onDelay?.(ms);
    },
    now: () => state.clock,
  });
  groups.set(10, "reddit");
  groups.set(11, "work");
  const tab = (
    id: number,
    groupId: number,
    container: string | null,
    extra: Partial<GuardTab> = {},
  ) => {
    tabs.set(id, { id, url: "https://gitlab.example/x", groupId, ...extra });
    if (container) containers.set(id, container);
    else containers.delete(id);
  };
  return { guard, tabs, calls, logs, state, tab, containers };
}

describe("GroupGuard", () => {
  it("reopens a plain website dragged into a container group in that container, says so and logs from -> to", async () => {
    const { guard, tab, calls, logs } = setup();
    tab(1, 10, null);
    await guard.groupChanged(1, 10);
    expect(calls).toEqual([
      "move 1 -> 500 reddit https://gitlab.example/x",
      "notice 500 reddit REDDIT",
    ]);
    expect(logs.at(-1)!.message).toContain(
      "tab 1 no container -> reddit (moved into the group): reopened in it as tab 500",
    );
    expect(logs.at(-1)!.data).toMatchObject({
      tabId: 1,
      from: null,
      to: "reddit",
      action: "reopened",
      newTabId: 500,
    });
  });

  it("a website tab created inside the group (a duplicate) is reopened at the address it was created with, not where the unisolated copy was redirected to", async () => {
    const { guard, tab, tabs, calls, state } = setup();
    tab(1, 10, null, {
      url: "https://threads.example/@me",
      pendingUrl: "https://threads.example/@me",
    });
    const created = { ...tabs.get(1)! };
    // The logged-out real profile is sent to the sign-in page while the guard waits.
    state.onDelay = () => {
      tabs.set(1, {
        id: 1,
        groupId: 10,
        url: "https://threads.example/login?next=%2F%40me",
      });
    };
    await guard.tabCreated(created);
    expect(calls[0]).toBe("move 1 -> 500 reddit https://threads.example/@me");
    // The remembered address is gone with the check: a later drag of another tab with that ID uses where it stands.
    tab(2, 10, null, { url: "https://threads.example/other" });
    await guard.groupChanged(2, 10);
    expect(calls[2]).toBe("move 2 -> 501 reddit https://threads.example/other");
  });

  it("chooseAddress: the creation address first, then the pending one, then where the tab stands; never a non-website", () => {
    const stand = { groupId: 10, url: "https://a.example/now" };
    expect(chooseAddress(stand, "https://a.example/then")).toBe(
      "https://a.example/then",
    );
    expect(chooseAddress(stand)).toBe("https://a.example/now");
    expect(
      chooseAddress({ ...stand, pendingUrl: "https://a.example/next" }),
    ).toBe("https://a.example/next");
    expect(chooseAddress(stand, "chrome://newtab/")).toBe(
      "https://a.example/now",
    );
    expect(chooseAddress({ groupId: 10, url: "chrome://newtab/" })).toBeNull();
  });

  it("reopens a container tab dragged from one container group into another", async () => {
    const { guard, tab, calls } = setup();
    tab(1, 11, "reddit");
    await guard.groupChanged(1, 11);
    expect(calls[0]).toBe("move 1 -> 500 work https://gitlab.example/x");
  });

  it("assigns a tab Chrome created inside the group at once, however young, without loading anything", async () => {
    const { guard, tab, calls, logs } = setup();
    tab(1, 10, null, { url: "chrome://newtab/" });
    await guard.tabCreated({ id: 1, groupId: 10, url: "chrome://newtab/" });
    expect(calls).toEqual(["assign 1 reddit"]);
    expect(logs.at(-1)!.message).toContain(
      "(created in the group): assigned to it in place",
    );
    // A website Chrome created inside the group (its request is already out): reopened.
    tab(2, 10, null, { url: "", pendingUrl: "https://threads.example/" });
    await guard.tabCreated({
      id: 2,
      groupId: 10,
      url: "",
      pendingUrl: "https://threads.example/",
    });
    expect(calls[1]).toBe("move 2 -> 500 reddit https://threads.example/");
    // Created outside any group: nothing.
    tab(3, -1, null);
    await guard.tabCreated({ id: 3, groupId: -1 });
    expect(calls).toHaveLength(3);
  });

  it("assigns unloaded, discarded, non-website and restore-held tabs in place", async () => {
    const { guard, tab, calls, state } = setup();
    tab(1, 10, null, { status: "unloaded" });
    tab(2, 10, "work", { discarded: true });
    tab(3, 10, null, { url: "about:blank" });
    tab(4, 10, null, { url: "chrome-extension://abc/held.html?u=x" });
    state.waiting.add(4);
    for (const id of [1, 2, 3, 4]) await guard.groupChanged(id, 10);
    expect(calls).toEqual([
      "assign 1 reddit",
      "assign 2 reddit",
      "assign 3 reddit",
      "assign 4 reddit",
    ]);
  });

  it("leaves alone: a tab already in the group's container, leaving a group, groups that are not SplitSession's", async () => {
    const { guard, tab, calls } = setup();
    tab(1, 10, "reddit"); // SplitSession grouped it itself
    tab(2, -1, "reddit");
    tab(3, 99, null); // a group the user made
    tab(4, 99, "reddit");
    await guard.groupChanged(1, 10);
    await guard.groupChanged(2, -1);
    await guard.groupChanged(3, 99);
    await guard.groupChanged(4, 99);
    expect(await guard.sweep()).toBe(0);
    expect(calls).toEqual([]);
  });

  it("fixes the group, not the container, of a tab SplitSession created itself; waits while it is still being set up", async () => {
    const { guard, tab, calls, state } = setup();
    tab(1, 10, "work"); // a domain rule opened it at the place of a tab of the reddit group
    state.own.set(1, "busy");
    const pending = guard.tabCreated({
      id: 1,
      groupId: 10,
      url: "about:blank",
    });
    await Promise.resolve();
    state.own.set(1, "own");
    await pending;
    tab(2, 10, null); // the choose page's "no container"
    state.own.set(2, "own");
    await guard.tabCreated({ id: 2, groupId: 10 });
    expect(calls).toEqual(["place 1 work", "place 2 null"]);
  });

  it("waits for an assignment under way (a popup child inheriting) and then finds nothing to do", async () => {
    const { guard, tab, calls, state, containers } = setup();
    tab(1, 10, null, { url: "about:blank#facet-abc123" });
    state.assigning.add(1);
    let looks = 0;
    const realDelay = async () => {
      if (++looks === 3) {
        state.assigning.delete(1);
        containers.set(1, "reddit");
      }
    };
    (guard as unknown as { delay: () => Promise<void> }).delay = realDelay;
    await guard.tabCreated({
      id: 1,
      groupId: 10,
      url: "about:blank#facet-abc123",
    });
    expect(calls).toEqual([]);
  });

  it("waits while Chrome refuses edits during the drag, checks again before acting, and logs any other failure", async () => {
    const { guard, tab, calls, state } = setup();
    tab(1, 10, null);
    state.failMoves = 3;
    await guard.groupChanged(1, 10);
    expect(calls[0]).toContain("move 1 -> 500 reddit");
    // Dropped elsewhere while it was refused: nothing happens.
    const second = setup();
    second.tab(2, 10, null);
    second.state.failMoves = 1;
    const pending = second.guard.groupChanged(2, 10);
    second.tab(2, 99, null);
    await pending;
    expect(second.calls).toEqual([]);
    // Another error: logged, and the next sweep tries again.
    const third = setup();
    third.tab(3, 10, null);
    third.state.failMoves = 1;
    third.state.failError = "No tab with id 3";
    await third.guard.groupChanged(3, 10);
    expect(third.calls).toEqual([]);
    expect(
      third.logs.some((l) =>
        l.message.includes("could not be reopened in reddit"),
      ),
    ).toBe(true);
    await third.guard.sweep();
    expect(third.calls[0]).toContain("move 3 -> 500 reddit");
  });

  it("the sweep fixes every tab sitting in a container group outside its container, and keeps the alarm only while such groups exist", async () => {
    const { guard, tab, calls, state, logs } = setup();
    tab(1, 10, null); // a plain website left in the group
    tab(2, 10, "reddit");
    tab(3, 11, null, { status: "unloaded" });
    tab(4, 99, null);
    expect(await guard.sweep("worker started")).toBe(2);
    expect([...calls].sort()).toEqual([
      "assign 3 work",
      "move 1 -> 500 reddit https://gitlab.example/x",
      "notice 500 reddit REDDIT",
    ]);
    expect(
      logs.some((l) => l.message.includes("(sweep: worker started)")),
    ).toBe(true);
    expect(state.periodic.at(-1)).toBe(true);
    const bare = setup();
    bare.tab(1, 99, null);
    await bare.guard.sweep();
    expect(bare.state.periodic.at(-1)).toBe(false);
  });

  it("handles each tab once at a time and stops a runaway (logged, left for the next sweep)", async () => {
    const { guard, tab, calls, logs } = setup();
    tab(1, 10, null);
    await Promise.all([guard.groupChanged(1, 10), guard.groupChanged(1, 10)]);
    expect(calls.filter((c) => c.startsWith("move"))).toHaveLength(1); // the second finds the tab gone
    for (let i = 0; i < 20; i++) {
      tab(100 + i, 10, null);
      await guard.groupChanged(100 + i, 10);
    }
    expect(
      calls.filter((c) => c.startsWith("move")).length,
    ).toBeLessThanOrEqual(10);
    expect(
      logs.some((l) =>
        l.message.includes("the rest wait for a sweep just after the window"),
      ),
    ).toBe(true);
  });

  it("retries SplitSession’s own tab after the drop while the group call is refused, even after ownTab forgot it", async () => {
    const { guard, tab, calls, state, logs } = setup();
    tab(1, 10, "work"); // a domain rule opened it at the place of a tab of the reddit group
    state.own.set(1, "own");
    state.failPlaces = 3;
    let looks = 0;
    (guard as unknown as { delay: () => Promise<void> }).delay = async () => {
      // The first delay is the split-view tick before the first look; the five seconds run out after that look, while
      // the user still holds the drag.
      if (++looks === 2) state.own.delete(1);
    };
    await guard.tabCreated({ id: 1, groupId: 10, url: "about:blank" });
    expect(calls).toEqual([
      "place-refused 1",
      "place-refused 1",
      "place-refused 1",
      "place 1 work",
    ]);
    expect(calls.some((c) => c.startsWith("move"))).toBe(false);
    // Fixed: the tab is a tab like any other again (dragged into the group later, it is reopened).
    tab(1, 10, "work");
    expect(await guard.sweep()).toBe(1);
    expect(calls.at(-1)).toMatch(/^notice /);
    expect(
      logs.some((l) =>
        l.message.includes(
          "SplitSession's own tab, moved to the group of work",
        ),
      ),
    ).toBe(true);
  });

  it("an own tab that could not be fixed (another error) is fixed by the next sweep, never reopened", async () => {
    const { guard, tab, calls, state, logs } = setup();
    tab(1, 10, "work");
    state.own.set(1, "own");
    state.failPlaces = 1;
    state.placeError = "No group with id 7";
    await guard.tabCreated({ id: 1, groupId: 10 });
    expect(
      logs.some((l) =>
        l.message.includes("tab 1 (created in the group) failed"),
      ),
    ).toBe(true);
    state.own.delete(1);
    await guard.sweep();
    expect(calls).toEqual(["place-refused 1", "place 1 work"]);
  });

  it("assignments in place are free; only reopening counts toward the limit, and the rest is swept right after the window", async () => {
    vi.useFakeTimers();
    try {
      const { guard, tab, calls, state, logs } = setup();
      for (let i = 0; i < 15; i++)
        tab(200 + i, 10, null, { status: "unloaded" });
      expect(await guard.sweep()).toBe(15);
      expect(calls.filter((c) => c.startsWith("assign"))).toHaveLength(15);
      expect(logs.some((l) => l.message.includes("more than"))).toBe(false);

      for (let i = 0; i < 15; i++) tab(300 + i, 10, null);
      expect(await guard.sweep()).toBe(15);
      expect(calls.filter((c) => c.startsWith("move"))).toHaveLength(10);
      expect(logs.filter((l) => l.message.includes("more than"))).toHaveLength(
        1,
      );
      state.clock += 10_100;
      await vi.advanceTimersByTimeAsync(10_100);
      await guard.idle();
      expect(calls.filter((c) => c.startsWith("move"))).toHaveLength(15);
      expect([...state.periodic].length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  describe("split view: two accounts side by side", () => {
    it("a plain tab joined into a split view with a container tab of the group: both leave the group, nothing reopened or assigned", async () => {
      const { guard, tab, calls, logs, containers, tabs } = setup();
      tab(1, 10, "reddit", { splitViewId: 7 });
      tab(2, 10, null, { splitViewId: 7 }); // Chrome put the joined tab into the reddit group
      await guard.groupChanged(2, 10);
      expect(calls).toEqual(["ungroup-split 1,2"]);
      expect(tabs.get(1)!.groupId).toBe(-1);
      expect(tabs.get(2)!.groupId).toBe(-1);
      expect(containers.get(1)).toBe("reddit");
      expect(containers.has(2)).toBe(false);
      expect(logs.at(-1)!.message).toContain(
        "tab 2 no container -> reddit (moved into the group): in a split view not all of this container",
      );
      expect(logs.at(-1)!.data).toMatchObject({
        action: "split view ungrouped",
        splitViewId: 7,
        tabs: [1, 2],
        containers: ["reddit", null],
      });
    });

    it("two containers in one split view: both leave the group and keep their containers", async () => {
      const { guard, tab, calls, containers } = setup();
      tab(1, 10, "reddit", { splitViewId: 7 });
      tab(2, 10, "work", { splitViewId: 7 }); // the work tab joined, Chrome moved it into the reddit group
      await guard.groupChanged(2, 10);
      expect(calls).toEqual(["ungroup-split 1,2"]);
      expect(containers.get(1)).toBe("reddit");
      expect(containers.get(2)).toBe("work");
    });

    it("a split view all of the group's container stays in the group", async () => {
      const { guard, tab, calls } = setup();
      tab(1, 10, "reddit", { splitViewId: 7 });
      tab(2, 10, "reddit", { splitViewId: 7 });
      await guard.groupChanged(2, 10);
      expect(await guard.sweep()).toBe(0);
      expect(calls).toEqual([]);
    });

    it("a split view of one container dragged into another container's group is taken out, never reopened", async () => {
      const { guard, tab, calls, containers } = setup();
      tab(1, 11, "reddit", { splitViewId: 7 });
      tab(2, 11, "reddit", { splitViewId: 7 });
      await guard.groupChanged(1, 11);
      await guard.groupChanged(2, 11);
      expect(calls).toEqual(["ungroup-split 1,2"]);
      expect(containers.get(1)).toBe("reddit");
      expect(containers.get(2)).toBe("reddit");
    });

    it("Chrome reports the group before the split view: the decision waits for the settle and reads the tab again", async () => {
      const { guard, tab, calls, state, tabs } = setup();
      tab(1, 10, "reddit");
      tab(2, 10, null); // groupId reported, splitViewId not yet
      state.onDelay = () => {
        tabs.get(1)!.splitViewId = 7;
        tabs.get(2)!.splitViewId = 7;
      };
      await guard.groupChanged(2, 10);
      expect(state.delays[0]).toBe(SETTLE_MS);
      expect(calls).toEqual(["ungroup-split 1,2"]);
    });

    it("a new tab page Chrome creates inside the group as part of a split view is not assigned (the split view may be reported after it)", async () => {
      const { guard, tab, calls, state, tabs, containers } = setup();
      tab(1, 10, "reddit");
      tab(2, 10, null, { url: "chrome://newtab/" });
      state.onDelay = () => {
        tabs.get(1)!.splitViewId = 7;
        tabs.get(2)!.splitViewId = 7;
      };
      await guard.tabCreated({ id: 2, groupId: 10, url: "chrome://newtab/" });
      expect(state.delays[0]).toBe(SPLIT_TICK_MS);
      expect(calls).toEqual(["ungroup-split 1,2"]);
      expect(containers.has(2)).toBe(false);
    });

    it("SPLIT_VIEW_ID_NONE (-1) or no splitViewId at all (Chrome before 140): the usual reopening", async () => {
      const { guard, tab, calls } = setup();
      tab(1, 10, null, { splitViewId: -1 });
      tab(2, 10, null);
      await guard.groupChanged(1, 10);
      await guard.groupChanged(2, 10);
      expect(calls.filter((c) => c.startsWith("move"))).toHaveLength(2);
      expect(calls.some((c) => c.startsWith("ungroup-split"))).toBe(false);
    });

    it("waits while Chrome refuses the ungroup during a drag, then takes the pair out; the sweep finds a mixed pair too", async () => {
      const { guard, tab, calls, state } = setup();
      tab(1, 10, "reddit", { splitViewId: 7 });
      tab(2, 10, "work", { splitViewId: 7 });
      state.failSplits = 2;
      await guard.groupChanged(2, 10);
      expect(calls).toEqual([
        "ungroup-split-refused 1,2",
        "ungroup-split-refused 1,2",
        "ungroup-split 1,2",
      ]);

      const other = setup();
      other.tab(1, 10, "reddit", { splitViewId: 8 });
      other.tab(2, 10, null, { splitViewId: 8 });
      expect(await other.guard.sweep()).toBe(1);
      expect(other.calls).toEqual(["ungroup-split 1,2"]);
    });

    it("waits while the partner is being assigned, then decides with its real container", async () => {
      const { guard, tab, calls, state, containers } = setup();
      tab(1, 10, "reddit", { splitViewId: 7 });
      tab(2, 10, null, { splitViewId: 7 });
      state.assigning.add(1);
      let waits = 0;
      state.onDelay = (ms) => {
        if (ms !== SETTLE_MS && ++waits === 2) {
          state.assigning.delete(1);
          containers.set(2, "reddit"); // both ended up in reddit
        }
      };
      await guard.groupChanged(2, 10);
      expect(calls).toEqual([]);
    });
  });
});
