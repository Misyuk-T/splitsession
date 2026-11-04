import { describe, expect, it, vi } from "vitest";

import { MemoryStorageArea } from "../../engine/storage/storage-area";
import { createLogger } from "../log";
import {
  decideMissingApi,
  NativeRestart,
  RESTART_FAILED_KEY,
  RESTART_MARKER_KEY,
  RESTART_MARKER_MAX_AGE_MS,
} from "./native-restart";

describe("decideMissingApi", () => {
  it("not granted: nothing to restart for", () => {
    expect(
      decideMissingApi({
        granted: false,
        cameBackFromRestart: false,
        gaveUp: false,
      }),
    ).toBe("not-granted");
  });

  it("granted but the API is missing, first time: restart once", () => {
    expect(
      decideMissingApi({
        granted: true,
        cameBackFromRestart: false,
        gaveUp: false,
      }),
    ).toBe("restart");
  });

  it("granted, still missing after our restart (or after an earlier failed one): give up", () => {
    expect(
      decideMissingApi({
        granted: true,
        cameBackFromRestart: true,
        gaveUp: false,
      }),
    ).toBe("give-up");
    expect(
      decideMissingApi({
        granted: true,
        cameBackFromRestart: false,
        gaveUp: true,
      }),
    ).toBe("give-up");
  });
});

function setup(
  granted = true,
  now = { t: 1_000_000 },
  afterOwnReload?: () => Promise<void>,
) {
  const area = new MemoryStorageArea();
  const log = createLogger(50);
  const tabs: Array<{ id: number; windowId: number; url: string }> = [];
  const b = {
    runtime: {
      reload: vi.fn(),
      getURL: (p: string) => `chrome-extension://abc${p}`,
    },
    permissions: { contains: vi.fn(async () => granted) },
    tabs: {
      query: vi.fn(async () => tabs),
      create: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
    },
    windows: { update: vi.fn(async () => ({})) },
    alarms: { create: vi.fn(async () => {}), clear: vi.fn(async () => true) },
  };
  const restart = new NativeRestart(
    b as never,
    area,
    log,
    () => now.t,
    afterOwnReload,
  );
  return { restart, b, area, tabs, now, log };
}

describe("NativeRestart", () => {
  it("granted + missing the first time: decides to restart, and the reload happens after the marker is stored", async () => {
    const { restart, b, area } = setup();
    expect(await restart.decide()).toBe("restart");
    await restart.restart();
    expect(area.data.get(RESTART_MARKER_KEY)).toBe(1_000_000);
    expect(b.runtime.reload).toHaveBeenCalledTimes(1);
  });

  it("not granted: no restart, and an earlier give-up is forgotten", async () => {
    const { restart, area } = setup(false);
    area.data.set(RESTART_FAILED_KEY, true);
    expect(await restart.decide()).toBe("not-granted");
    expect(area.data.has(RESTART_FAILED_KEY)).toBe(false);
  });

  it("after a restart the API is still missing: gives up, logs it, never reloads (a second attempt does not reload)", async () => {
    const first = setup();
    await first.restart.decide();
    await first.restart.restart();
    // The next worker: same storage, a new instance.
    const next = new NativeRestart(
      first.b as never,
      first.area,
      first.log,
      () => first.now.t + 5_000,
    );
    await next.start();
    expect(first.area.data.has(RESTART_MARKER_KEY)).toBe(false); // consumed
    expect(await next.decide()).toBe("give-up");
    expect(first.log.entries().some((e) => e.level === "error")).toBe(true);
    expect(first.b.runtime.reload).toHaveBeenCalledTimes(1);
    // And not by a later worker either, until the API shows up.
    const later = new NativeRestart(first.b as never, first.area, first.log);
    await later.start();
    expect(await later.decide()).toBe("give-up");
    expect(first.b.runtime.reload).toHaveBeenCalledTimes(1);
    await later.settled(); // the API is present now
    expect(await later.decide()).toBe("restart");
  });

  it("a fresh marker reopens the options page at For AI agents; a stale one does not", async () => {
    const fresh = setup();
    fresh.area.data.set(RESTART_MARKER_KEY, fresh.now.t - 1_000);
    await fresh.restart.start();
    expect(fresh.b.tabs.create).toHaveBeenCalledWith({
      url: "chrome-extension://abc/options.html#agent",
    });
    expect(fresh.area.data.has(RESTART_MARKER_KEY)).toBe(false);

    const stale = setup();
    stale.area.data.set(
      RESTART_MARKER_KEY,
      stale.now.t - RESTART_MARKER_MAX_AGE_MS - 1,
    );
    await stale.restart.start();
    expect(stale.b.tabs.create).not.toHaveBeenCalled();
    expect(stale.area.data.has(RESTART_MARKER_KEY)).toBe(false);
    expect(await stale.restart.decide()).toBe("restart"); // not from our reload: one attempt is allowed
  });

  it("reuses an options tab that survived the reload", async () => {
    const { restart, b, area, tabs, now } = setup();
    tabs.push({
      id: 9,
      windowId: 2,
      url: "chrome-extension://abc/options.html",
    });
    area.data.set(RESTART_MARKER_KEY, now.t);
    await restart.start();
    expect(b.tabs.create).not.toHaveBeenCalled();
    expect(b.tabs.update).toHaveBeenCalledWith(9, {
      url: "chrome-extension://abc/options.html#agent",
      active: true,
    });
  });

  it("no marker: nothing happens at start", async () => {
    const { restart, b } = setup();
    await restart.start();
    expect(b.tabs.create).not.toHaveBeenCalled();
    expect(await restart.decide()).toBe("restart");
  });

  it("a fresh marker restores the container tabs first, before the options page is reopened", async () => {
    const order: string[] = [];
    const restore = vi.fn(async () => void order.push("restore"));
    const { restart, b, area, now } = setup(true, { t: 1_000_000 }, restore);
    b.tabs.create.mockImplementation(async () => {
      order.push("reopen");
      return {};
    });
    area.data.set(RESTART_MARKER_KEY, now.t - 1_000);
    await restart.start();
    expect(restore).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["restore", "reopen"]);
  });

  it("a failing restore does not stop the reopen", async () => {
    const restore = vi.fn(async () => {
      throw new Error("boom");
    });
    const { restart, b, area, now } = setup(true, { t: 1_000_000 }, restore);
    area.data.set(RESTART_MARKER_KEY, now.t);
    await restart.start();
    expect(b.tabs.create).toHaveBeenCalledTimes(1);
  });

  it("no marker, or a stale one: no restore from here", async () => {
    const none = vi.fn(async () => {});
    await setup(true, { t: 1_000_000 }, none).restart.start();
    const stale = vi.fn(async () => {});
    const s = setup(true, { t: 1_000_000 }, stale);
    s.area.data.set(
      RESTART_MARKER_KEY,
      s.now.t - RESTART_MARKER_MAX_AGE_MS - 1,
    );
    await s.restart.start();
    expect(none).not.toHaveBeenCalled();
    expect(stale).not.toHaveBeenCalled();
  });
});
