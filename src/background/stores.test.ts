import { describe, expect, it } from "vitest";

import type { Container } from "../core";
import { MemoryStorageArea } from "../engine/storage/storage-area";
import { BadgeIndicator } from "./badges";
import { ExemptionManager, EXEMPTIONS_KEY } from "./exemption-manager";
import { RuleError, RuleStore } from "./rule-store";
import { SettingsStore } from "./settings-store";

describe("SettingsStore", () => {
  it("starts with the defaults, validates, persists and notifies", async () => {
    const area = new MemoryStorageArea();
    const store = new SettingsStore(area);
    expect(await store.load()).toEqual({
      tabGroups: true,
      titlePrefix: true,
      strictMode: false,
      showNameToPages: false,
      agentBridge: false,
      agentActivity: true,
      restoreTabs: true,
    });
    const seen: string[] = [];
    store.onChange((next, prev) =>
      seen.push(`${prev.tabGroups}->${next.tabGroups}`),
    );
    expect(await store.update({ tabGroups: false })).toEqual({
      tabGroups: false,
      titlePrefix: true,
      strictMode: false,
      showNameToPages: false,
      agentBridge: false,
      agentActivity: true,
      restoreTabs: true,
    });
    expect(seen).toEqual(["true->false"]);
    expect(area.data.get("settings")).toEqual({
      tabGroups: false,
      titlePrefix: true,
      strictMode: false,
      showNameToPages: false,
      agentBridge: false,
      agentActivity: true,
      restoreTabs: true,
      explicit: ["tabGroups"],
    });
    await expect(store.update({ tabGroups: "no" })).rejects.toThrow();
    expect(store.get().tabGroups).toBe(false); // a rejected patch changes nothing

    const reloaded = new SettingsStore(area);
    expect(await reloaded.load()).toEqual({
      tabGroups: false,
      titlePrefix: true,
      strictMode: false,
      showNameToPages: false,
      agentBridge: false,
      agentActivity: true,
      restoreTabs: true,
    });
  });

  it("turning the name on is remembered as a choice; an install of the previous format gets the new default once", async () => {
    const area = new MemoryStorageArea();
    // Previous format: every value stored on any change, the name shown by default.
    await area.set({
      settings: {
        tabGroups: false,
        titlePrefix: true,
        strictMode: true,
        showNameToPages: true,
      },
    });
    const store = new SettingsStore(area);
    expect(await store.load()).toEqual({
      tabGroups: false,
      titlePrefix: true,
      strictMode: false,
      showNameToPages: false,
      agentBridge: false,
      agentActivity: true,
      restoreTabs: true,
    });
    expect(area.data.get("settings")).toEqual({
      tabGroups: false,
      titlePrefix: true,
      strictMode: false,
      showNameToPages: false,
      agentBridge: false,
      agentActivity: true,
      restoreTabs: true,
      explicit: ["tabGroups"],
    });

    await store.update({ showNameToPages: true });
    const reloaded = new SettingsStore(area);
    expect(await reloaded.load()).toMatchObject({
      tabGroups: false,
      showNameToPages: true,
    });
    expect(
      (area.data.get("settings") as { explicit: string[] }).explicit,
    ).toEqual(["tabGroups", "showNameToPages"]);
  });

  it("a throwing listener does not break the update", async () => {
    const store = new SettingsStore(new MemoryStorageArea());
    store.onChange(() => {
      throw new Error("boom");
    });
    await expect(store.update({ titlePrefix: false })).resolves.toMatchObject({
      titlePrefix: false,
    });
  });
});

describe("RuleStore", () => {
  const known = new Set(["work", "home"]);
  const make = () => {
    const area = new MemoryStorageArea();
    return { area, store: new RuleStore(area, () => known) };
  };

  it("normalises domains, keeps one rule per site, sorted, and persists", async () => {
    const { area, store } = make();
    await store.set({ domain: "https://www.reddit.com/r/x", action: "ask" });
    await store.set({
      domain: "GitHub.com",
      action: "always",
      containerId: "work",
    });
    await store.set({
      domain: "gist.github.com",
      action: "always",
      containerId: "home",
    }); // replaces github.com
    expect(store.list()).toEqual([
      { domain: "github.com", action: "always", containerId: "home" },
      { domain: "reddit.com", action: "ask" },
    ]);
    expect(area.data.get("domainRules")).toEqual(store.list());
  });

  it("refuses invalid rules without changing anything", async () => {
    const { store } = make();
    await expect(
      store.set({ domain: "a.com", action: "always", containerId: "nope" }),
    ).rejects.toThrow(RuleError);
    await expect(store.set({ domain: "org", action: "ask" })).rejects.toThrow(
      /public suffix/,
    );
    expect(store.list()).toEqual([]);
  });

  it("loads tolerantly: junk entries and rules of vanished containers are dropped", async () => {
    const area = new MemoryStorageArea();
    await area.set({
      domainRules: [
        { domain: "ok.com", action: "always", containerId: "work" },
        { domain: "gone.com", action: "always", containerId: "deleted" },
        { domain: "ask.com", action: "ask" },
        { nonsense: true },
        "x",
      ],
    });
    const store = new RuleStore(area, () => known);
    await store.load();
    expect(store.list().map((r) => r.domain)).toEqual(["ask.com", "ok.com"]);
  });

  it("remove accepts what the user typed; pruneDeleted follows the container list", async () => {
    const live = new Set(["work"]);
    const store = new RuleStore(new MemoryStorageArea(), () => live);
    await store.set({ domain: "a.com", action: "always", containerId: "work" });
    await store.set({ domain: "b.com", action: "ask" });
    expect(await store.remove("https://www.b.com/page")).toBe(true);
    expect(await store.remove("b.com")).toBe(false);
    live.clear();
    expect(await store.pruneDeleted()).toBe(1);
    expect(store.list()).toEqual([]);
  });

  it("replaceAll is all-or-nothing", async () => {
    const { store } = make();
    await store.set({ domain: "keep.com", action: "ask" });
    await expect(
      store.replaceAll([
        { domain: "new.com", action: "ask" },
        { domain: "bad", action: "always", containerId: "ghost" },
      ]),
    ).rejects.toThrow(RuleError);
    expect(store.list().map((r) => r.domain)).toEqual(["keep.com"]);
    await store.replaceAll([{ domain: "new.com", action: "ask" }]);
    expect(store.list().map((r) => r.domain)).toEqual(["new.com"]);
  });
});

