import { describe, expect, it } from "vitest";

import { GroupMark, OUTSIDE_GROUP_MESSAGE } from "./group-mark";

function setup(
  options: { groupsOn?: boolean; groups?: Record<number, string | null> } = {},
) {
  const state = {
    containers: new Map<number, string>(),
    groupOfTab: new Map<number, number>(),
    groupsOn: options.groupsOn ?? true,
    groups: options.groups ?? ({} as Record<number, string | null>),
    sent: [] as Array<{ tabId: number; outside: boolean }>,
    idle: 0,
  };
  const mark = new GroupMark({
    containerOf: (id) => state.containers.get(id) ?? null,
    groupOf: async (id) => state.groupOfTab.get(id) ?? null,
    groupContainer: async (g) => state.groups[g] ?? null,
    groupsOn: () => state.groupsOn,
    groupsIdle: async () => void state.idle++,
    send: async (tabId, message) => {
      expect(message.type).toBe(OUTSIDE_GROUP_MESSAGE);
      state.sent.push({ tabId, outside: message.outside });
    },
  });
  return { state, mark };
}

describe("GroupMark", () => {
  it("is outside when a container tab has no group, or sits in another container's group", async () => {
    const { state, mark } = setup({ groups: { 5: "work", 6: "home" } });
    state.containers.set(1, "work");
    state.groupOfTab.set(1, -1);
    expect(await mark.isOutside(1)).toBe(true);
    state.groupOfTab.set(1, 5);
    expect(await mark.isOutside(1)).toBe(false);
    state.groupOfTab.set(1, 6);
    expect(await mark.isOutside(1)).toBe(true);
    state.groupOfTab.set(1, 99); // a group of the user's own
    expect(await mark.isOutside(1)).toBe(true);
  });

  it("with tab groups off every container tab is outside, even one inside a group; ordinary tabs never", async () => {
    const { state, mark } = setup({ groupsOn: false, groups: { 5: "work" } });
    state.containers.set(1, "work");
    state.groupOfTab.set(1, 5);
    expect(await mark.isOutside(1)).toBe(true);
    expect(await mark.isOutside(2)).toBe(false);
  });

  it("waits for pending group changes before answering", async () => {
    const { state, mark } = setup();
    state.containers.set(1, "work");
    state.groupOfTab.set(1, -1);
    await mark.isOutside(1);
    expect(state.idle).toBe(1);
  });

  it("tells the page on every change, and an ordinary tab only when it was marked or has just left a container", async () => {
    const { state, mark } = setup({ groups: { 5: "work" } });
    state.containers.set(1, "work");
    state.groupOfTab.set(1, -1);
    await mark.refresh(1);
    state.groupOfTab.set(1, 5);
    await mark.refresh(1);
    expect(state.sent).toEqual([
      { tabId: 1, outside: true },
      { tabId: 1, outside: false },
    ]);

    await mark.refresh(2); // never a container tab: nothing to tell
    expect(state.sent).toHaveLength(2);

    // Marked, then left its container (still outside any group): the page is told to drop the mark.
    state.groupOfTab.set(1, -1);
    await mark.refresh(1);
    state.containers.delete(1);
    await mark.refresh(1);
    expect(state.sent.slice(2)).toEqual([
      { tabId: 1, outside: true },
      { tabId: 1, outside: false },
    ]);
    await mark.refresh(1); // already told
    expect(state.sent).toHaveLength(4);

    // A tab told nothing before (worker restarted) that leaves its container is told explicitly.
    await mark.refresh(3, true);
    expect(state.sent[4]).toEqual({ tabId: 3, outside: false });
  });
});
