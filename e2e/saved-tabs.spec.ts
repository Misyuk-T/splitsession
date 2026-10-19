import type { Page } from "@playwright/test";

import { at, expect, ext, type Facet, test } from "./fixtures";

interface Info {
  id: string;
  name: string;
  tabCount: number;
  savedCount: number;
}

async function openPopup(facet: Facet): Promise<Page> {
  const page = await facet.ctx.newPage();
  await page.setViewportSize({ width: 380, height: 700 });
  await page.goto(ext("popup.html"));
  await expect(page.getByRole("heading", { name: "Containers" })).toBeVisible();
  return page;
}

const rowOf = (popup: Page, name: string) =>
  popup.getByTestId("container-row").filter({ hasText: name });

const info = async (facet: Facet, id: string) =>
  (await facet.api<Info[]>("listContainers")).find((c) => c.id === id)!;

const whoami = (n: number) => at("a.localhost", `/whoami?n=${n}`);

/**
 * Container `A` with `count` tabs in its group: the first signs in as alice (302 login, HttpOnly cookie in the jar), the
 * others show /whoami?n=<i>. Returns the tab IDs in order.
 */
async function groupOf(facet: Facet, A: { name: string }, count: number) {
  const ids: number[] = [];
  const first = await facet.openIn(
    A.name,
    at(
      "a.localhost",
      `/login?user=alice&next=${encodeURIComponent("/whoami?n=1")}`,
    ),
  );
  await expect(first.locator("#user")).toHaveText("alice");
  ids.push(await facet.tabIdOf(first));
  for (let n = 2; n <= count; n++) {
    const page = await facet.openIn(A.name, whoami(n));
    await expect(page.locator("#user")).toHaveText("alice");
    ids.push(await facet.tabIdOf(page));
  }
  await expect
    .poll(async () => (await facet.tabInfo(ids[0]!)).groupId)
    .toBeGreaterThanOrEqual(0);
  await expect
    .poll(async () => {
      const groups = await Promise.all(
        ids.map(async (id) => (await facet.tabInfo(id)).groupId),
      );
      return new Set(groups).size;
    })
    .toBe(1);
  await facet.api("flushSavedTabs"); // the extension knows each tab's address before they close
  return ids;
}

/** What closing a tab group does: all its tabs close in one go. */
const closeTogether = (facet: Facet, ids: number[]) =>
  facet.inWorker(
    (tabIds: number[]) => (globalThis as any).chrome.tabs.remove(tabIds),
    ids,
  );

