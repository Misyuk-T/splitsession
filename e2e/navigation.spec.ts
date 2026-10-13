import { at, expect, go, pageJson, test } from "./fixtures";

interface JarCookie {
  name: string;
  value: string;
}

test.describe("tabs and navigation", () => {
  test("window.open popup inherits the container and its first request already carries container cookies", async ({
    facet,
  }) => {
    const A = await facet.container("A");
    const B = await facet.container("B");
    const pa = await facet.openIn(
      A.name,
      at("sso.localhost", "/sso/login?user=sso-alice"),
    );
    await expect(pa.locator("#user")).toHaveText("sso-alice");
    const pb = await facet.openIn(
      B.name,
      at("sso.localhost", "/sso/login?user=sso-bob"),
    );
    await expect(pb.locator("#user")).toHaveText("sso-bob");
    const ssoSid = (await facet.api<JarCookie[]>("getJar", A.id)).find(
      (c) => c.name === "sso_sid",
    )!.value;

    await go(pa, at("a.localhost", "/popup-login"));
    await facet.clearLog();
    const popupEvent = facet.ctx.waitForEvent("page");
    await pa.click("#go");
    const popup = await popupEvent;
    await expect(popup.locator("#user")).toHaveText("sso-alice");
    await expect(pa.locator("#result")).toHaveText("sso-alice"); // window.opener kept: postMessage arrived

    const authorize = (await facet.serverLog()).filter(
      (e) => e.host === "sso.localhost" && e.path.startsWith("/authorize"),
    );
    expect(authorize.length).toBeGreaterThanOrEqual(1);
    for (const hit of authorize) expect(hit.cookie).toBe(`sso_sid=${ssoSid}`);
    expect(await facet.api("getTabContainer", await facet.tabIdOf(popup))).toBe(
      A.id,
    );
    expect(await facet.realCookies(at("sso.localhost"))).toEqual([]);
  });

  test("target=_blank links and modified clicks open in the same container without a real-profile request", async ({
    facet,
  }) => {
    const A = await facet.container("A");
    const pa = await facet.openIn(
      A.name,
      at("a.localhost", "/login?user=linker&next=/links"),
    );
    await expect(pa.locator("#blank")).toBeVisible();
    await facet.clearLog();
    const opened = facet.ctx.waitForEvent("page");
    await pa.click("#blank");
    const child = await opened;
    await expect(child.locator("#user")).toHaveText("linker");
    const hits = (await facet.serverLog()).filter(
      (e) => e.path === "/whoami?via=blank",
    );
    expect(hits.length).toBe(1);
    expect(hits[0]!.cookie).toContain("sid=");
    expect(await facet.api("getTabContainer", await facet.tabIdOf(child))).toBe(
      A.id,
    );

    const withOpener = facet.ctx.waitForEvent("page");
    await pa.click("#opener");
    const openerChild = await withOpener;
    await expect(openerChild.locator("#user")).toHaveText("linker");
    expect(await openerChild.evaluate(() => window.opener !== null)).toBe(true);

    const middle = facet.ctx.waitForEvent("page");
    await pa.click("#same", { button: "middle" });
    const background = await middle;
    await expect(background.locator("#user")).toHaveText("linker");

    const modified = facet.ctx.waitForEvent("page");
    await pa.click("#same", { modifiers: ["ControlOrMeta"] });
    const viaModifier = await modified;
    await expect(viaModifier.locator("#user")).toHaveText("linker");
    expect(
      await facet.api("getTabContainer", await facet.tabIdOf(viaModifier)),
    ).toBe(A.id);
    expect(pa.url()).toContain("/links"); // the opener did not navigate
    expect(await facet.realCookies(at("a.localhost"))).toEqual([]);
  });

  test("fallback: a child tab the shim did not intercept inherits the container and is re-navigated", async ({
    facet,
  }) => {
    const A = await facet.container("A");
    const pa = await facet.openIn(
      A.name,
      at("a.localhost", "/login?user=former&next=/form"),
    );
    await expect(pa.locator("#submit")).toBeVisible();
    await facet.clearLog();
    const opened = facet.ctx.waitForEvent("page");
    await pa.click("#submit");
    const child = await opened;
    await expect(child.locator("#user")).toHaveText("former");
    expect(await facet.api("getTabContainer", await facet.tabIdOf(child))).toBe(
      A.id,
    );
    // Known hole (docs/limits.md): the first request of such a tab may still go out as the real profile.
    const hits = (await facet.serverLog()).filter(
      (e) => e.path === "/whoami?via=form",
    );
    expect(hits.at(-1)!.cookie).toContain("sid=");
    expect(await facet.realCookies(at("a.localhost"))).toEqual([]);

    // A tab the user opens next to it (Ctrl+T, or over CDP as here) is not a child of the page.
    await pa.bringToFront();
    const fresh = await facet.plain(at("a.localhost", "/whoami"));
    await expect(fresh.locator("#user")).toHaveText("anonymous");
    expect(
      await facet.api("getTabContainer", await facet.tabIdOf(fresh)),
    ).toBeNull();
  });

  test("open.html puts the tab into the container before its first request (by name, by ID, or a new name)", async ({
    facet,
  }) => {
    const Z = await facet.container("Z");
    const login = await facet.openIn(
      Z.name,
      at("a.localhost", "/login?user=zed"),
    );
    await expect(login.locator("#user")).toHaveText("zed");

    await facet.clearLog();
    const byName = await facet.openIn(
      Z.name,
      at("a.localhost", "/whoami?first=name"),
    );
    await expect(byName.locator("#user")).toHaveText("zed");
    const byId = await facet.openIn(
      Z.id,
      at("a.localhost", "/whoami?first=id"),
    );
    await expect(byId.locator("#user")).toHaveText("zed");
    const log = await facet.serverLog();
    for (const path of ["/whoami?first=name", "/whoami?first=id"]) {
      const hits = log.filter((e) => e.path === path);
      expect(hits, path).toHaveLength(1);
      expect(hits[0]!.cookie).toContain("sid=");
    }

    const fresh = `fresh-${Date.now().toString(36)}`;
    const created = await facet.openIn(fresh, at("a.localhost", "/whoami"));
    await expect(created.locator("#user")).toHaveText("anonymous");
    const containers =
      await facet.api<Array<{ id: string; name: string }>>("listContainers");
    const made = containers.find((c) => c.name === fresh);
    expect(made).toBeDefined();
    expect(
      await facet.api("getTabContainer", await facet.tabIdOf(created)),
    ).toBe(made!.id);
    expect(await facet.realCookies(at("a.localhost"))).toEqual([]);
  });

  test("a #ctr=<name> marker moves the tab into the container and strips the marker", async ({
    facet,
  }) => {
    const Z = await facet.container("Z");
    const login = await facet.openIn(
      Z.name,
      at("a.localhost", "/login?user=zed"),
    );
    await expect(login.locator("#user")).toHaveText("zed");

    const page = await facet.plain(
      at("a.localhost", `/whoami?x=1#ctr=${encodeURIComponent(Z.name)}`),
    );
    await expect(page.locator("#user")).toHaveText("zed");
    await expect.poll(() => page.url()).toBe(at("a.localhost", "/whoami?x=1"));
    expect(await facet.api("getTabContainer", await facet.tabIdOf(page))).toBe(
      Z.id,
    );
    expect(await facet.realCookies(at("a.localhost"))).toEqual([]);

    // A marker naming no container (any web page can link one) neither creates a container nor moves the tab.
    const before = (await facet.api<unknown[]>("listContainers")).length;
    const stray = await facet.plain(
      at("a.localhost", "/whoami#ctr=no-such-container"),
    );
    await expect(stray.locator("#user")).toHaveText("anonymous");
    await stray.waitForTimeout(300);
    expect(
      await facet.api("getTabContainer", await facet.tabIdOf(stray)),
    ).toBeNull();
    expect((await facet.api<unknown[]>("listContainers")).length).toBe(before);
  });

  test("API: openInContainer, assignTab and deleteContainer", async ({
    facet,
  }) => {
    const A = await facet.container("A");
    const opened = facet.ctx.waitForEvent("page");
    const tabId = await facet.api<number>(
      "openInContainer",
      at("a.localhost", "/login?user=api"),
      A.id,
    );
    const page = await opened;
    await expect(page.locator("#user")).toHaveText("api");
    expect(await facet.api("getTabContainer", tabId)).toBe(A.id);

    // Take the tab out: it becomes a plain tab again (real profile, no session).
    await facet.api("assignTab", tabId, null, { reload: true });
    await expect(page.locator("#user")).toHaveText("anonymous");
    await facet.api("assignTab", tabId, A.id, { reload: true });
    await expect(page.locator("#user")).toHaveText("api");

    const closed = page.waitForEvent("close");
    await facet.api("deleteContainer", A.id);
    await closed;
    expect(await facet.api("getJar", A.id)).toEqual([]);
    const rules =
      await facet.api<Array<{ condition: { tabIds?: number[] } }>>(
        "getSessionRules",
      );
    expect(rules.some((r) => r.condition.tabIds?.includes(tabId))).toBe(false);
  });

  test("isolation survives a service-worker restart", async ({ facet }) => {
    const A = await facet.container("A");
    const B = await facet.container("B");
    const pa = await facet.openIn(
      A.name,
      at("a.localhost", "/login?user=alice"),
    );
    const pb = await facet.openIn(B.name, at("a.localhost", "/login?user=bob"));
    await expect(pa.locator("#user")).toHaveText("alice");
    await expect(pb.locator("#user")).toHaveText("bob");
    await pa.waitForTimeout(400); // jar writes are debounced

    const before = await facet.sw();
    await before.evaluate(
      () =>
        ((globalThis as { __bootMarker?: string }).__bootMarker =
          "before-restart"),
    );
    await facet.stopServiceWorker(pb);
    expect(await facet.serviceWorkerTargets(pb)).toBe(0);

    // While the worker is stopped the session rules keep working.
    expect((await pageJson(pa, "/me")).user).toBe("alice");
    expect((await pageJson(pb, "/me")).user).toBe("bob");
    // A new Set-Cookie wakes the worker, which rehydrates and captures it.
    await go(pa, at("a.localhost", "/login?user=alice2"));
    await expect(pa.locator("#user")).toHaveText("alice2");
    // Playwright re-binds the Worker handle to the restarted worker: the marker set before the stop is gone.
    const marker = () =>
      Promise.race([
        before.evaluate(
          () =>
            (globalThis as { __bootMarker?: string }).__bootMarker ?? "fresh",
        ),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve("unreachable"), 1_000),
        ),
      ]);
    await expect.poll(marker, { timeout: 10_000 }).toBe("fresh");
    await pb.reload();
    await expect(pb.locator("#user")).toHaveText("bob");
    const plain = await facet.plain(at("a.localhost", "/whoami"));
    await expect(plain.locator("#user")).toHaveText("anonymous");
    expect(await facet.realCookies(at("a.localhost"))).toEqual([]);
    const tabs =
      await facet.api<Array<{ tabId: number; containerId: string }>>(
        "listTabs",
      );
    expect(tabs.find((t) => t.containerId === A.id)).toBeDefined();
    expect(tabs.find((t) => t.containerId === B.id)).toBeDefined();
  });
});
