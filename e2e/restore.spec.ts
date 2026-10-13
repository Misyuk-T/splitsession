import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type BrowserContext,
  chromium,
  type Page,
  type Worker,
} from "@playwright/test";

import { TEST_PORT } from "./env";
import { apiOf, extensionArgs, workerOf } from "./extension";
import { at, expect, ext, type Facet, go, test } from "./fixtures";

/** `/set?c=<cookie>`: a persistent cookie (it survives a browser restart in the real profile and in a jar alike). */
const setCookie = (host: string, value: string) =>
  at(host, `/set?c=${encodeURIComponent(`${value}; Max-Age=86400; Path=/`)}`);

/** Requests the stand saw for `pathWithQuery`, as their Cookie headers. */
async function cookiesFor(
  facet: { serverLog(): Promise<Array<{ path: string; cookie: string }>> },
  pathWithQuery: string,
): Promise<string[]> {
  return (await facet.serverLog())
    .filter((e) => e.path === pathWithQuery)
    .map((e) => e.cookie);
}

/** A container tab at `url` whose jar holds `cookie` for a.localhost. */
async function containerTab(
  facet: Facet,
  ref: string,
  cookie: string,
  url: string,
): Promise<{ page: Page; tabId: number }> {
  const page = await facet.openIn(ref, setCookie("a.localhost", cookie));
  await go(page, url);
  await expect(page.locator("#cookies")).toHaveText(cookie);
  return { page, tabId: await facet.tabIdOf(page) };
}

