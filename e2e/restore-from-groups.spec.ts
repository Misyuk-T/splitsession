import type { Page } from "@playwright/test";

import { at, expect, ext, type Facet, go, test } from "./fixtures";

interface Info {
  id: string;
  name: string;
  color: string;
}

async function openPopup(facet: Facet): Promise<Page> {
  const page = await facet.ctx.newPage();
  await page.setViewportSize({ width: 420, height: 700 });
  await page.goto(ext("popup.html"));
  await expect(page.getByRole("heading", { name: "Containers" })).toBeVisible();
  return page;
}

/** A container tab inside the container's tab group. */
async function containerTab(facet: Facet, ref: string, path: string) {
  const page = await facet.openIn(ref, at("a.localhost", path));
  await go(page, at("a.localhost", path));
  const tabId = await facet.tabIdOf(page);
  await expect
    .poll(async () => (await facet.tabInfo(tabId)).groupId)
    .toBeGreaterThanOrEqual(0);
  return { page, tabId, groupId: (await facet.tabInfo(tabId)).groupId };
}

/** Every tab group of the browser, with its tabs. */
const allGroups = (facet: Facet) =>
  facet.inWorker(async () => {
    const c = (globalThis as any).chrome;
    const groups: Array<{ id: number; title?: string; color: string }> =
      await c.tabGroups.query({});
    return Promise.all(
      groups.map(async (g) => ({
        id: g.id,
        color: g.color,
        tabs: (await c.tabs.query({ groupId: g.id })).map(
          (t: { id: number }) => t.id,
        ) as number[],
      })),
    );
  }, null);

/**
 * What a reinstall does: chrome.storage is wiped (containers, jars, settings, tab records), the tabs and their groups stay.
 * The worker is stopped right after the wipe, so the next one (woken by the popup) starts from the empty storage.
 */
async function reinstall(facet: Facet, via: Page): Promise<void> {
  await facet.api("flushRestore");
  await facet.inWorker(async () => {
    const c = (globalThis as any).chrome;
    await c.storage.local.clear();
    await c.storage.session.clear();
  }, null);
  await facet.stopServiceWorker(via);
}

/** A group of the user's own, around a plain tab. */
async function userGroup(facet: Facet, tabId: number, title: string) {
  return facet.inWorker(
    async ([id, name]: [number, string]) => {
      const c = (globalThis as any).chrome;
      const groupId: number = await c.tabs.group({ tabIds: [id] });
      await c.tabGroups.update(groupId, { title: name, color: "red" });
      return groupId;
    },
    [tabId, title] as [number, string],
  );
}

