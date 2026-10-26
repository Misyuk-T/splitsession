import type { Page } from "@playwright/test";

import { at, expect, type Facet, go, test } from "./fixtures";

const setCookie = (host: string, value: string) =>
  at(host, `/set?c=${encodeURIComponent(`${value}; Max-Age=86400; Path=/`)}`);

const guardLog = async (facet: Facet) =>
  (await facet.api<Array<{ message: string }>>("getLog"))
    .map((e) => e.message)
    .filter((m) => m.startsWith("group guard:"));

/** The tab IDs of a group, left to right. */
const groupIds = (facet: Facet, groupId: number) =>
  facet.inWorker(
    async (g: number) =>
      (await (globalThis as any).chrome.tabs.query({ groupId: g }))
        .sort((a: { index: number }, b: { index: number }) => a.index - b.index)
        .map((t: { id: number }) => t.id) as number[],
    groupId,
  );

test.describe("a duplicated container tab", () => {
  test("“Duplicate” of a container tab on a login-required page stays logged in: the guard reopens it at the address the duplicate was created with, not at the sign-in page the unisolated copy was redirected to", async ({
    facet,
  }) => {
    const R = await facet.container("Reddit");
    const page = await facet.openIn(
      R.name,
      setCookie("a.localhost", "who=reddit"),
    );
    await go(page, at("a.localhost", "/private?t=orig"));
    await expect(page.locator("#user")).toHaveText("reddit");
    const tabId = await facet.tabIdOf(page);
    await expect
      .poll(async () => (await facet.tabInfo(tabId)).groupId)
      .toBeGreaterThanOrEqual(0);
    const groupId = (await facet.tabInfo(tabId)).groupId;
    // The real profile has no login for the site: an unisolated load is redirected to the sign-in page.
    await facet.clearLog();

    const adopt = (p: Page) => facet.adopt(p);
    facet.ctx.on("page", adopt);
    const dup = await facet.inWorker(async (id: number) => {
      const t = await (globalThis as any).chrome.tabs.duplicate(id);
      return {
        id: t.id as number,
        groupId: t.groupId as number,
        index: t.index as number,
        opener: t.openerTabId as number | undefined,
        pendingUrl: t.pendingUrl as string | undefined,
        url: t.url as string | undefined,
      };
    }, tabId);
    // Like the UI's "Duplicate": in the original's group, the original as opener, created with its address.
    expect(dup).toMatchObject({
      groupId,
      opener: tabId,
      pendingUrl: at("a.localhost", "/private?t=orig"),
    });

    // Whichever tab ends up next to the original is the duplicate (reopened: another ID than `dup.id`).
    await expect
      .poll(
        async () => {
          const ids = await groupIds(facet, groupId);
          const other = ids.find((id) => id !== tabId);
          return ids.length === 2 && other !== undefined
            ? facet.api("getTabContainer", other)
            : null;
        },
        { timeout: 15_000 },
      )
      .toBe(R.id);
    const finalId = (await groupIds(facet, groupId)).find(
      (id) => id !== tabId,
    ) as number;
    let final: Page | undefined;
    for (const p of facet.ctx.pages())
      if (!p.isClosed() && (await facet.tabIdOf(p).catch(() => -1)) === finalId)
        final = p;
    expect(final).toBeDefined();
    await final!.waitForLoadState("domcontentloaded");
    expect((await guardLog(facet)).join("\n")).toContain(
      `tab ${dup.id} no container -> ${R.id} (created in the group): reopened in it`,
    );
    // The unisolated copy was redirected to the sign-in page; the container tab asked for the address, with its cookie.
    const log = await facet.serverLog();
    expect(log.at(-1)).toMatchObject({
      path: "/private?t=orig",
      cookie: "who=reddit",
    });
    expect(log.filter((e) => e.path.startsWith("/signin")).at(-1)?.cookie).toBe(
      "",
    );
    await expect(final!.locator("#user")).toHaveText("reddit");
    expect(final!.url()).toBe(at("a.localhost", "/private?t=orig"));
    facet.ctx.off("page", adopt);
  });
});