test.describe("container tabs that come back", () => {
  test("Reopen closed tab (sessions.restore): back in its container, and no request ever carried the real profile’s cookies", async ({
    facet,
  }) => {
    const A = await facet.container("A");
    await facet.plain(setCookie("a.localhost", "who=real"));
    const { page } = await containerTab(
      facet,
      A.name,
      "who=alice",
      at("a.localhost", "/whoami?t=reopen"),
    );
    await facet.api("flushRestore");
    await page.close();
    await facet.api("flushRestore");
    await facet.clearLog();

    const created = facet.ctx.waitForEvent("page");
    const restoredId = await facet.inWorker(
      async () =>
        (await (globalThis as any).chrome.sessions.restore()).tab?.id as number,
      null,
    );
    const restored = await created;
    facet.adopt(restored);
    await expect
      .poll(() => facet.api("getTabContainer", restoredId), { timeout: 10_000 })
      .toBe(A.id);
    await expect(restored.locator("#cookies")).toHaveText("who=alice");
    const sent = await cookiesFor(facet, "/whoami?t=reopen");
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((c) => c === "who=alice")).toBe(true);
  });

  test("a closed SplitSession group opened again (saved group, simulated) comes back in its container; a look-alike group of the user’s does not", async ({
    facet,
  }) => {
    const A = await facet.container("A");
    await facet.plain(setCookie("a.localhost", "who=real"));
    const one = await containerTab(
      facet,
      A.name,
      "who=alice",
      at("a.localhost", "/whoami?g=1"),
    );
    const two = await containerTab(
      facet,
      A.name,
      "who=alice",
      at("a.localhost", "/whoami?g=2"),
    );
    // Both in SplitSession's group of A (the projection groups them a moment after they are assigned).
    await expect
      .poll(async () => (await facet.tabInfo(one.tabId)).groupId)
      .toBeGreaterThanOrEqual(0);
    const { groupId, windowId } = await facet.tabInfo(one.tabId);
    await expect
      .poll(async () => (await facet.tabInfo(two.tabId)).groupId)
      .toBe(groupId);
    const group = await facet.inWorker(async (id: number) => {
      const g = await (globalThis as any).chrome.tabGroups.get(id);
      return { title: g.title as string, color: g.color as string };
    }, groupId);
    expect(await facet.groupInfo(groupId)).toMatchObject({
      title: `⧉ ${A.name}`,
      marker: A.id,
    });
    await facet.api("flushRestore");

    // Close the whole group: Chrome keeps it as a saved group.
    await facet.inWorker(
      (ids: number[]) => (globalThis as any).chrome.tabs.remove(ids),
      [one.tabId, two.tabId],
    );
    await expect
      .poll(() => one.page.isClosed() && two.page.isClosed())
      .toBe(true);
    await facet.api("flushRestore");
    const debug = await facet.api<{
      records: Array<{ url: string; savedGroup?: boolean }>;
    }>("getRestoreDebug");
    expect(
      debug.records.filter((r) => r.url.includes("/whoami?g=") && r.savedGroup),
    ).toHaveLength(2);

    // Opening it again creates new tabs in a new group with the same title (marker included) and colour.
    await facet.clearLog();
    const urls = [
      at("a.localhost", "/whoami?g=1"),
      at("a.localhost", "/whoami?g=2"),
    ];
    const reopened = await facet.inWorker(
      async ({
        urls,
        title,
        color,
        windowId,
      }: {
        urls: string[];
        title: string;
        color: string;
        windowId: number;
      }) => {
        const c = (globalThis as any).chrome;
        // Chrome reopens a saved group in a normal window (an earlier test may have left a popup window focused).
        const win =
          (await c.windows.get(windowId).catch(() => null))?.type === "normal"
            ? windowId
            : (await c.windows.getAll({ windowTypes: ["normal"] }))[0].id;
        const tabs = await Promise.all(
          urls.map((url) =>
            c.tabs.create({ url, windowId: win, active: false }),
          ),
        );
        // createProperties: without it Chrome makes the group in the focused window (a popup window left by a test).
        const g = await c.tabs.group({
          tabIds: tabs.map((t: { id: number }) => t.id),
          createProperties: { windowId: win },
        });
        await c.tabGroups.update(g, { title, color });
        return tabs.map((t: { id: number }) => t.id as number);
      },
      { urls, ...group, windowId },
    );
    for (const id of reopened)
      await expect
        .poll(() => facet.api("getTabContainer", id), { timeout: 10_000 })
        .toBe(A.id);
    for (const p of facet.ctx
      .pages()
      .filter((p) => p.url().includes("/whoami?g="))) {
      facet.adopt(p);
      await expect(p.locator("#cookies")).toHaveText("who=alice");
    }
    for (const q of ["/whoami?g=1", "/whoami?g=2"]) {
      const sent = await cookiesFor(facet, q);
      expect(sent.length).toBeGreaterThan(0);
      expect(sent.every((c) => c === "who=alice")).toBe(true);
    }
    // SplitSession took the restored group over: no second group for the container.
    expect((await facet.tabInfo(reopened[0]!)).groupId).toBe(
      (await facet.tabInfo(reopened[1]!)).groupId,
    );

    // The user's own group with the container's name (no marker) on a gated address: an ordinary tab.
    const three = await containerTab(
      facet,
      A.name,
      "who=alice",
      at("a.localhost", "/whoami?g=3"),
    );
    await facet.api("flushRestore");
    await facet.inWorker(
      (id: number) => (globalThis as any).chrome.tabs.remove(id),
      three.tabId,
    );
    await expect.poll(() => three.page.isClosed()).toBe(true);
    await facet.api("flushRestore");
    await facet.clearLog();
    const lookalike = await facet.inWorker(
      async ({
        url,
        name,
        color,
        windowId,
      }: {
        url: string;
        name: string;
        color: string;
        windowId: number;
      }) => {
        const c = (globalThis as any).chrome;
        const win =
          (await c.windows.get(windowId).catch(() => null))?.type === "normal"
            ? windowId
            : (await c.windows.getAll({ windowTypes: ["normal"] }))[0].id;
        const tab = await c.tabs.create({ url, windowId: win, active: false });
        const g = await c.tabs.group({
          tabIds: [tab.id],
          createProperties: { windowId: win },
        });
        await c.tabGroups.update(g, { title: name, color });
        return tab.id as number;
      },
      {
        url: at("a.localhost", "/whoami?g=3"),
        name: A.name,
        color: group.color,
        windowId,
      },
    );
    await facet.api("flushRestore");
    expect(await facet.api("getTabContainer", lookalike)).toBeNull();
    const plainPage = facet.ctx
      .pages()
      .find((p) => p.url().includes("/whoami?g=3"))!;
    facet.adopt(plainPage);
    await expect(plainPage.locator("#cookies")).toHaveText("who=real");
    expect(await cookiesFor(facet, "/whoami?g=3")).not.toContain("who=alice");
  });

  test("a new window with the address of a closed one-tab container window is an ordinary tab: no hold, the real profile’s cookies", async ({
    facet,
  }) => {
    const A = await facet.container("A");
    await facet.plain(setCookie("a.localhost", "who=real"));
    const url = at("a.localhost", "/whoami?t=onewin");
    const loadedIn = (tabId: number, part: string) =>
      facet.inWorker(
        async ([id, p]: [number, string]) => {
          const c = (globalThis as any).chrome;
          for (let i = 0; i < 200; i++) {
            const tab = await c.tabs.get(id);
            if (tab.status === "complete" && (tab.url ?? "").includes(p))
              return;
            await new Promise((r) => setTimeout(r, 50));
          }
          throw new Error(`tab ${id} did not load ${p}`);
        },
        [tabId, part] as [number, string],
      );
    // A window with a single web page, in a container (the placeholder page of the new window is not a web page).
    const windowId = await facet.inWorker(
      async () =>
        (
          await (globalThis as any).chrome.windows.create({
            url: "about:blank",
          })
        ).id as number,
      null,
    );
    const tabId = await facet.api<number>(
      "openInContainer",
      setCookie("a.localhost", "who=alice"),
      A.id,
      { active: true, windowId },
    );
    await loadedIn(tabId, "/set");
    await facet.inWorker(
      ([id, u]: [number, string]) =>
        (globalThis as any).chrome.tabs.update(id, { url: u }),
      [tabId, url] as [number, string],
    );
    await loadedIn(tabId, "?t=onewin");
    await facet.api("flushRestore");
    await facet.inWorker(
      (id: number) => (globalThis as any).chrome.windows.remove(id),
      windowId,
    );
    await expect.poll(() => facet.api("getTabContainer", tabId)).toBeNull();
    await facet.api("flushRestore");
    const debug = await facet.api<{
      records: Array<{ url: string; closedAt?: number; viaWindow?: boolean }>;
    }>("getRestoreDebug");
    expect(
      debug.records.filter(
        (r) => r.url === url && r.closedAt !== undefined && r.viaWindow,
      ),
    ).toHaveLength(1);

    // Later a link from another app (or "open bookmark in new window") opens the same address in a new window.
    await facet.clearLog();
    const created = facet.ctx.waitForEvent("page");
    const newTab = await facet.inWorker(
      async (u: string) =>
        (await (globalThis as any).chrome.windows.create({ url: u })).tabs[0]
          .id as number,
      url,
    );
    const page = await created;
    facet.adopt(page);
    await expect(page.locator("#cookies")).toHaveText("who=real", {
      timeout: 10_000,
    });
    await facet.api("flushRestore");
    expect(await facet.api("getTabContainer", newTab)).toBeNull();
    expect(
      (await facet.api<{ held: unknown[] }>("getRestoreStatus")).held,
    ).toEqual([]);
    const sent = await cookiesFor(facet, "/whoami?t=onewin");
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((c) => c === "who=real")).toBe(true);
  });

  test('with "Restore container tabs" off, a reopened container tab is an ordinary tab', async ({
    facet,
  }) => {
    await facet.api("updateSettings", { restoreTabs: false });
    const A = await facet.container("A");
    await facet.plain(setCookie("a.localhost", "who=real"));
    const { page } = await containerTab(
      facet,
      A.name,
      "who=alice",
      at("a.localhost", "/whoami?t=off"),
    );
    await page.close();
    const created = facet.ctx.waitForEvent("page");
    const restoredId = await facet.inWorker(
      async () =>
        (await (globalThis as any).chrome.sessions.restore()).tab?.id as number,
      null,
    );
    const restored = await created;
    facet.adopt(restored);
    await expect(restored.locator("#cookies")).toHaveText("who=real");
    expect(await facet.api("getTabContainer", restoredId)).toBeNull();
    expect(
      (await facet.api<{ records: unknown[] }>("getRestoreDebug")).records,
    ).toEqual([]);
  });

  test('held page after the hold ended (Open in A, Back): "ordinary tab" takes the tab out of A, so the site gets no container cookies', async ({
    facet,
  }) => {
    const A = await facet.container("A");
    await facet.plain(setCookie("a.localhost", "who=real"));
    const url = at("a.localhost", "/whoami?t=heldback");
    // The state after "Open in A" and Back: the tab is still in A, and its history entry is the held page, which
    // nothing holds any more.
    const { page, tabId } = await containerTab(facet, A.name, "who=alice", url);
    await go(page, `${ext("held.html")}?u=${encodeURIComponent(url)}`);
    await expect(
      page.getByRole("heading", { name: "This tab is no longer on hold" }),
    ).toBeVisible();
    await expect(page.getByTestId("held-current")).toContainText(
      `in ${A.name}`,
    );
    expect(await facet.api("getTabContainer", tabId)).toBe(A.id);

    await facet.clearLog();
    await page.getByTestId("held-plain").click();
    await expect(page.locator("#cookies")).toHaveText("who=real", {
      timeout: 10_000,
    });
    expect(await facet.api("getTabContainer", tabId)).toBeNull();
    const sent = await cookiesFor(facet, "/whoami?t=heldback");
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((c) => c === "who=real")).toBe(true);
  });
});