describe("ExemptionManager", () => {
  it("survives a worker restart through storage.session, and merges placements made while loading", async () => {
    const area = new MemoryStorageArea();
    const first = new ExemptionManager(area);
    first.markPlacement(1, "work");
    first.markPlacement(2, null);
    await first.flush();
    expect(Object.keys(area.data.get(EXEMPTIONS_KEY) as object).sort()).toEqual(
      ["1", "2"],
    );

    const second = new ExemptionManager(area);
    second.markPlacement(3, "home"); // arrives before load() finished
    await second.load();
    expect(second.has(1) && second.has(2) && second.has(3)).toBe(true);
    expect(second.check(1, "work", "a.com")).toBe(true);
    second.forget(2);
    await second.flush();
    expect(Object.keys(area.data.get(EXEMPTIONS_KEY) as object).sort()).toEqual(
      ["1", "3"],
    );
  });
});

describe("BadgeIndicator", () => {
  const container: Container = {
    id: "work",
    name: "Work",
    color: "orange",
    createdAt: 1,
  };
  const make = (assigned: Map<number, string>) => {
    const calls: string[] = [];
    const badge = new BadgeIndicator(
      {
        setBadgeText: async ({ tabId, text }) =>
          void calls.push(`text ${tabId} "${text}"`),
        setBadgeBackgroundColor: async ({ tabId, color }) =>
          void calls.push(`bg ${tabId} ${color}`),
        setBadgeTextColor: async ({ tabId, color }) =>
          void calls.push(`fg ${tabId} ${color}`),
      },
      {
        containerOf: (id) => assigned.get(id) ?? null,
        container: (id) => (id === "work" ? container : undefined),
      },
    );
    return { badge, calls };
  };

  it("sets a colour dot (blank text, never initials), the container colour and a readable text colour; clears plain tabs", async () => {
    const { badge, calls } = make(new Map([[1, "work"]]));
    await badge.apply(1);
    await badge.apply(2);
    expect(calls).toEqual([
      'text 1 " "',
      "bg 1 #ff9f00",
      "fg 1 #000000",
      'text 2 ""',
    ]);
  });

  it("the move notice is an arrow on the container colour, never initials", async () => {
    const { badge, calls } = make(new Map([[1, "work"]]));
    await badge.notice(1, "moved to “Work”", 10);
    expect(calls.slice(0, 3)).toEqual([
      'text 1 "→"',
      "bg 1 #ff9f00",
      "fg 1 #000000",
    ]);
  });

  it('waiting tabs: a bright "!" on the tab and a hint on the button for every other tab', async () => {
    const calls: string[] = [];
    const badge = new BadgeIndicator(
      {
        setBadgeText: async ({ tabId, text }) =>
          void calls.push(`text ${tabId} "${text}"`),
        setBadgeBackgroundColor: async ({ tabId, color }) =>
          void calls.push(`bg ${tabId} ${color}`),
        setBadgeTextColor: async ({ tabId, color }) =>
          void calls.push(`fg ${tabId} ${color}`),
        setTitle: async ({ tabId, title }) =>
          void calls.push(`title ${tabId} ${title}`),
      },
      {
        containerOf: () => null,
        container: () => undefined,
        isHeld: (id) => id === 4,
        heldCount: () => 2,
      },
    );
    await badge.apply(4);
    await badge.apply(5);
    await badge.applyGlobal();
    expect(calls).toEqual([
      'text 4 "!"',
      "bg 4 #ef2d2d",
      "fg 4 #ffffff",
      "title 4 SplitSession — this tab is waiting for you to choose its container",
      'text 5 ""',
      'text undefined "!"',
      "bg undefined #ef2d2d",
      "fg undefined #ffffff",
      "title undefined SplitSession — 2 tabs are waiting for you to choose a container (open SplitSession)",
    ]);
  });

  it("never throws for a tab that is gone, and ignores negative ids", async () => {
    const calls: string[] = [];
    const badge = new BadgeIndicator(
      {
        setBadgeText: async () => {
          throw new Error("No tab with id");
        },
        setBadgeBackgroundColor: async () => void calls.push("bg"),
      },
      { containerOf: () => "work", container: () => container },
    );
    await expect(badge.apply(5)).resolves.toBeUndefined();
    await expect(badge.apply(-1)).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });
});
