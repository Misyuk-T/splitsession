import { describe, expect, it, vi } from "vitest";

import { GroupActivityMark } from "./group-activity";

/** Tabs -> groups; group ids >= 100 stand for containers, below that they are a user's plain groups. */
function setup(groupOf: Record<number, number | null>) {
  const calls: string[] = [];
  const mark = new GroupActivityMark({
    groupOf: async (tabId) => groupOf[tabId] ?? null,
    isContainerGroup: async (g) => g >= 100,
    setMark: async (g, on) => void calls.push(`${on ? "on" : "off"} ${g}`),
  });
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return { mark, calls, groupOf, settle };
}

describe("GroupActivityMark", () => {
  it("marks the group of the first active tab, once for a burst, and restores it when the last tab is done", async () => {
    const { mark, calls, settle } = setup({ 1: 100, 2: 100 });
    mark.start(1);
    mark.start(1);
    mark.start(1);
    await settle();
    expect(calls).toEqual(["on 100"]);
    mark.start(2); // a second tab of the same group
    await settle();
    expect(calls).toEqual(["on 100"]); // nothing new to show
    mark.stop(1);
    await settle();
    expect(calls).toEqual(["on 100"]); // tab 2 is still working
    mark.stop(2);
    await settle();
    expect(calls).toEqual(["on 100", "off 100"]);
  });

  it("does nothing for a plain group or an ungrouped tab", async () => {
    const { mark, calls, settle } = setup({ 1: 5, 2: -1, 3: null });
    mark.start(1);
    mark.start(2);
    mark.start(3);
    await settle();
    mark.stop(1);
    mark.stop(2);
    mark.stop(3);
    await settle();
    expect(calls).toEqual([]);
    expect(mark.activeTabs()).toEqual([]);
  });

  it("a tab that ends before its group is known marks nothing", async () => {
    const { mark, calls, settle } = setup({ 1: 100 });
    mark.start(1);
    mark.stop(1);
    await settle();
    expect(calls).toEqual([]);
  });

  it("a tab that leaves the group, or moves to another one, takes the mark with it", async () => {
    const { mark, calls, groupOf, settle } = setup({ 1: 100 });
    mark.start(1);
    await settle();
    groupOf[1] = 101;
    mark.groupChanged(1);
    await settle();
    expect(calls).toEqual(["on 100", "off 100", "on 101"]);
    groupOf[1] = -1;
    mark.groupChanged(1);
    await settle();
    expect(calls).toEqual(["on 100", "off 100", "on 101", "off 101"]);
    // Not active: a group change of an idle tab is none of its business.
    mark.stop(1);
    groupOf[1] = 100;
    mark.groupChanged(1);
    await settle();
    expect(calls).toHaveLength(4);
  });

  it("stopAll restores every marked group at once and forgets the tabs", async () => {
    const { mark, calls, settle } = setup({ 1: 100, 2: 101, 3: 5 });
    mark.start(1);
    mark.start(2);
    mark.start(3);
    await settle();
    await mark.stopAll();
    expect(calls.sort()).toEqual(["off 100", "off 101", "on 100", "on 101"]);
    expect(mark.activeTabs()).toEqual([]);
  });

  it("never throws: a failing lookup or title update is swallowed", async () => {
    const mark = new GroupActivityMark({
      groupOf: vi.fn(async () => {
        throw new Error("gone");
      }),
      isContainerGroup: async () => true,
      setMark: async () => {
        throw new Error("no group");
      },
    });
    mark.start(1);
    await new Promise((r) => setTimeout(r, 0));
    mark.stop(1);
    await mark.stopAll();
  });
});
