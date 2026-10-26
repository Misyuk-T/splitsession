import { describe, expect, it, vi } from "vitest";

import { MemoryStorageArea } from "../../engine/storage/storage-area";
import { AGENT_WINDOW_KEY, AgentWindow } from "./agent-window";
import { BridgeRouter } from "./router";

/** A browser with windows that can be closed by the "user". */
function browserWith() {
  const open = new Set<number>([1]); // the user's window
  let nextWindow = 100;
  let nextTab = 500;
  const tabsIn = new Map<number, number[]>([[1, [10]]]);
  const b = {
    windows: {
      get: vi.fn(async (id: number) => {
        if (!open.has(id)) throw new Error("No window with id");
        return { id, type: "normal" };
      }),
      create: vi.fn(async (props: { focused?: boolean; state?: string }) => {
        const id = nextWindow++;
        open.add(id);
        const first = nextTab++;
        tabsIn.set(id, [first]);
        return { id, type: "normal", tabs: [{ id: first }], ...props };
      }),
      getAll: vi.fn(async () => [...open].map((id) => ({ id }))),
      update: vi.fn(async () => ({})),
    },
    tabs: {
      query: vi.fn(async (q: { windowId?: number }) =>
        [...tabsIn.entries()]
          .filter(([w]) => q.windowId === undefined || w === q.windowId)
          .flatMap(([w, ids]) => ids.map((id) => ({ id, windowId: w }))),
      ),
      remove: vi.fn(async (id: number) => {
        for (const [w, ids] of tabsIn)
          tabsIn.set(
            w,
            ids.filter((x) => x !== id),
          );
      }),
      create: vi.fn(async (props: { windowId?: number; url?: string }) => {
        const id = nextTab++;
        const w = props.windowId ?? 1;
        tabsIn.set(w, [...(tabsIn.get(w) ?? []), id]);
        return { id, windowId: w, url: props.url, status: "complete" };
      }),
      get: vi.fn(async (id: number) => ({
        id,
        windowId: 1,
        url: "https://a.test/",
        title: "T",
        status: "complete",
      })),
    },
    close: (id: number) => void open.delete(id),
    tabsIn,
  };
  return b;
}

function setup(enabled = true) {
  const b = browserWith();
  const area = new MemoryStorageArea();
  const flag = { on: enabled };
  const windowOf = new AgentWindow({
    b: b as never,
    area,
    enabled: () => flag.on,
  });
  return { b, area, flag, windowOf };
}

describe("AgentWindow", () => {
  it("makes an unfocused ordinary window on the first open and remembers it", async () => {
    const { b, area, windowOf } = setup();
    const id = await windowOf.resolve();
    expect(id).toBe(100);
    expect(b.windows.create).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "normal",
        state: "normal",
        focused: false,
      }),
    );
    expect((await area.get(AGENT_WINDOW_KEY))[AGENT_WINDOW_KEY]).toBe(100);
  });

  it("reuses the window while it exists", async () => {
    const { b, windowOf } = setup();
    const a = await windowOf.resolve();
    const c = await windowOf.resolve();
    expect(c).toBe(a);
    expect(b.windows.create).toHaveBeenCalledTimes(1);
  });

  it("makes a new window when the user closed it", async () => {
    const { b, windowOf } = setup();
    const first = await windowOf.resolve();
    b.close(first!);
    const second = await windowOf.resolve();
    expect(second).not.toBe(first);
    expect(b.windows.create).toHaveBeenCalledTimes(2);
  });

  it("finds the window again after the worker restarted (the ID is in session storage)", async () => {
    const { b, area, flag } = setup();
    const first = await new AgentWindow({
      b: b as never,
      area,
      enabled: () => flag.on,
    }).resolve();
    const restarted = new AgentWindow({
      b: b as never,
      area,
      enabled: () => flag.on,
    });
    expect(await restarted.resolve()).toBe(first);
    expect(b.windows.create).toHaveBeenCalledTimes(1);
  });

  it("two opens at once make one window", async () => {
    const { b, windowOf } = setup();
    const [x, y] = await Promise.all([windowOf.resolve(), windowOf.resolve()]);
    expect(x).toBe(y);
    expect(b.windows.create).toHaveBeenCalledTimes(1);
  });

  it("with the setting off nothing is made and the current window is used", async () => {
    const { b, windowOf } = setup(false);
    expect(await windowOf.resolve()).toBeUndefined();
    expect(b.windows.create).not.toHaveBeenCalled();
  });

  it("an explicit windowId always wins, with the setting on or off", async () => {
    const { b, flag, windowOf } = setup();
    expect(await windowOf.resolve(7)).toBe(7);
    flag.on = false;
    expect(await windowOf.resolve(7)).toBe(7);
    expect(b.windows.create).not.toHaveBeenCalled();
  });

  it("falls back to the current window when no window can be made", async () => {
    const { b, windowOf } = setup();
    b.windows.create.mockRejectedValueOnce(new Error("no"));
    expect(await windowOf.resolve()).toBeUndefined();
  });

  it("closes the blank first tab once a real tab is in the window, and only then", async () => {
    const { b, windowOf } = setup();
    const id = await windowOf.resolve();
    await windowOf.opened(id);
    expect(b.tabs.remove).not.toHaveBeenCalled(); // still the only tab
    await b.tabs.create({ windowId: id });
    await windowOf.opened(id);
    expect(b.tabs.remove).toHaveBeenCalledTimes(1);
    expect(b.tabs.remove).toHaveBeenCalledWith(500);
    await windowOf.opened(id);
    expect(b.tabs.remove).toHaveBeenCalledTimes(1);
  });

  it("does not touch another window's tabs", async () => {
    const { b, windowOf } = setup();
    await windowOf.resolve();
    await windowOf.opened(1);
    await windowOf.opened(undefined);
    expect(b.tabs.remove).not.toHaveBeenCalled();
  });
});

