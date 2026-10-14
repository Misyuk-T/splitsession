import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AGENT_COLOR, CONTAINER_HEX } from "../core";
import { BadgeIndicator, BLINK_STEP_MS, HELD_COLOR } from "./badges";

interface Paint {
  text: string;
  color: string;
}

function setup(
  o: {
    bridge?: boolean;
    containers?: Record<number, "blue" | "purple">;
    held?: number[];
  } = {},
) {
  const state = { bridge: o.bridge ?? true };
  const tabs = new Map<number, Paint>();
  let global: Paint = { text: "", color: "" };
  const paint = (tabId: number | undefined, patch: Partial<Paint>) => {
    if (tabId === undefined) global = { ...global, ...patch };
    else
      tabs.set(tabId, {
        ...(tabs.get(tabId) ?? { text: "", color: "" }),
        ...patch,
      });
  };
  const action = {
    setBadgeText: vi.fn(async (d: { tabId?: number; text: string }) =>
      paint(d.tabId, { text: d.text }),
    ),
    setBadgeBackgroundColor: vi.fn(
      async (d: { tabId?: number; color: string }) =>
        paint(d.tabId, { color: d.color }),
    ),
  };
  const badges = new BadgeIndicator(action, {
    containerOf: (id) => (o.containers?.[id] ? `c${id}` : null),
    container: (id) => {
      const tabId = Number(id.slice(1));
      return { id, color: o.containers![tabId]! } as never;
    },
    bridgeOn: () => state.bridge,
    isHeld: (id) => o.held?.includes(id) ?? false,
    heldCount: () => o.held?.length ?? 0,
  });
  return { badges, state, tabs, action, global: () => global };
}

describe("BadgeIndicator: the agent dot", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("bridge on, idle: a plain tab has a purple dot (one space), no letters", async () => {
    const { badges, tabs } = setup();
    await badges.apply(1);
    expect(tabs.get(1)).toEqual({ text: " ", color: AGENT_COLOR });
  });

  it("bridge off: no dot on a plain tab, the container dot stays on a container tab", async () => {
    const { badges, tabs } = setup({
      bridge: false,
      containers: { 2: "blue" },
    });
    await badges.apply(1);
    await badges.apply(2);
    expect(tabs.get(1)!.text).toBe("");
    expect(tabs.get(2)).toEqual({ text: " ", color: CONTAINER_HEX.blue });
  });

  it("a container tab keeps its container colour with the bridge on (no ON)", async () => {
    const { badges, tabs } = setup({ containers: { 2: "blue" } });
    await badges.apply(2);
    expect(tabs.get(2)).toEqual({ text: " ", color: CONTAINER_HEX.blue });
  });

  it("the global default is the purple dot with the bridge on", async () => {
    const { badges, global } = setup();
    await badges.applyGlobal();
    expect(global()).toEqual({ text: " ", color: AGENT_COLOR });
  });

  it("blinks the tab's dot between purple and a lighter purple, twice a second, and stops on stopBlink", async () => {
    const { badges, tabs } = setup();
    badges.startBlink(1);
    await vi.advanceTimersByTimeAsync(0);
    const seen = new Set<string>();
    for (let i = 0; i < 8; i++) {
      seen.add(tabs.get(1)!.color);
      await vi.advanceTimersByTimeAsync(BLINK_STEP_MS);
    }
    expect(seen.size).toBeGreaterThanOrEqual(3); // purple, the in-between, the light purple
    expect(seen.has(AGENT_COLOR)).toBe(true);
    // One full cycle is 4 steps = 500 ms: back to purple after it.
    await vi.advanceTimersByTimeAsync(BLINK_STEP_MS * 4);
    expect(tabs.get(1)!.color).toBe(AGENT_COLOR);

    await badges.stopBlink(1);
    expect(badges.blinkingTabs()).toEqual([]);
    expect(tabs.get(1)).toEqual({ text: " ", color: AGENT_COLOR });
    const calls = vi.getTimerCount();
    expect(calls).toBe(0); // no leaked interval
  });

  it("blinks a container tab between its colour and purple (a purple container to the light purple)", async () => {
    const { badges, tabs } = setup({ containers: { 2: "blue", 3: "purple" } });
    badges.startBlink(2);
    badges.startBlink(3);
    const blue = new Set<string>();
    const purple = new Set<string>();
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(BLINK_STEP_MS);
      blue.add(tabs.get(2)!.color);
      purple.add(tabs.get(3)!.color);
    }
    expect(blue.has(CONTAINER_HEX.blue)).toBe(true);
    expect(blue.has(AGENT_COLOR)).toBe(true);
    expect(purple.size).toBeGreaterThanOrEqual(3);
    await badges.stopAllBlinks();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starting again does not add a second timer; no blink while the bridge is off", () => {
    const { badges, state } = setup();
    badges.startBlink(1);
    badges.startBlink(1);
    expect(vi.getTimerCount()).toBe(1);
    state.bridge = false;
    badges.startBlink(2);
    expect(badges.blinkingTabs()).toEqual([1]);
  });

  it("the bridge going off ends the blink at the next paint; a closed tab ends it at once", async () => {
    const { badges, state, tabs } = setup();
    badges.startBlink(1);
    badges.startBlink(2);
    badges.forget(2);
    expect(badges.blinkingTabs()).toEqual([1]);
    state.bridge = false;
    await vi.advanceTimersByTimeAsync(BLINK_STEP_MS);
    expect(badges.blinkingTabs()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(tabs.get(1)!.text).toBe("");
  });

  it("a held tab keeps its red ! while the agent blinks on it (held has priority)", async () => {
    const { badges, tabs } = setup({ held: [1] });
    badges.startBlink(1);
    await vi.advanceTimersByTimeAsync(BLINK_STEP_MS * 3);
    expect(tabs.get(1)).toEqual({ text: "!", color: HELD_COLOR });
    await badges.stopAllBlinks();
  });

  it("a notice keeps priority over the blink on a container tab", async () => {
    const { badges, tabs } = setup({ containers: { 2: "blue" } });
    await badges.notice(2, "moved to “x”", 10_000);
    badges.startBlink(2);
    await vi.advanceTimersByTimeAsync(BLINK_STEP_MS * 3);
    expect(tabs.get(2)).toEqual({ text: "→", color: CONTAINER_HEX.blue });
    await badges.stopAllBlinks();
  });
});
