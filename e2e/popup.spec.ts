import type { Page } from "@playwright/test";

import { at, expect, ext, test } from "./fixtures";

interface Info {
  id: string;
  name: string;
  color: string;
  tabCount: number;
}

async function openPopup(
  facet: { ctx: import("@playwright/test").BrowserContext },
  forTab?: number,
): Promise<Page> {
  const page = await facet.ctx.newPage();
  await page.setViewportSize({ width: 380, height: 700 });
  await page.goto(
    ext(`popup.html${forTab === undefined ? "" : `?tab=${forTab}`}`),
  );
  await expect(page.getByRole("heading", { name: "Containers" })).toBeVisible();
  return page;
}

const create = async (page: Page, name: string, color?: string) => {
  await page.getByRole("button", { name: "New container" }).click();
  await page.getByLabel("Name").fill(name);
  if (color) await page.getByRole("radio", { name: color }).click();
  await page.getByRole("button", { name: "Create" }).click();
};

test.describe("popup", () => {
  test("text is set in the bundled Inter font", async ({ facet }) => {
    const popup = await openPopup(facet);
    const font = await popup.evaluate(async () => {
      await document.fonts.ready;
      const loaded = [...document.fonts]
        .filter((f) => f.status === "loaded")
        .map((f) => f.family);
      return {
        body: getComputedStyle(document.body).fontFamily,
        loaded,
        title: getComputedStyle(document.querySelector("h1")!).fontFamily,
      };
    });
    expect(font.body.replace(/"/g, "")).toMatch(/^Inter Variable,/);
    expect(font.title.replace(/"/g, "")).toMatch(/^Inter Variable,/);
    expect(font.loaded.some((f) => /Inter/.test(f))).toBe(true); // the bundled file really loaded (nothing is fetched from the network)
    await popup.close();
  });

  test("creating a container validates while typing and rejects empty, long and duplicate names", async ({
    facet,
  }) => {
    const existing = await facet.container("Taken");
    const popup = await openPopup(facet);
    await popup.getByRole("button", { name: "New container" }).click();
    const name = popup.getByLabel("Name");
    const submit = popup.getByRole("button", { name: "Create" });
    await expect(submit).toBeDisabled();

    await name.fill("x".repeat(60)); // typing cannot go past the limit
    await expect(name).toHaveValue("x".repeat(32));
    await expect(popup.getByText("32/32")).toBeVisible();

    await name.fill(existing.name.toUpperCase()); // a duplicate is reported as the user types, ignoring case
    await expect(popup.getByText(/already exists/)).toBeVisible();
    await expect(submit).toBeDisabled();

    await name.fill("   ");
    await expect(submit).toBeDisabled();
    await name.fill("");
    await name.blur();
    await expect(popup.getByText("Give the container a name.")).toBeVisible();

    await name.fill("Bad\u0007Name​");
    await expect(name).toHaveValue("BadName"); // control and zero-width characters never enter the box
    await expect(submit).toBeEnabled();
    await expect(
      popup.getByText(/already exists|Give the container/),
    ).toHaveCount(0);

    // Escape closes the form without creating anything.
    await name.press("Escape");
    await expect(popup.getByLabel("Name")).toHaveCount(0);
    expect(
      (await facet.api<Info[]>("listContainers")).some(
        (c) => c.name === "BadName",
      ),
    ).toBe(false);
    await popup.close();
  });

  test("creates a container with the chosen colour, by mouse and by keyboard; each one opens a tab in it and closes the popup", async ({
    facet,
  }) => {
    const containerTabs = async (id: string) =>
      (await facet.api<Array<{ containerId: string }>>("listTabs")).filter(
        (t) => t.containerId === id,
      ).length;
    const popup = await openPopup(facet);
    const fresh = `Mouse-${Date.now().toString(36)}`;
    const opened = facet.ctx.waitForEvent("page");
    await create(popup, fresh, "Orange");
    facet.adopt(await opened);
    await expect.poll(() => popup.isClosed()).toBe(true); // a popup closes itself once its job is done
    const made = (await facet.api<Info[]>("listContainers")).find(
      (c) => c.name === fresh,
    )!;
    expect(made.color).toBe("orange");
    await expect.poll(() => containerTabs(made.id)).toBe(1);

    const byKey = `Keys-${Date.now().toString(36)}`;
    const second = await openPopup(facet);
    await expect(
      second
        .getByTestId("container-row")
        .filter({ hasText: fresh })
        .getByTestId("container-tabs"),
    ).toHaveText("1 tab");
    await second.getByRole("button", { name: "New container" }).click();
    await second.getByLabel("Name").fill(byKey);
    const selected = second.getByRole("radio", { checked: true });
    await selected.focus();
    const before = await selected.getAttribute("aria-label");
    await second.keyboard.press("ArrowRight");
    const after = await second
      .getByRole("radio", { checked: true })
      .getAttribute("aria-label");
    expect(after).not.toBe(before);
    await second.keyboard.press("End");
    await expect(
      second.getByRole("radio", { name: "Purple", checked: true }),
    ).toBeFocused();
    const openedByKey = facet.ctx.waitForEvent("page");
    await second.getByLabel("Name").press("Enter"); // Enter in the name field submits
    facet.adopt(await openedByKey);
    await expect.poll(() => second.isClosed()).toBe(true);
    const keyed = (await facet.api<Info[]>("listContainers")).find(
      (c) => c.name === byKey,
    )!;
    expect(keyed.color).toBe("purple");
    await expect.poll(() => containerTabs(keyed.id)).toBe(1);
  });

  test("a failed Create keeps the popup open and opens nothing", async ({
    facet,
  }) => {
    const popup = await openPopup(facet);
    const before = (await facet.api<Array<unknown>>("listTabs")).length;
    await popup.getByRole("button", { name: "New container" }).click();
    const name = `Race-${Date.now().toString(36)}`;
    await popup.getByLabel("Name").fill(name);
    await facet.api("createContainer", { name }); // taken meanwhile (another window): the popup does not know yet
    await popup.getByRole("button", { name: "Create" }).click();
    await expect(popup.getByRole("alert")).toBeVisible();
    expect(popup.isClosed()).toBe(false);
    expect((await facet.api<Array<unknown>>("listTabs")).length).toBe(before);
    await popup.close();
  });

  test('a plain tab shows no "This tab" row; the move-in icon of a row puts it in a container, the swap menu takes it out', async ({
    facet,
  }) => {
    const W = await facet.container("Work");
    const login = await facet.openIn(
      W.name,
      at("a.localhost", "/login?user=popup-user"),
    );
    await expect(login.locator("#user")).toHaveText("popup-user");

    const plain = await facet.plain(at("a.localhost", "/whoami"));
    await expect(plain.locator("#user")).toHaveText("anonymous");
    const tabId = await facet.tabIdOf(plain);
    const popup = await openPopup(facet, tabId);
    await expect(popup.getByTestId("current-container")).toHaveCount(0); // not in a container: nothing about "no container" is shown
    await expect(popup.getByText("No container")).toHaveCount(0);

    // The row's "move in" icon puts the tab into the container (by keyboard), and the tab reloads with the container's cookies.
    const row = popup.getByTestId("container-row").filter({ hasText: W.name });
    const move = row.getByRole("button", {
      name: `Move this tab to ${W.name}`,
    });
    await move.focus();
    await popup.keyboard.press("Enter");
    await expect(popup.getByTestId("current-container")).toContainText(W.name);
    await expect(popup.getByTestId("current-container")).toContainText(
      "a.localhost",
    );
    await expect(plain.locator("#user")).toHaveText("popup-user");
    expect(await facet.api("getTabContainer", tabId)).toBe(W.id);
    await expect(row.locator(".popup__rowmain")).toBeFocused(); // focus lands on the row
    await expect(move).toHaveCount(0); // already there: the row no longer offers the move

    // The swap menu, by keyboard: ArrowDown opens on the first item, End goes to "No container", Enter chooses.
    const trigger = popup
      .getByTestId("current-container")
      .getByRole("button", { name: /Reopen in/ });
    await trigger.focus();
    await popup.keyboard.press("ArrowDown");
    await expect(popup.getByRole("menuitemradio").first()).toBeFocused();
    await popup.keyboard.press("End");
    await expect(
      popup.getByRole("menuitemradio", { name: "No container" }),
    ).toBeFocused();
    await popup.keyboard.press("Enter");
    await expect(popup.getByTestId("current-container")).toHaveCount(0); // the row goes away
    await expect(plain.locator("#user")).toHaveText("anonymous");
    expect(await facet.api("getTabContainer", tabId)).toBeNull();
    await expect(row.locator(".popup__rowmain")).toBeFocused(); // focus lands on the row of the container the tab just left
    await expect(
      row.getByRole("button", { name: `Move this tab to ${W.name}` }),
    ).toHaveCount(1); // and the row offers the move again
    await popup.close();
  });

  test('the swap menu of "This tab" lists the other containers and "No container"; a move by mouse works too', async ({
    facet,
  }) => {
    const A = await facet.container("Alpha");
    const B = await facet.container("Beta");
    const page = await facet.openIn(
      A.name,
      at("a.localhost", "/login?user=alpha-user"),
    );
    const tabId = await facet.tabIdOf(page);
    const popup = await openPopup(facet, tabId);
    await expect(popup.getByTestId("current-container")).toContainText(A.name);
    await popup.getByRole("button", { name: /Reopen in/ }).click();
    await expect(
      popup.getByRole("menu", { name: "Reopen this tab in" }),
    ).toBeVisible();
    await expect(
      popup.getByRole("menuitemradio", { name: "No container" }),
    ).toBeVisible();
    await popup.getByRole("menuitemradio", { name: B.name }).click();
    await expect(popup.getByTestId("current-container")).toContainText(B.name);
    expect(await facet.api("getTabContainer", tabId)).toBe(B.id);
    await expect(page.locator("#user")).toHaveText("anonymous"); // Beta has its own jar
    await popup.close();
  });

  test('a page that is not a website has no "This tab" row and cannot be moved into a container', async ({
    facet,
  }) => {
    const W = await facet.container("Work");
    const blank = await facet.ctx.newPage();
    await blank.goto("about:blank");
    const popup = await openPopup(facet, await facet.tabIdOf(blank));
    await expect(popup.getByTestId("current-container")).toHaveCount(0);
    await expect(popup.getByText("No container")).toHaveCount(0);
    const row = popup.getByTestId("container-row").filter({ hasText: W.name });
    await expect(
      row.getByRole("button", { name: `Edit ${W.name}` }),
    ).toHaveCount(1);
    await expect(
      row.getByRole("button", { name: /Move this tab/ }),
    ).toHaveCount(0);
    await popup.close();
    await blank.close();
  });

  test("the swap menu never scrolls inside the short popup: it fits the viewport and the page is made tall enough for it", async ({
    facet,
  }) => {
    const A = await facet.container("Alpha");
    await facet.container("Beta");
    const tab = await facet.openIn(A.name, at("a.localhost", "/whoami"));
    const popup = await facet.ctx.newPage();
    await popup.setViewportSize({ width: 420, height: 600 }); // the tallest popup Chrome shows
    await popup.goto(ext(`popup.html?tab=${await facet.tabIdOf(tab)}`));
    await expect(
      popup.getByRole("heading", { name: "Containers" }),
    ).toBeVisible();
    const before = await popup.evaluate(
      () => document.documentElement.getBoundingClientRect().height,
    );
    await popup.getByRole("button", { name: /Reopen in/ }).click();
    const menu = popup.getByRole("menu", { name: "Reopen this tab in" });
    await expect(menu).toBeVisible();
    expect(
      await menu.getByRole("menuitemradio").count(),
    ).toBeGreaterThanOrEqual(3); // the containers and "No container"
    const m = await menu.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return {
        top: r.top,
        bottom: r.bottom,
        left: r.left,
        right: r.right,
        scroll: el.scrollHeight,
        client: el.clientHeight,
        page: document.documentElement.getBoundingClientRect().height,
        vw: innerWidth,
        vh: innerHeight,
      };
    });
    expect(m.top).toBeGreaterThanOrEqual(0);
    expect(m.left).toBeGreaterThanOrEqual(0);
    expect(m.bottom).toBeLessThanOrEqual(m.vh);
    expect(m.right).toBeLessThanOrEqual(m.vw);
    expect(m.scroll).toBeLessThanOrEqual(m.client); // no vertical scroll inside the menu
    expect(m.page).toBeGreaterThanOrEqual(Math.min(m.bottom, 600)); // the popup itself is tall enough for the menu
    await popup.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    // Any extra height is given back when the menu closes.
    expect(
      await popup.evaluate(() =>
        document.documentElement.style.getPropertyValue("--fx-menu-min"),
      ),
    ).toBe("");
    expect(
      await popup.evaluate(
        () => document.documentElement.getBoundingClientRect().height,
      ),
    ).toBe(before);
    await popup.close();
  });

  test("row icons replace the tab count on hover, are reachable by Tab without hovering, and the move-in icon only shows for a plain web tab", async ({
    facet,
  }) => {
    const W = await facet.container("Work");
    const E = await facet.container("Empty");
    const tab = await facet.openIn(W.name, at("a.localhost", "/whoami"));
    const plain = await facet.plain(at("a.localhost", "/whoami?plain=1"));
    const popup = await openPopup(facet, await facet.tabIdOf(plain));
    const row = popup.getByTestId("container-row").filter({ hasText: W.name });
    const icons = row.getByRole("group", { name: `${W.name} actions` });
    const count = row.getByTestId("container-tabs");
    const opacity = (loc: import("@playwright/test").Locator) =>
      loc.evaluate((el) => getComputedStyle(el).opacity);

    // At rest: the count shows, the icons are invisible but present.
    await popup.mouse.move(0, 0);
    await expect(count).toHaveText("1 tab");
    expect(await opacity(count)).toBe("1");
    expect(await opacity(icons)).toBe("0");
    const widthBefore = (await row.boundingBox())!.width;
    const nameBefore = (await row.locator(".popup__rowname").boundingBox())!
      .width;

    // Hover: the icons take the count's place, nothing moves.
    await row.hover();
    await expect.poll(() => opacity(icons)).toBe("1");
    expect(await opacity(count)).toBe("0");
    expect((await row.boundingBox())!.width).toBe(widthBefore);
    expect((await row.locator(".popup__rowname").boundingBox())!.width).toBe(
      nameBefore,
    );
    for (const name of [
      `New tab in ${W.name}`,
      `Move this tab to ${W.name}`,
      `Edit ${W.name}`,
      `Delete ${W.name}`,
    ]) {
      const box = (await row
        .getByRole("button", { name, exact: true })
        .boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(28);
      expect(box.height).toBeGreaterThanOrEqual(28);
    }

    // Keyboard: Tab from the row's main button reaches the four icons in order, and they show while focused.
    await popup.mouse.move(0, 0);
    await row.locator(".popup__rowmain").focus();
    for (const name of [
      `New tab in ${W.name}`,
      `Move this tab to ${W.name}`,
      `Edit ${W.name}`,
      `Delete ${W.name}`,
    ]) {
      await popup.keyboard.press("Tab");
      await expect(
        row.getByRole("button", { name, exact: true }),
      ).toBeFocused();
      expect(await opacity(icons)).toBe("1");
    }
    await popup.keyboard.press("Tab");
    // (focus has left the row)
    expect(await opacity(icons)).toBe("0");

    // No tabs: the row has no count; a plain web tab still gets the move-in icon on every container.
    const empty = popup
      .getByTestId("container-row")
      .filter({ hasText: E.name });
    await expect(empty.getByTestId("container-tabs")).toHaveCount(0);
    await expect(
      empty.getByRole("button", { name: `Move this tab to ${E.name}` }),
    ).toHaveCount(1);
    await tab.close();
    await popup.close();

    // A page that is not a website, or a tab already in the container: no move-in icon there.
    const inside = await facet.openIn(
      W.name,
      at("a.localhost", "/whoami?inside=1"),
    );
    const insidePopup = await openPopup(facet, await facet.tabIdOf(inside));
    await expect(
      insidePopup
        .getByTestId("container-row")
        .filter({ hasText: W.name })
        .getByRole("button", { name: /Move this tab/ }),
    ).toHaveCount(0);
    await expect(
      insidePopup
        .getByTestId("container-row")
        .filter({ hasText: E.name })
        .getByRole("button", { name: `Move this tab to ${E.name}` }),
    ).toHaveCount(1);
    await insidePopup.close();
  });

  test('the "+" icon opens a blank tab that is already in the container', async ({
    facet,
  }) => {
    const W = await facet.container("Work");
    const popup = await openPopup(facet);
    const row = popup.getByTestId("container-row").filter({ hasText: W.name });
    await expect(row.getByTestId("container-tabs")).toHaveCount(0); // no tabs: no label
    const opened = facet.ctx.waitForEvent("page");
    await row.hover(); // the icons appear on hover
    await row
      .getByRole("button", { name: `New tab in ${W.name}`, exact: true })
      .click();
    const tab = await opened;
    await expect
      .poll(
        async () =>
          (await facet.api<Array<{ containerId: string }>>("listTabs")).filter(
            (t) => t.containerId === W.id,
          ).length,
      )
      .toBe(1);
    await expect.poll(() => popup.isClosed()).toBe(true); // a popup closes itself once its job is done
    const again = await openPopup(facet);
    await expect(
      again
        .getByTestId("container-row")
        .filter({ hasText: W.name })
        .getByTestId("container-tabs"),
    ).toHaveText("1 tab");
    await again.close();
    // Typing an address into that tab keeps it isolated: here via navigation as the omnibox would do it.
    await tab.goto(at("a.localhost", "/login?user=blank-tab")); // 302 to /whoami
    await expect(tab.locator("#user")).toHaveText("blank-tab");
    expect(await facet.realCookies(at("a.localhost"))).toEqual([]);
    await tab.close();
  });

  test("a row with open tabs goes to the container: its collapsed group opens, its first tab is active, no tab is created", async ({
    facet,
  }) => {
    const W = await facet.container("Work");
    const first = await facet.openIn(
      W.name,
      at("a.localhost", "/whoami?t=first"),
    );
    const second = await facet.openIn(
      W.name,
      at("b.localhost", "/whoami?t=second"),
    );
    const firstId = await facet.tabIdOf(first);
    const secondId = await facet.tabIdOf(second);
    await expect
      .poll(async () => (await facet.tabInfo(firstId)).groupId)
      .toBeGreaterThanOrEqual(0);
    await expect
      .poll(async () => (await facet.tabInfo(secondId)).groupId)
      .toBe((await facet.tabInfo(firstId)).groupId);
    const groupId = (await facet.tabInfo(firstId)).groupId;
    const other = await facet.plain(at("a.localhost", "/whoami?t=other")); // a plain tab in front, the group collapsed behind it
    await other.bringToFront();
    await facet.inWorker(async (id: number) => {
      const c = (globalThis as any).chrome;
      await c.tabs.update(
        (await c.tabs.query({ active: true, currentWindow: true }))[0].id,
        { active: true },
      );
      await c.tabGroups.update(id, { collapsed: true });
    }, groupId);
    await expect
      .poll(
        async () =>
          (
            (await facet.inWorker(
              async (id: number) =>
                (globalThis as any).chrome.tabGroups.get(id),
              groupId,
            )) as { collapsed: boolean }
          ).collapsed,
      )
      .toBe(true);
    const before = (await facet.api<unknown[]>("listTabs")).length;

    const popup = await openPopup(facet);
    const row = popup.getByTestId("container-row").filter({ hasText: W.name });
    await expect(
      row.getByRole("button", { name: `Go to ${W.name}` }),
    ).toBeVisible();
    await row.getByRole("button", { name: `Go to ${W.name}` }).click();
    await expect.poll(() => popup.isClosed()).toBe(true);

    await expect
      .poll(
        async () =>
          (
            (await facet.inWorker(
              async (id: number) =>
                (globalThis as any).chrome.tabGroups.get(id),
              groupId,
            )) as { collapsed: boolean }
          ).collapsed,
      )
      .toBe(false);
    const active = await facet.inWorker(
      async (ids: number[]) => {
        const c = (globalThis as any).chrome;
        return Promise.all(
          ids.map(async (id) => (await c.tabs.get(id)).active),
        );
      },
      [firstId, secondId],
    );
    expect(active).toEqual([true, false]); // the first tab of the group, not the second
    expect((await facet.api<unknown[]>("listTabs")).length).toBe(before); // nothing was opened
    await other.close();
  });

  test("a row without tabs opens a new tab in the container", async ({
    facet,
  }) => {
    const E = await facet.container("Empty");
    const popup = await openPopup(facet);
    const row = popup.getByTestId("container-row").filter({ hasText: E.name });
    const opened = facet.ctx.waitForEvent("page");
    await row
      .getByRole("button", { name: `Open ${E.name}`, exact: true })
      .click();
    facet.adopt(await opened);
    await expect
      .poll(
        async () =>
          (await facet.api<Array<{ containerId: string }>>("listTabs")).filter(
            (t) => t.containerId === E.id,
          ).length,
      )
      .toBe(1);
  });

  test('create a container in the popup (its first tab opens), then open another tab in it with its "+" icon', async ({
    facet,
  }) => {
    const popup = await openPopup(facet);
    const fresh = `Flow-${Date.now().toString(36)}`;
    const first = facet.ctx.waitForEvent("page");
    await create(popup, fresh, "Pink");
    facet.adopt(await first);
    const made = (await facet.api<Info[]>("listContainers")).find(
      (c) => c.name === fresh,
    )!;
    expect(made.color).toBe("pink");
    await expect
      .poll(
        async () =>
          (await facet.api<Array<{ containerId: string }>>("listTabs")).filter(
            (t) => t.containerId === made.id,
          ).length,
      )
      .toBe(1);
    const again = await openPopup(facet);
    const row = again.getByTestId("container-row").filter({ hasText: fresh });
    await expect(row.getByTestId("container-tabs")).toHaveText("1 tab");
    const second = facet.ctx.waitForEvent("page");
    await row.hover();
    await row
      .getByRole("button", { name: `New tab in ${fresh}`, exact: true })
      .click(); // the row itself goes to the open tab; a second one comes from the "+" icon
    facet.adopt(await second);
    await expect
      .poll(
        async () =>
          (await facet.api<Array<{ containerId: string }>>("listTabs")).filter(
            (t) => t.containerId === made.id,
          ).length,
      )
      .toBe(2);
  });

  test("edit (rename, recolour) with the pencil, delete with the trash icon (a custom confirmation that closes the tabs)", async ({
    facet,
  }) => {
    const W = await facet.container("Work");
    const page = await facet.openIn(W.name, at("a.localhost", "/whoami"));
    const popup = await openPopup(facet);
    const row = popup.getByTestId("container-row").filter({ hasText: W.name });

    // Edit through the pencil, with the keyboard only; the form has no delete button.
    await row.getByRole("button", { name: `Edit ${W.name}` }).focus();
    await popup.keyboard.press("Enter");
    const field = popup.getByLabel("Name");
    await expect(field).toHaveValue(W.name);
    await expect(popup.getByRole("button", { name: "Save" })).toBeVisible();
    await expect(
      popup
        .locator(".popup__row--editing")
        .getByRole("button", { name: /Delete/ }),
    ).toHaveCount(0); // the form itself has no delete
    await expect(popup.getByRole("button", { name: "Save" })).toBeEnabled(); // its own name is not a duplicate
    const renamed = `${W.name}-new`;
    await field.fill(renamed);
    await popup.getByRole("radio", { name: "Pink" }).click();
    await popup.getByRole("button", { name: "Save" }).click();
    const edited = popup
      .getByTestId("container-row")
      .filter({ hasText: renamed });
    await expect(edited).toBeVisible();
    expect(
      (await facet.api<Info[]>("listContainers")).find((c) => c.id === W.id),
    ).toMatchObject({ name: renamed, color: "pink" });
    await expect
      .poll(() => page.evaluate(() => document.title))
      .toContain(`[${renamed}]`);

    // Delete is the trash icon: Escape and Cancel keep the container, the dialog is a real modal with focus management.
    const trash = edited.getByRole("button", { name: `Delete ${renamed}` });
    await edited.hover();
    await trash.click();
    const dialog = popup.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Its open tab");
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused(); // the safe answer first
    await popup.keyboard.press("Tab");
    await expect(
      dialog.getByRole("button", { name: "Delete container" }),
    ).toBeFocused();
    await popup.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused(); // focus stays inside
    await popup.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trash).toBeFocused(); // focus is back on the trash icon
    expect(
      (await facet.api<Info[]>("listContainers")).some((c) => c.id === W.id),
    ).toBe(true);

    await edited.hover();
    await trash.click();
    await popup
      .getByRole("alertdialog")
      .getByRole("button", { name: "Delete container" })
      .click();
    await expect(
      popup.getByTestId("container-row").filter({ hasText: renamed }),
    ).toHaveCount(0);
    expect(
      (await facet.api<Info[]>("listContainers")).some((c) => c.id === W.id),
    ).toBe(false);
    await expect.poll(() => page.isClosed()).toBe(true);
    await popup.close();
  });

  test("no native controls, no dialogs, text of at least 14px, and both colour schemes", async ({
    facet,
  }) => {
    const W = await facet.container("Work");
    const tab = await facet.openIn(W.name, at("a.localhost", "/whoami"));
    const tabId = await facet.tabIdOf(tab);
    const pages: Array<[string, string]> = [
      ["popup", ext(`popup.html?tab=${tabId}`)],
      ["options", ext("options.html")],
      [
        "choose",
        ext(
          `choose.html?url=${encodeURIComponent(at("a.localhost", "/whoami"))}&tab=${tabId}`,
        ),
      ],
    ];
    for (const scheme of ["light", "dark"] as const) {
      for (const [name, url] of pages) {
        const page = await facet.ctx.newPage();
        const dialogs: string[] = [];
        page.on("dialog", async (d) => {
          dialogs.push(d.message());
          await d.dismiss();
        });
        await page.emulateMedia({ colorScheme: scheme });
        await page.goto(url);
        await page.waitForTimeout(400);
        const audit = await page.evaluate(() => {
          const banned = document.querySelectorAll(
            "select, dialog, datalist, input[type=date], input[type=time], input[type=datetime-local], input[type=month], input[type=week], input[type=color], input[type=range], input[type=number], input[type=email], input[type=url], input[type=tel]",
          );
          const forms = [...document.querySelectorAll("form")].filter(
            (f) => !f.noValidate,
          ).length;
          const tooSmall: string[] = [];
          const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_TEXT,
          );
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            if (!n.textContent?.trim()) continue;
            const el = n.parentElement!;
            const style = getComputedStyle(el);
            if (
              style.display === "none" ||
              style.visibility === "hidden" ||
              el.closest(".fx-sr-only")
            )
              continue;
            if (parseFloat(style.fontSize) < 14)
              tooSmall.push(
                `${el.tagName}.${el.className}:${style.fontSize}:${n.textContent.trim().slice(0, 30)}`,
              );
          }
          return {
            banned: banned.length,
            forms,
            tooSmall,
            background: getComputedStyle(document.body).backgroundColor,
          };
        });
        expect(audit.banned, `${name}: native controls`).toBe(0);
        expect(audit.forms, `${name}: forms without novalidate`).toBe(0);
        expect(audit.tooSmall, `${name}: text under 14px`).toEqual([]);
        expect(dialogs, `${name}: alert/confirm/prompt`).toEqual([]);
        const [r, g, b] = audit.background.match(/\d+/g)!.map(Number) as [
          number,
          number,
          number,
        ];
        const light = (r + g + b) / 3 > 128;
        expect(light, `${name} in ${scheme} mode`).toBe(scheme === "light");
        await page.close();
      }
    }
  });
});
