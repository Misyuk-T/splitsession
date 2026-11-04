import { describe, expect, it, vi } from "vitest";

import { type AfterUpdateDeps,restoreTabsAfterUpdate } from "./after-update";
import { singleFlight } from "./single-flight";

/** One container tab that is in the backup and still open; the registry starts empty (a reload wiped `storage.session`). */
function setup() {
  const live = new Map<number, unknown>();
  const reload = vi.fn(async () => {});
  const deps = {
    log: vi.fn(),
    containers: { get: () => ({ id: "c1" }) },
    tabs: {
      // Yields, like a storage read: two callers can both get here before either has written.
      loadBackup: async () => {
        await Promise.resolve();
        return new Map([
          [7, { containerId: "c1", windowId: 1, url: "https://a.test/x" }],
        ]);
      },
      entries: () => [...live],
      set: (id: number, rec: unknown) => void live.set(id, rec),
      containerOf: () => "c1",
      update: async () => {},
      delete: async () => {},
    },
    b: {
      tabs: {
        get: async () => ({ id: 7, windowId: 1, url: "https://a.test/y" }),
        reload,
      },
    },
    scripts: { ensure: vi.fn(async () => {}) },
    rules: { invalidate: vi.fn(async () => true) },
    events: { emit: vi.fn() },
    prepareNavigation: async () => {},
  } as unknown as AfterUpdateDeps;
  return { deps, reload };
}

describe("restoreTabsAfterUpdate triggers", () => {
  it("two triggers racing on an empty registry restore the tab twice without single-flight", async () => {
    const { deps, reload } = setup();
    await Promise.all([
      restoreTabsAfterUpdate(deps),
      restoreTabsAfterUpdate(deps),
    ]);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("through single-flight (onInstalled and the bridge's own reload) the tab is restored once", async () => {
    const { deps, reload } = setup();
    const once = singleFlight(() => restoreTabsAfterUpdate(deps));
    await Promise.all([once(), once()]);
    expect(reload).toHaveBeenCalledTimes(1);
    // A later trigger finds the registry filled and does nothing.
    await once();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
