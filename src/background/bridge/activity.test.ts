import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ACTIVITY_TTL_MS, AgentActivity, ICON_TICK_MS } from "./activity";

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
  const activity = new AgentActivity({
    b: b as never,
    enabled: () => true,
    restoreBadge: async () => {},
  });
  return { activity, sent, injected, tabs, activate: () => onActivated?.() };
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
});