describe("open_tab and open_in_container with the agents' window", () => {
  function routed(enabled = true) {
    const { b, windowOf, flag } = setup(enabled);
    const facet = {
      ready: Promise.resolve(),
      listContainers: () => [
        { id: "c1", name: "Work", color: "blue", tabCount: 0 },
      ],
      containers: {
        resolve: (ref: string) =>
          ref === "Work" || ref === "c1"
            ? { id: "c1", name: "Work" }
            : undefined,
        get: () => undefined,
      },
      createContainer: vi.fn(),
      getTabContainer: () => null,
      prepareNavigation: vi.fn(async () => {}),
      openInContainer: vi.fn(async (..._a: unknown[]) => 99),
    };
    const router = new BridgeRouter({
      b: b as never,
      facet: facet as never,
      api: { assignTab: vi.fn() } as never,
      sleep: async () => {},
      agentWindow: windowOf,
    });
    return { router, b, facet, flag };
  }

  it("open_tab lands in the agents' window, and the next one joins it", async () => {
    const { router, b } = routed();
    await router.run("open_tab", { url: "https://a.test/", wait: false }, {});
    await router.run("open_tab", { url: "https://b.test/", wait: false }, {});
    expect(b.tabs.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ windowId: 100 }),
    );
    expect(b.tabs.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ windowId: 100 }),
    );
    expect(b.windows.create).toHaveBeenCalledTimes(1);
  });

  it("open_in_container opens in the agents' window", async () => {
    const { router, facet } = routed();
    await router.run(
      "open_in_container",
      { url: "https://a.test/", container: "Work", wait: false },
      {},
    );
    expect(facet.openInContainer).toHaveBeenCalledWith(
      "https://a.test/",
      "c1",
      { active: false, windowId: 100 },
    );
  });

  it("with the setting off the tab goes to the current window (no windowId)", async () => {
    const { router, b, facet } = routed(false);
    await router.run("open_tab", { url: "https://a.test/", wait: false }, {});
    expect(b.tabs.create.mock.calls[0]![0]).not.toHaveProperty("windowId");
    await router.run(
      "open_in_container",
      { url: "https://a.test/", container: "Work", wait: false },
      {},
    );
    expect(facet.openInContainer.mock.calls[0]![2]).not.toHaveProperty(
      "windowId",
    );
    expect(b.windows.create).not.toHaveBeenCalled();
  });

  it("an explicit windowId wins over the agents' window", async () => {
    const { router, b, facet } = routed();
    await router.run(
      "open_tab",
      { url: "https://a.test/", windowId: 1, wait: false },
      {},
    );
    expect(b.tabs.create).toHaveBeenCalledWith(
      expect.objectContaining({ windowId: 1 }),
    );
    await router.run(
      "open_in_container",
      { url: "https://a.test/", container: "Work", windowId: 1, wait: false },
      {},
    );
    expect(facet.openInContainer.mock.calls[0]![2]).toMatchObject({
      windowId: 1,
    });
    expect(b.windows.create).not.toHaveBeenCalled();
  });
});