// ---------------------------------------------------------------- browser restart (own browser, own profile)

async function launch(dir: string): Promise<BrowserContext> {
  return chromium.launchPersistentContext(dir, {
    channel: "chromium",
    headless: !process.env.HEADED,
    // Chromium's "Continue where you left off" for the next start.
    args: [...extensionArgs(), "--restore-last-session"],
  });
}

/** Runs in the worker: waits until the tab has loaded an address containing `part`. */
async function loaded(sw: Worker, tabId: number, part: string): Promise<void> {
  await sw.evaluate(
    async ([id, p]) => {
      const c = (globalThis as any).chrome;
      for (let i = 0; i < 200; i++) {
        const tab = await c.tabs.get(id);
        if (tab.status === "complete" && (tab.url ?? "").includes(p)) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`tab ${id} did not load ${p}`);
    },
    [tabId, part] as const,
  );
}

test("closing a plain tab and quitting at once: the window’s container tabs still come back (no stale window snapshot)", async () => {
  test.setTimeout(90_000);
  const dir = mkdtempSync(path.join(tmpdir(), "facet-restore-"));
  const log = {
    serverLog: async () =>
      (await (
        await fetch(`http://127.0.0.1:${TEST_PORT}/__log`)
      ).json()) as Array<{ path: string; cookie: string }>,
  };
  try {
    let ctx = await launch(dir);
    let sw = await workerOf(ctx);
    let api = apiOf(sw);
    await api("listContainers");
    const A = await api<{ id: string }>("createContainer", { name: "Quit A" });
    await api("updateSettings", { strictMode: true });
    const realSetup = await ctx.newPage();
    await realSetup.goto(setCookie("a.localhost", "who=real"));
    await realSetup.close();

    // One window: an ordinary page (active), an ordinary tab to be closed, and a container tab out of its group
    // (no group tells it what it is: only the window's address list does).
    const { windowId, padTab } = await sw.evaluate(
      async (u) => {
        const w = await (globalThis as any).chrome.windows.create({ url: u });
        return { windowId: w.id as number, padTab: w.tabs[0].id as number };
      },
      at("a.localhost", "/blank?pad"),
    );
    await loaded(sw, padTab, "?pad");
    const plain = await sw.evaluate(
      async ([u, w]) =>
        (
          await (globalThis as any).chrome.tabs.create({
            url: u,
            windowId: w,
            active: false,
          })
        ).id as number,
      [at("a.localhost", "/whoami?w=plain"), windowId] as const,
    );
    await loaded(sw, plain, "?w=plain");
    const c1 = await api<number>(
      "openInContainer",
      setCookie("a.localhost", "who=alice"),
      A.id,
      { active: false, windowId },
    );
    await loaded(sw, c1, "/set");
    await sw.evaluate(
      ([t, u]) => (globalThis as any).chrome.tabs.update(t, { url: u }),
      [c1, at("a.localhost", "/whoami?w=c1")] as const,
    );
    await loaded(sw, c1, "?w=c1");
    await expect
      .poll(() =>
        sw.evaluate(
          async (id) =>
            (await (globalThis as any).chrome.tabs.get(id)).groupId as number,
          c1,
        ),
      )
      .toBeGreaterThanOrEqual(0);
    await sw.evaluate((id) => (globalThis as any).chrome.tabs.ungroup(id), c1);
    await api("flushRestore");

    // The user closes the ordinary tab and quits the browser a moment later.
    await sw.evaluate(
      (id) => (globalThis as any).chrome.tabs.remove(id),
      plain,
    );
    // Quicker than the 0.3 s the snapshot used to wait: the write has to land before the browser is gone.
    await new Promise((r) => setTimeout(r, 250));
    await ctx.close();
    await fetch(`http://127.0.0.1:${TEST_PORT}/__log?clear=1`);

    ctx = await launch(dir);
    sw = await workerOf(ctx);
    api = apiOf(sw);
    await api("listContainers");
    const status = await api<{ held: unknown[] }>("getRestoreStatus");
    expect(status.held).toEqual([]);
    const tabs =
      await api<Array<{ tabId: number; containerId: string }>>("listTabs");
    expect(tabs.map((t) => t.containerId)).toEqual([A.id]);
    await expect
      .poll(() => cookiesFor(log, "/whoami?w=c1"), { timeout: 10_000 })
      .toEqual(["who=alice"]);
    expect(await cookiesFor(log, "/whoami?w=plain")).toEqual([]);
    await ctx.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("browser restart: container tabs return before their first request, groups are taken over, uncertain tabs wait for the popup", async () => {
  test.setTimeout(90_000);
  const dir = mkdtempSync(path.join(tmpdir(), "facet-restore-"));
  const log = {
    serverLog: async () =>
      (await (
        await fetch(`http://127.0.0.1:${TEST_PORT}/__log`)
      ).json()) as Array<{ path: string; cookie: string }>,
  };
  try {
    let ctx = await launch(dir);
    let sw = await workerOf(ctx);
    let api = apiOf(sw);
    await api("listContainers");
    const A = await api<{ id: string; name: string }>("createContainer", {
      name: "Restart A",
    });
    await api("updateSettings", { strictMode: true }); // the isolation steady state these tests check
    const B = await api<{ id: string; name: string }>("createContainer", {
      name: "Restart B",
    });

    const realSetup = await ctx.newPage();
    await realSetup.goto(setCookie("a.localhost", "who=real"));
    await realSetup.close();

    /** A container tab: sets the jar cookie, then goes to `url` (both through the container's rules). */
    const inContainer = async (
      containerId: string,
      cookie: string,
      url: string,
      windowId?: number,
      active = false,
    ): Promise<number> => {
      const id = await api<number>(
        "openInContainer",
        setCookie("a.localhost", cookie),
        containerId,
        { active, ...(windowId !== undefined ? { windowId } : {}) },
      );
      await loaded(sw, id, "/set");
      await sw.evaluate(
        ([t, u]) => (globalThis as any).chrome.tabs.update(t, { url: u }),
        [id, url] as const,
      );
      await loaded(sw, id, new URL(url).search);
      return id;
    };
    const pad = at("a.localhost", "/blank?pad");
    const pads: number[] = [];
    /** A window with an ordinary page that is never gated (made its active tab before the browser closes). */
    const newWindow = async (): Promise<number> => {
      const { windowId, tabId } = await sw.evaluate(async (u) => {
        const w = await (globalThis as any).chrome.windows.create({ url: u });
        return { windowId: w.id as number, tabId: w.tabs[0].id as number };
      }, pad);
      await loaded(sw, tabId, "?pad");
      pads.push(tabId);
      return windowId;
    };
    const plainTab = async (
      url: string,
      windowId?: number,
    ): Promise<number> => {
      const id = await sw.evaluate(
        async ([u, w]) =>
          (
            await (globalThis as any).chrome.tabs.create({
              url: u,
              active: false,
              ...(w !== null ? { windowId: w } : {}),
            })
          ).id as number,
        [url, windowId ?? null] as const,
      );
      await loaded(sw, id, new URL(url).search);
      return id;
    };
    /** The user drags the tab out of its group (SplitSession does not pull it back): no group tells what it is. */
    const ungroup = async (tabId: number) => {
      await expect
        .poll(() =>
          sw.evaluate(
            async (id) =>
              (await (globalThis as any).chrome.tabs.get(id)).groupId as number,
            tabId,
          ),
        )
        .toBeGreaterThanOrEqual(0);
      await sw.evaluate(
        (id) => (globalThis as any).chrome.tabs.ungroup(id),
        tabId,
      );
    };

    // Main window: two tabs of A and one of B (grouped), and an ordinary tab on the SAME address as A's first tab.
    const a1 = await inContainer(
      A.id,
      "who=alice",
      at("a.localhost", "/whoami?w=a1"),
    );
    await inContainer(A.id, "who=alice", at("a.localhost", "/whoami?w=a2"));
    await inContainer(B.id, "who=bob", at("a.localhost", "/whoami?w=b1"));
    await plainTab(at("a.localhost", "/whoami?w=a1"));
    // Two windows that look the same: one held A's tab, the other an ordinary tab on that address. Two more that look
    // the same, each with a tab of B. Out of their groups: no group tells them apart either.
    await ungroup(
      await inContainer(
        A.id,
        "who=alice",
        at("a.localhost", "/whoami?w=x"),
        await newWindow(),
      ),
    );
    await plainTab(at("a.localhost", "/whoami?w=x"), await newWindow());
    for (let i = 0; i < 2; i++)
      await ungroup(
        await inContainer(
          B.id,
          "who=bob",
          at("a.localhost", "/whoami?w=y"),
          await newWindow(),
        ),
      );
    // Chromium loads the tab that was active in each window (and pinned tabs) at once when it restores the session;
    // the other tabs come later. Here the active tabs are ordinary pages (and Playwright's about:blank), except in one window, whose active
    // tab is a container tab (see below).
    for (const id of pads)
      await sw.evaluate(
        (t) => (globalThis as any).chrome.tabs.update(t, { active: true }),
        id,
      );
    await inContainer(
      A.id,
      "who=alice",
      at("a.localhost", "/whoami?w=act"),
      await newWindow(),
      true,
    );
    await ctx.pages()[0]!.bringToFront();
    await api("flushRestore");
    const groupTitles = await sw.evaluate(async (id) => {
      const c = (globalThis as any).chrome;
      const tab = await c.tabs.get(id);
      return { a: (await c.tabGroups.get(tab.groupId)).title as string };
    }, a1);
    expect(
      (await api<{ records: unknown[] }>("getRestoreDebug")).records,
    ).toHaveLength(7);

    await ctx.close();
    await fetch(`http://127.0.0.1:${TEST_PORT}/__log?clear=1`);

    // ---- restart: Chromium restores the six windows
    ctx = await launch(dir);
    sw = await workerOf(ctx);
    api = apiOf(sw);
    await api("listContainers"); // ready: the previous session has been matched
    const tabs =
      await api<Array<{ tabId: number; containerId: string }>>("listTabs");
    const urlOf = (id: number) =>
      sw.evaluate(
        async (t) =>
          ((await (globalThis as any).chrome.tabs.get(t)).url as string) ?? "",
        id,
      );
    const located = await Promise.all(
      tabs.map(async (t) => ({
        ...t,
        search: new URL(await urlOf(t.tabId)).search,
      })),
    );
    const placed = located.map((t) => [t.search, t.containerId] as const);
    expect(placed.sort()).toEqual([
      ["?w=a1", A.id],
      ["?w=a2", A.id],
      ["?w=act", A.id],
      ["?w=b1", B.id],
    ]);
    // Background tabs are held by the gate until matched: each container tab loaded once, in its container; the
    // ordinary twin of a1 once, as the real profile.
    await expect
      .poll(async () => (await cookiesFor(log, "/whoami?w=a1")).sort(), {
        timeout: 10_000,
      })
      .toEqual(["who=alice", "who=real"]);
    await expect
      .poll(() => cookiesFor(log, "/whoami?w=a2"))
      .toEqual(["who=alice"]);
    await expect
      .poll(() => cookiesFor(log, "/whoami?w=b1"))
      .toEqual(["who=bob"]);
    // The active tab of a window: Chromium loads it while restoring, before the extension's rules exist (with the
    // extension loaded from the command line, as here), so that one request may have gone out as the real profile.
    // SplitSession still matches the tab and loads it again in its container.
    await expect
      .poll(async () => (await cookiesFor(log, "/whoami?w=act")).at(-1), {
        timeout: 10_000,
      })
      .toBe("who=alice");
    // The restored group of A in the main window was taken over (one group with both tabs), not doubled.
    const a1Now = located.find((t) => t.search === "?w=a1")!.tabId;
    const groups = await sw.evaluate(
      async ([title, tabId]) => {
        const c = (globalThis as any).chrome;
        const { windowId } = await c.tabs.get(tabId);
        const gs = await c.tabGroups.query({ title, windowId });
        return Promise.all(
          gs.map(
            async (g: { id: number }) =>
              (await c.tabs.query({ groupId: g.id })).length,
          ),
        );
      },
      [groupTitles.a, a1Now] as const,
    );
    expect(groups).toEqual([2]);

    // The look-alike windows: four tabs wait, nothing was requested for them.
    const status = await api<{
      held: Array<{ url: string; candidates: string[] }>;
      oneClick: number;
    }>("getRestoreStatus");
    expect(
      status.held
        .map((h) => [new URL(h.url).search, h.candidates.join()])
        .sort(),
    ).toEqual([
      ["?w=x", A.id],
      ["?w=x", A.id],
      ["?w=y", B.id],
      ["?w=y", B.id],
    ]);
    expect(status.oneClick).toBe(2);
    expect(await cookiesFor(log, "/whoami?w=x")).toEqual([]);
    expect(await cookiesFor(log, "/whoami?w=y")).toEqual([]);

    // Each waiting tab shows SplitSession's page, not Chrome's "blocked" page, with a bright badge; the button says so for every
    // other tab. The page makes no request (the stand saw none, above).
    const heldPages = () =>
      ctx.pages().filter((p) => p.url().startsWith(ext("held.html")));
    await expect.poll(() => heldPages().length, { timeout: 10_000 }).toBe(4);
    await expect
      .poll(() =>
        sw.evaluate(
          async (pattern) => {
            const c = (globalThis as any).chrome;
            const tabs = await c.tabs.query({ url: pattern });
            return Promise.all(
              tabs.map((t: { id: number }) =>
                c.action.getBadgeText({ tabId: t.id }),
              ),
            );
          },
          `${ext("held.html")}*`,
        ),
      )
      .toEqual(["!", "!", "!", "!"]);
    expect(
      await sw.evaluate(async () => [
        (await (globalThis as any).chrome.action.getBadgeText({})) as string,
        (await (globalThis as any).chrome.action.getTitle({})) as string,
      ]),
    ).toEqual([
      "!",
      "SplitSession — 4 tabs are waiting for you to choose a container (open SplitSession)",
    ]);
    // One of B's look-alike tabs is settled from its own page: "Open in Restart B" (the choices of the popup banner).
    const heldY = heldPages().find((p) =>
      p.url().includes(encodeURIComponent("?w=y")),
    )!;
    await expect(heldY.getByTestId("held-url")).toContainText("?w=y");
    await expect(
      heldY.getByRole("heading", { name: "This tab is waiting for you" }),
    ).toBeVisible();
    await expect(heldY.getByTestId("held-plain")).toBeVisible();
    await heldY.getByRole("button", { name: /Open in Restart B/ }).click();
    await expect
      .poll(() => cookiesFor(log, "/whoami?w=y"), { timeout: 10_000 })
      .toEqual(["who=bob"]);
    await expect.poll(() => heldPages().length).toBe(3);

    // The popup: "Restore 1 container tab" (the other of B), then the rest as ordinary tabs.
    const popup = await ctx.newPage();
    await popup.goto(ext("popup.html"));
    const banner = popup.getByTestId("restore-banner");
    await expect(banner).toContainText("3 tabs waiting"); // one line; the tabs unfold on press
    await banner.getByRole("button", { name: /3 tabs waiting/ }).click();
    await expect(banner.getByTestId("held-tab")).toHaveCount(3);
    await banner
      .getByRole("button", { name: "Restore 1 container tab" })
      .click();
    await expect
      .poll(() => cookiesFor(log, "/whoami?w=y"), { timeout: 10_000 })
      .toEqual(["who=bob", "who=bob"]);
    await banner.getByRole("button", { name: "Waiting tabs options" }).click();
    await popup
      .getByRole("menuitem", { name: "Open as ordinary tabs" })
      .click();
    await expect
      .poll(() => cookiesFor(log, "/whoami?w=x"), { timeout: 10_000 })
      .toEqual(["who=real", "who=real"]);
    await expect(banner).toHaveCount(0);
    expect((await api<unknown[]>("listTabs")).length).toBe(6);
    // Nothing waits any more: the button is back to normal.
    await expect
      .poll(() =>
        sw.evaluate(async () => [
          (await (globalThis as any).chrome.action.getBadgeText({})) as string,
          (await (globalThis as any).chrome.action.getTitle({})) as string,
        ]),
      )
      .toEqual(["", "SplitSession"]);
    await ctx.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