test.describe("saved tabs", () => {
  test("deleting a container's tab group saves its tabs; one click on the container brings them all back, in order, in one group, with its logins", async ({
    facet,
  }) => {
    const A = await facet.container("Work");
    const ids = await groupOf(facet, A, 3);
    const groupId = (await facet.tabInfo(ids[0]!)).groupId;
    expect(await facet.groupInfo(groupId)).not.toBeNull();

    await closeTogether(facet, ids);
    await expect.poll(async () => (await info(facet, A.id)).savedCount).toBe(3);
    expect((await info(facet, A.id)).tabCount).toBe(0);
    expect(
      (await facet.api<Array<{ url: string }>>("getSavedTabs", A.id)).map(
        (t) => t.url,
      ),
    ).toEqual([1, 2, 3].map((n) => (n === 1 ? whoami(1) : whoami(n))));

    const popup = await openPopup(facet);
    const row = rowOf(popup, A.name);
    await expect(row.getByTestId("container-saved")).toHaveText("3 saved");
    await expect(row.getByTestId("container-tabs")).toHaveCount(0);
    const main = row.getByRole("button", { name: /Reopen 3 saved tabs/ });
    await expect(main).toHaveAttribute("title", "Reopen 3 saved tabs");

    await facet.clearLog();
    const created = Promise.all(
      [1, 2, 3].map(() => facet.ctx.waitForEvent("page")),
    );
    await main.click();
    for (const page of await created) facet.adopt(page);

    await expect.poll(async () => (await info(facet, A.id)).tabCount).toBe(3);
    expect((await info(facet, A.id)).savedCount).toBe(0); // open again: nothing saved
    const tabs = (
      await facet.api<Array<{ tabId: number; containerId: string }>>("listTabs")
    ).filter((t) => t.containerId === A.id);
    expect(tabs).toHaveLength(3);
    const stateOf = async () => {
      const list = await Promise.all(
        tabs.map(async (t) => ({
          ...(await facet.tabInfo(t.tabId)),
          tabId: t.tabId,
        })),
      );
      return list.sort((a, b) => a.tabId - b.tabId);
    };
    await expect
      .poll(async () => (await stateOf()).map((s) => s.url))
      .toEqual([whoami(1), whoami(2), whoami(3)]);
    const states = await stateOf();
    // In order, side by side, in one group of the container.
    const sorted = await Promise.all(
      states.map(async (s) =>
        facet.inWorker(
          async (id: number) =>
            (await (globalThis as any).chrome.tabs.get(id)).index as number,
          s.tabId,
        ),
      ),
    );
    expect(sorted).toEqual([...sorted].sort((a, b) => a - b));
    await expect
      .poll(async () => {
        const g = await Promise.all(
          tabs.map(async (t) => (await facet.tabInfo(t.tabId)).groupId),
        );
        return new Set(g).size === 1 && g[0]! >= 0;
      })
      .toBe(true);
    const newGroup = (await facet.tabInfo(tabs[0]!.tabId)).groupId;
    expect((await facet.groupInfo(newGroup))?.marker).toBe(A.id);

    // With the container's logins, and none of them went out with the real profile's cookies.
    expect(
      (await facet.api<Array<{ name: string }>>("getJar", A.id)).some(
        (c) => c.name === "sid",
      ),
    ).toBe(true);
    const requests = (await facet.serverLog()).filter((r) =>
      r.path.startsWith("/whoami"),
    );
    expect(requests.length).toBeGreaterThanOrEqual(3);
    expect(requests.every((r) => r.cookie.includes("sid="))).toBe(true);
    expect(await facet.realCookies(at("a.localhost"))).toEqual([]);

    // The first one is the active tab.
    const active = await facet.inWorker(async () => {
      const c = (globalThis as any).chrome;
      return (await c.tabs.query({ active: true, lastFocusedWindow: true }))[0]
        ?.url as string;
    }, null);
    expect(active).toBe(whoami(1));
  });

  test("closing tabs one by one saves only the last batch", async ({
    facet,
  }) => {
    const A = await facet.container("Work");
    const ids = await groupOf(facet, A, 3);
    // Two tabs go one at a time, well apart; the last two together would be a batch, so close the last on its own.
    await closeTogether(facet, [ids[0]!]);
    await new Promise((r) => setTimeout(r, 2000));
    await closeTogether(facet, [ids[1]!]);
    await new Promise((r) => setTimeout(r, 2000));
    expect((await info(facet, A.id)).savedCount).toBe(0); // one tab is still open
    await closeTogether(facet, [ids[2]!]);
    await expect.poll(async () => (await info(facet, A.id)).savedCount).toBe(1);
    expect(
      (await facet.api<Array<{ url: string }>>("getSavedTabs", A.id)).map(
        (t) => t.url,
      ),
    ).toEqual([whoami(3)]);
  });

  test("closing a window that held the container's tabs saves them while another window is left", async ({
    facet,
  }) => {
    const A = await facet.container("Work");
    const windowId = await facet.inWorker(async () => {
      const w = await (globalThis as any).chrome.windows.create({
        url: "about:blank",
      });
      return w.id as number;
    }, null);
    for (const n of [1, 2])
      await facet.api("openInContainer", whoami(n), A.id, {
        windowId,
        active: n === 1,
      });
    await expect.poll(async () => (await info(facet, A.id)).tabCount).toBe(2);
    await expect
      .poll(async () =>
        facet.inWorker(
          async (w: number) =>
            (
              await (globalThis as any).chrome.tabs.query({ windowId: w })
            ).filter((t: { url?: string }) => /whoami/.test(t.url ?? ""))
              .length,
          windowId,
        ),
      )
      .toBe(2);
    await facet.api("flushSavedTabs");
    await facet.inWorker(
      (w: number) => (globalThis as any).chrome.windows.remove(w),
      windowId,
    );
    // Saved after a short grace period (a closing browser would not get that far).
    await expect
      .poll(async () => (await info(facet, A.id)).savedCount, {
        timeout: 10_000,
      })
      .toBe(2);
  });

  test("Forget saved tabs, in the container's edit form, removes the set", async ({
    facet,
  }) => {
    const A = await facet.container("Work");
    const ids = await groupOf(facet, A, 2);
    await closeTogether(facet, ids);
    await expect.poll(async () => (await info(facet, A.id)).savedCount).toBe(2);

    const popup = await openPopup(facet);
    const row = rowOf(popup, A.name);
    await row.hover();
    await row.getByRole("button", { name: `Edit ${A.name}` }).click();
    const forget = popup.getByRole("button", { name: /Forget saved tabs/ });
    await expect(
      popup.getByText("2 saved tabs for this container."),
    ).toBeVisible();
    await forget.focus();
    await popup.keyboard.press("Enter"); // by keyboard: no confirm() dialog, no native control
    await expect(forget).toHaveCount(0);
    await expect(popup.getByRole("status")).toContainText(
      "Forgot 2 saved tabs",
    );
    expect((await info(facet, A.id)).savedCount).toBe(0);
    await expect(popup.getByLabel("Name")).toBeFocused(); // focus stays in the form
    await popup.getByRole("button", { name: "Cancel" }).click();
    await expect(
      rowOf(popup, A.name).getByTestId("container-saved"),
    ).toHaveCount(0);
    await expect(
      rowOf(popup, A.name).getByRole("button", { name: `Open ${A.name}` }),
    ).toBeVisible(); // nothing saved: the row opens a new tab, as before
  });

  test("the setting off: nothing is saved, and turning it off forgets what was", async ({
    facet,
  }) => {
    const A = await facet.container("Work");
    const ids = await groupOf(facet, A, 2);
    await closeTogether(facet, ids);
    await expect.poll(async () => (await info(facet, A.id)).savedCount).toBe(2);

    await facet.api("updateSettings", { rememberTabs: false });
    expect((await info(facet, A.id)).savedCount).toBe(0);

    const again = await groupOf(facet, A, 2);
    await closeTogether(facet, again);
    await expect.poll(async () => (await info(facet, A.id)).tabCount).toBe(0);
    await new Promise((r) => setTimeout(r, 1500));
    expect((await info(facet, A.id)).savedCount).toBe(0);

    await facet.api("updateSettings", { rememberTabs: true });
    const third = await groupOf(facet, A, 2);
    await closeTogether(facet, third);
    await expect.poll(async () => (await info(facet, A.id)).savedCount).toBe(2);
  });

  test("the switch is in Settings, on by default, and turning it off clears saved tabs", async ({
    facet,
  }) => {
    const A = await facet.container("Work");
    const ids = await groupOf(facet, A, 2);
    await closeTogether(facet, ids);
    await expect.poll(async () => (await info(facet, A.id)).savedCount).toBe(2);

    const page = await facet.ctx.newPage();
    await page.setViewportSize({ width: 900, height: 900 });
    await page.goto(ext("options.html"));
    const sw = page.getByRole("switch", {
      name: /Remember tabs when a container’s last tab closes/,
    });
    await expect(sw).toHaveAttribute("aria-checked", "true");
    await sw.click();
    await expect(sw).toHaveAttribute("aria-checked", "false");
    await expect.poll(async () => (await info(facet, A.id)).savedCount).toBe(0);
    expect(
      (await facet.api<{ rememberTabs: boolean }>("getSettings")).rememberTabs,
    ).toBe(false);
    await page.close();
  });

  test("export with tabs carries open and saved tabs; importing into a fresh state shows them as saved, and opens nothing", async ({
    facet,
  }) => {
    const A = await facet.container("Work");
    const B = await facet.container("Home");
    // A: two tabs saved, one more open now. B: nothing.
    const first = await groupOf(facet, A, 2);
    await closeTogether(facet, first);
    await expect.poll(async () => (await info(facet, A.id)).savedCount).toBe(2);
    const open = await facet.openIn(A.name, at("b.localhost", "/blank"));
    await expect(open.locator("#path")).toHaveText("/blank");
    await facet.api("flushSavedTabs");

    const withoutTabs = await facet.api<{ tabs?: unknown }>("exportData", {});
    expect(withoutTabs.tabs).toBeUndefined();
    const file = await facet.api<{
      version: number;
      containers: Array<{ id: string; name: string }>;
      tabs?: Record<string, Array<{ url: string; title: string }>>;
    }>("exportData", { includeTabs: true });
    expect(file.version).toBe(1);
    const exportedA = file.containers.find((c) => c.name === A.name)!;
    expect(file.tabs![exportedA.id]!.map((t) => t.url)).toEqual([
      at("b.localhost", "/blank"), // open tabs first
      whoami(1),
      whoami(2),
    ]);
    expect(Object.keys(file.tabs!)).toEqual([exportedA.id]);

    // A fresh state: no containers, nothing saved.
    await open.close();
    for (const c of await facet.api<Info[]>("listContainers"))
      await facet.api("deleteContainer", c.id);
    expect(await facet.api<Info[]>("listContainers")).toEqual([]);

    const summary = await facet.api<{
      createdContainers: number;
      tabs: number;
    }>("importData", file);
    expect(summary).toMatchObject({ createdContainers: 2, tabs: 3 });
    const made = (await facet.api<Info[]>("listContainers")).find(
      (c) => c.name === A.name,
    )!;
    expect(made).toMatchObject({ tabCount: 0, savedCount: 3 }); // nothing was opened

    const popup = await openPopup(facet);
    await expect(
      rowOf(popup, A.name).getByTestId("container-saved"),
    ).toHaveText("3 saved");
    await expect(
      rowOf(popup, B.name).getByTestId("container-saved"),
    ).toHaveCount(0);
    await popup.close();
  });

  test("the options page exports with tabs and previews an import that has them", async ({
    facet,
  }) => {
    const A = await facet.container("Work");
    const ids = await groupOf(facet, A, 2);
    await closeTogether(facet, ids);
    await expect.poll(async () => (await info(facet, A.id)).savedCount).toBe(2);
    const file = await facet.api("exportData", { includeTabs: true });

    const page = await facet.ctx.newPage();
    await page.setViewportSize({ width: 900, height: 1000 });
    await page.goto(ext("options.html"));
    await page.getByRole("button", { name: "Export and import" }).click();
    const box = page.getByRole("checkbox", {
      name: "Also include tabs (open and saved)",
    });
    await expect(box).toHaveAttribute("aria-checked", "false");
    await box.click();
    await expect(page.getByTestId("tabs-note")).toBeVisible();

    await page.getByTestId("import-file").setInputFiles({
      name: "with-tabs.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(file)),
    });
    await expect(page.getByTestId("import-plan")).toContainText(
      "save 2 tabs for 1 container",
    );
    await page.getByRole("button", { name: "Import", exact: true }).click();
    await expect(page.getByTestId("transfer-status")).toContainText(
      "2 saved tabs",
    );
    await page.close();
  });

  test("a file from before tabs existed still imports", async ({ facet }) => {
    const file = {
      format: "facet-export",
      version: 1,
      exportedAt: 1,
      containers: [
        { id: "old1", name: `Old-${Date.now().toString(36)}`, color: "blue" },
      ],
      rules: [],
    };
    const summary = await facet.api<{
      createdContainers: number;
      tabs: number;
    }>("importData", file);
    expect(summary).toMatchObject({ createdContainers: 1, tabs: 0 });
  });

  test("deleting the container deletes its saved tabs", async ({ facet }) => {
    const A = await facet.container("Work");
    const ids = await groupOf(facet, A, 2);
    await closeTogether(facet, ids);
    await expect.poll(async () => (await info(facet, A.id)).savedCount).toBe(2);
    await facet.api("deleteContainer", A.id);
    const left = await facet.inWorker(
      async () =>
        (await (globalThis as any).chrome.storage.local.get("savedTabs"))
          .savedTabs ?? {},
      null,
    );
    expect(Object.keys(left)).not.toContain(A.id);
  });

  test("a container with no open tab and nothing saved still opens a blank tab, as before", async ({
    facet,
  }) => {
    const A = await facet.container("Work");
    const popup = await openPopup(facet);
    const created = facet.ctx.waitForEvent("page");
    await rowOf(popup, A.name)
      .getByRole("button", { name: `Open ${A.name}` })
      .click();
    facet.adopt(await created);
    await expect.poll(async () => (await info(facet, A.id)).tabCount).toBe(1);
    expect((await info(facet, A.id)).savedCount).toBe(0);
  });
});
