import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ACTIVITY_TTL_MS,
  AgentActivity,
  ICON_TICK_MS,
  SESSION_TICK_MS,
} from "./activity";

function setup(tabs: Record<number, { active: boolean }>) {
  const sent: Array<{ id: number; message: unknown }> = [];
  const injected: Array<{ id: number; op: string }> = [];
  let onActivated: (() => void) | undefined;
  const b = {
    tabs: {
      get: vi.fn(async (id: number) => {
        if (!tabs[id]) throw new Error("no tab");
        return { id, ...tabs[id] };
      }),
      sendMessage: vi.fn(
        async (id: number, message: unknown) => void sent.push({ id, message }),
      ),
      onRemoved: { addListener: vi.fn() },
      onActivated: {
        addListener: vi.fn((cb: () => void) => (onActivated = cb)),
      },
    },
    scripting: {
      executeScript: vi.fn(
        async (o: {
          target: { tabId: number };
          args: Array<{ op: string }>;
        }) => {
          injected.push({ id: o.target.tabId, op: o.args[0]!.op });
          return [{ result: true }];
        },
      ),
    },
    action: {
      setBadgeText: vi.fn(async () => {}),
      setBadgeBackgroundColor: vi.fn(async () => {}),
    },
  };
  const blink = { start: vi.fn(), stop: vi.fn(async () => {}) };
  const state = { enabled: true };
  const groupMark = {
    start: vi.fn(),
    stop: vi.fn(),
    stopAll: vi.fn(async () => {}),
  };
  const activity = new AgentActivity({
    b: b as never,
    enabled: () => state.enabled,
    startBlink: blink.start,
    stopBlink: blink.stop,
    groupMark,
  });
  return {
    activity,
    sent,
    injected,
    tabs,
    blink,
    groupMark,
    state,
    activate: () => onActivated?.(),
  };
}

describe("AgentActivity: favicon ticks and the action layer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps the bright layer on between actions that come every 3 s (it must not fade out and in again)", () => {
    expect(ACTIVITY_TTL_MS).toBeGreaterThan(3_000);
  });

  it("nudges a tab in the background ~30 times a second, and leaves the tab in front alone", async () => {
    const { activity, sent, tabs } = setup({
      1: { active: false },
      2: { active: true },
    });
    await activity.touch(1, "get_tab_text");
    await activity.touch(2, "get_tab_text");
    await vi.advanceTimersByTimeAsync(ICON_TICK_MS * 30);
    const to1 = sent.filter((s) => s.id === 1);
    expect(to1.length).toBeGreaterThanOrEqual(28);
    expect(to1.length).toBeLessThanOrEqual(31);
    expect(to1[0]!.message).toEqual({ facetAgentTick: 1 });
    expect(sent.some((s) => s.id === 2)).toBe(false);

    // The user switches to tab 1 and away from tab 2: the nudges follow.
    tabs[1]!.active = true;
    tabs[2]!.active = false;
    const activate = (
      activity as unknown as { refreshBackground(): Promise<void> }
    ).refreshBackground.bind(activity);
    await activate();
    sent.length = 0;
    await vi.advanceTimersByTimeAsync(ICON_TICK_MS * 10);
    expect(sent.some((s) => s.id === 1)).toBe(false);
    expect(sent.filter((s) => s.id === 2).length).toBeGreaterThanOrEqual(9);
  });

  it("stops the ticker when the setting goes off or the session ends", async () => {
    const { activity, sent } = setup({ 1: { active: false } });
    await activity.touch(1, "click");
    await vi.advanceTimersByTimeAsync(ICON_TICK_MS * 3);
    expect(sent.length).toBeGreaterThan(0);
    await activity.stopAll();
    sent.length = 0;
    await vi.advanceTimersByTimeAsync(ICON_TICK_MS * 10);
    expect(sent).toHaveLength(0);
  });

  it("sends no ticks to a page that cannot be scripted", async () => {
    const { activity, sent } = setup({ 1: { active: false } });
    const executeScript = (
      activity as unknown as {
        d: { b: { scripting: { executeScript: unknown } } };
      }
    ).d.b.scripting;
    executeScript.executeScript = vi.fn(async () => {
      throw new Error("cannot access chrome://");
    });
    await activity.touch(1, "click");
    await vi.advanceTimersByTimeAsync(ICON_TICK_MS * 10);
    expect(sent).toHaveLength(0);
  });

  it("blinks the dot of the touched tab from the first action, re-arms it on each action and ends it ~3.65 s after the last", async () => {
    const { activity, blink } = setup({ 1: { active: true } });
    await activity.touch(1, "click");
    expect(blink.start).toHaveBeenCalledWith(1);
    await vi.advanceTimersByTimeAsync(3_000);
    await activity.touch(1, "click"); // re-arms the end
    await vi.advanceTimersByTimeAsync(3_000);
    expect(blink.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(ACTIVITY_TTL_MS);
    expect(blink.stop).toHaveBeenCalledTimes(1);
    expect(blink.stop).toHaveBeenCalledWith(1);
  });

  it('no blink for tools that touch no tab, or with "Show agent activity" off', async () => {
    const { activity, blink, state } = setup({ 1: { active: true } });
    await activity.touch(1, "list_tabs");
    state.enabled = false;
    await activity.touch(1, "click");
    expect(blink.start).not.toHaveBeenCalled();
  });

  it("stopAll and a closed tab end the blink at once and leave no timer behind", async () => {
    const { activity, blink } = setup({
      1: { active: true },
      2: { active: true },
    });
    await activity.touch(1, "click");
    await activity.touch(2, "click");
    activity.forget(2);
    expect(blink.stop).toHaveBeenCalledWith(2);
    await activity.stopAll();
    expect(blink.stop).toHaveBeenCalledWith(1);
    await vi.advanceTimersByTimeAsync(SESSION_TICK_MS * 10);
    expect(blink.stop).toHaveBeenCalledTimes(2); // no late end timers
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the group mark runs on the toolbar dot's clock: starts with the first action, ends with the dot, never has a timer of its own", async () => {
    const { activity, blink, groupMark } = setup({ 1: { active: true } });
    await activity.touch(1, "click");
    await activity.touch(1, "click");
    expect(groupMark.start).toHaveBeenCalledWith(1);
    expect(groupMark.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3_000);
    await activity.touch(1, "click"); // re-arms the end for both
    await vi.advanceTimersByTimeAsync(3_000);
    expect(groupMark.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(ACTIVITY_TTL_MS);
    expect(groupMark.stop).toHaveBeenCalledTimes(1);
    expect(groupMark.stop).toHaveBeenCalledWith(1);
    expect(blink.stop).toHaveBeenCalledTimes(1); // the same moment as the dot
  });

  it('no group mark for tools that touch no tab, or with "Show agent activity" off; stopAll and a closed tab restore it', async () => {
    const { activity, groupMark, state } = setup({
      1: { active: true },
      2: { active: true },
    });
    await activity.touch(1, "list_tabs");
    state.enabled = false;
    await activity.touch(1, "click");
    expect(groupMark.start).not.toHaveBeenCalled();
    state.enabled = true;
    await activity.touch(1, "click");
    await activity.touch(2, "click");
    activity.forget(2);
    expect(groupMark.stop).toHaveBeenCalledWith(2);
    await activity.stopAll();
    expect(groupMark.stopAll).toHaveBeenCalledTimes(1);
  });
});