test.describe("restore containers from leftover tab groups", () => {
  // The "no thanks" flag lives in the browser's storage, which the specs share.
  test.afterEach(async ({ facet }) => {
    await facet.inWorker(
      () =>
        (globalThis as any).chrome.storage.local.remove(
          "groupRestoreDismissed",
        ),
      null,
    );
  });

  test("after a reinstall the popup offers the marked groups only; Restore adopts the same groups and puts their tabs in new containers", async ({
    facet,
  }) => {
    const main = await facet.api<Info>("createContainer", {
      name: "main",
      color: "turquoise",
    });
    const second = await facet.api<Info>("createContainer", {
      name: "secondline",
      color: "pink",
    });
    const m1 = await containerTab(facet, main.id, "/whoami?restore=m1");
    const m2 = await containerTab(facet, main.id, "/whoami?restore=m2");
    const s1 = await containerTab(facet, second.id, "/whoami?restore=s1");
    expect(m1.groupId).toBe(m2.groupId);
    expect(s1.groupId).not.toBe(m1.groupId);

    // m2 is a tab Chrome has thrown out of memory (nothing loaded); m1 and s1 are loaded pages.
    // (Discarding may give the tab a new ID.)
    const discardedId = await facet.inWorker(
      async (id: number) =>
        (await (globalThis as any).chrome.tabs.discard(id)).id as number,
      m2.tabId,
    );
    await m1.page.evaluate(() => ((window as any).loadedBefore = true));
    await s1.page.evaluate(() => ((window as any).loadedBefore = true));

    // The user's own groups: one plain, one that only looks like ours.
    const plain = await facet.plain(at("b.localhost", "/whoami?restore=user"));
    const plainId = await facet.tabIdOf(plain);
    const userGroupId = await userGroup(facet, plainId, "Reading");
    const fake = await facet.plain(at("b.localhost", "/whoami?restore=fake"));
    const fakeId = await facet.tabIdOf(fake);
    const fakeGroupId = await userGroup(facet, fakeId, "⧉ fake");

    const popupBefore = await openPopup(facet);
    await expect(popupBefore.getByTestId("group-restore-offer")).toHaveCount(0);
    await popupBefore.close();

    await reinstall(facet, plain);
    const popup = await openPopup(facet); // wakes the new worker
    const groupsBefore = await allGroups(facet);
    expect(groupsBefore.map((g) => g.id).sort()).toEqual(
      [m1.groupId, s1.groupId, userGroupId, fakeGroupId].sort(),
    );

    const offer = popup.getByTestId("group-restore-offer");
    await expect(offer).toBeVisible();
    await expect(offer).toContainText(
      "Found 2 tab groups from an earlier install. Restore them as containers?",
    );
    await offer.getByRole("button", { name: "Restore" }).click();

    await expect(popup.getByTestId("group-restore-note")).toContainText(
      "Restored 2 containers. Sign in again: a reinstall removes saved logins.",
    );
    await expect(offer).toHaveCount(0);
    await expect(
      popup.getByTestId("container-list").getByRole("listitem"),
    ).toHaveCount(2);

    // New containers with the groups' names and colours (the old IDs: the marker named them).
    const containers = await facet.api<Info[]>("listContainers");
    expect(containers.map((c) => [c.name, c.color]).sort()).toEqual([
      ["main", "turquoise"],
      ["secondline", "pink"],
    ]);
    const idOf = (name: string) => containers.find((c) => c.name === name)!.id;
    expect(idOf("main")).toBe(main.id);

    // The tabs are the same tabs, in their containers; the page that was loaded was loaded again, the discarded one was not.
    for (const [tabId, container] of [
      [m1.tabId, "main"],
      [discardedId, "main"],
      [s1.tabId, "secondline"],
    ] as const)
      expect(await facet.api("getTabContainer", tabId)).toBe(idOf(container));
    await expect
      .poll(() => m1.page.evaluate(() => (window as any).loadedBefore === true))
      .toBe(false);
    await expect
      .poll(() => s1.page.evaluate(() => (window as any).loadedBefore === true))
      .toBe(false);
    expect(
      await facet.inWorker(
        async (id: number) =>
          (await (globalThis as any).chrome.tabs.get(id)).discarded as boolean,
        discardedId,
      ),
    ).toBe(true);

    // The group guard sweeps after group changes (1 s): it has nothing to fix, no tab is reopened.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(
      (await facet.api<Array<{ message: string }>>("getLog")).filter((e) =>
        e.message.startsWith("group guard:"),
      ),
    ).toEqual([]);
    for (const tabId of [m1.tabId, discardedId, s1.tabId])
      expect((await facet.tabInfo(tabId)).id).toBe(tabId);

    // The very same groups now stand for the containers: nothing new, nothing emptied.
    expect((await allGroups(facet)).map((g) => g.id).sort()).toEqual(
      groupsBefore.map((g) => g.id).sort(),
    );
    expect((await facet.tabInfo(m1.tabId)).groupId).toBe(m1.groupId);
    expect((await facet.tabInfo(discardedId)).groupId).toBe(m1.groupId);
    expect((await facet.tabInfo(s1.tabId)).groupId).toBe(s1.groupId);
    expect(await facet.groupInfo(m1.groupId)).toMatchObject({
      title: "⧉ main",
      color: "cyan",
      marker: idOf("main"),
    });
    expect(await facet.groupInfo(s1.groupId)).toMatchObject({
      title: "⧉ secondline",
      color: "pink",
      marker: idOf("secondline"),
    });

    // The user's own groups are untouched.
    expect(await facet.api("getTabContainer", plainId)).toBeNull();
    expect(await facet.api("getTabContainer", fakeId)).toBeNull();
    expect((await facet.tabInfo(plainId)).groupId).toBe(userGroupId);
    expect(await facet.groupInfo(userGroupId)).toMatchObject({
      title: "Reading",
      marker: null,
    });
    expect((await facet.tabInfo(fakeId)).groupId).toBe(fakeGroupId);

    // Nothing is offered any more, in a popup opened later either.
    await popup.close();
    const again = await openPopup(facet);
    await expect(again.getByTestId("group-restore-offer")).toHaveCount(0);
    expect(await facet.api("getGroupRestoreOffer")).toBeNull();
    await again.close();
  });

  test("only groups of the user's own: nothing is offered", async ({
    facet,
  }) => {
    const page = await facet.plain(at("b.localhost", "/whoami?restore=own"));
    const tabId = await facet.tabIdOf(page);
    await userGroup(facet, tabId, "⧉ looks like ours");
    const popup = await openPopup(facet);
    await expect(popup.getByTestId("group-restore-offer")).toHaveCount(0);
    expect(await facet.api("getGroupRestoreOffer")).toBeNull();
    await popup.close();
  });

  test("dismiss is remembered: no offer in a popup opened later, and the groups are left alone", async ({
    facet,
  }) => {
    const main = await facet.api<Info>("createContainer", { name: "main" });
    const tab = await containerTab(facet, main.id, "/whoami?restore=d1");
    await reinstall(facet, tab.page);

    const popup = await openPopup(facet);
    const offer = popup.getByTestId("group-restore-offer");
    await expect(offer).toContainText(
      "Found 1 tab group from an earlier install",
    );
    await offer.getByRole("button", { name: "Dismiss" }).click();
    await expect(offer).toHaveCount(0);
    await expect(popup.getByText("No containers yet")).toBeVisible();
    await popup.close();

    const again = await openPopup(facet);
    await expect(again.getByTestId("group-restore-offer")).toHaveCount(0);
    expect(await facet.api("getGroupRestoreOffer")).toBeNull();
    expect(await facet.api<Info[]>("listContainers")).toEqual([]);
    expect((await facet.tabInfo(tab.tabId)).groupId).toBe(tab.groupId);
    await again.close();
  });
});
