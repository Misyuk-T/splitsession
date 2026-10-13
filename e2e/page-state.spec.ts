import type { Page } from "@playwright/test";

import { at, expect, go, pageText, test } from "./fixtures";

test.describe("page JS state", () => {
  test("document.cookie and cookieStore writes stay in their container and reach the next request", async ({
    facet,
  }) => {
    const A = await facet.container("A");
    const B = await facet.container("B");
    const pa = await facet.openIn(A.name, at("a.localhost", "/blank"));
    const pb = await facet.openIn(B.name, at("a.localhost", "/blank"));

    const afterWrite = await pa.evaluate(() => {
      document.cookie = "pref=A-dark; Path=/";
      return document.cookie;
    });
    expect(afterWrite).toContain("pref=A-dark");
    // The very next request already carries it (fetch waits for the write to reach the rules).
    expect(
      await pa.evaluate(async () => (await fetch("/echo")).text()),
    ).toContain("pref=A-dark");

    expect(await pb.evaluate(() => document.cookie)).not.toContain("pref=");
    expect(await pageText(pb, "/echo")).not.toContain("pref=");
    await pb.evaluate(() => (document.cookie = "pref=B-light; Path=/"));
    expect(await pageText(pb, "/echo")).toContain("pref=B-light");
    expect(await pageText(pa, "/echo")).toContain("pref=A-dark");

    // cookieStore goes through the same jar.
    const cs = await pa.evaluate(async () => {
      const store = (window as unknown as { cookieStore: any }).cookieStore;
      await store.set("cs", "one");
      return {
        doc: document.cookie,
        pref: (await store.get("pref"))?.value ?? null,
        all: (await store.getAll()).length,
      };
    });
    expect(cs.doc).toContain("cs=one");
    expect(cs.pref).toBe("A-dark");
    expect(cs.all).toBeGreaterThanOrEqual(2);
    expect(
      await pb.evaluate(
        async () => (await (window as any).cookieStore.get("cs")) ?? null,
      ),
    ).toBeNull();

    // A page that writes document.cookie in an inline script at load; a new tab of the container sees it at load.
    const loader = await facet.openIn(
      A.name,
      at("a.localhost", "/doc-cookie?v=inline"),
    );
    await expect(loader.locator("#after")).toContainText("pref=inline");
    const second = await facet.openIn(A.name, at("a.localhost", "/blank"));
    expect(await second.evaluate(() => document.cookie)).toContain(
      "pref=inline",
    );

    const plain = await facet.plain(at("a.localhost", "/blank"));
    expect(await plain.evaluate(() => document.cookie)).toBe("");
    expect(await facet.realCookies(at("a.localhost"))).toEqual([]);
  });

  test("Web Storage, IndexedDB, Cache Storage and BroadcastChannel are per container; plain tabs keep their own", async ({
    facet,
  }) => {
    const A = await facet.container("A");
    const B = await facet.container("B");
    const url = at("a.localhost", "/blank");
    const pa = await facet.openIn(A.name, url);
    const pb = await facet.openIn(B.name, url);
    const plain = await facet.plain(url);

    const write = (page: Page, label: string) =>
      page.evaluate(async (v) => {
        localStorage.setItem("k", v);
        sessionStorage.setItem("k", v);
        await new Promise<void>((resolve, reject) => {
          const req = indexedDB.open("db", 1);
          req.onupgradeneeded = () => req.result.createObjectStore("s");
          req.onerror = () => reject(req.error);
          req.onsuccess = () => {
            const tx = req.result.transaction("s", "readwrite");
            tx.objectStore("s").put(v, "k");
            tx.oncomplete = () => {
              req.result.close();
              resolve();
            };
          };
        });
        await (await caches.open("c")).put("/x", new Response(v));
      }, label);
    const read = (page: Page) =>
      page.evaluate(async () => {
        const idb = await new Promise<{ value: unknown; name: string }>(
          (resolve, reject) => {
            const req = indexedDB.open("db", 1);
            req.onupgradeneeded = () => req.result.createObjectStore("s");
            req.onerror = () => reject(req.error);
            req.onsuccess = () => {
              const db = req.result;
              const get = db.transaction("s").objectStore("s").get("k");
              get.onsuccess = () => {
                resolve({ value: get.result, name: db.name });
                db.close();
              };
            };
          },
        );
        return {
          ls: localStorage.getItem("k"),
          lsProp: (localStorage as unknown as Record<string, string>).k,
          lsKeys: Object.keys(localStorage),
          lsLength: localStorage.length,
          ss: sessionStorage.getItem("k"),
          idb: idb.value,
          dbName: idb.name,
          dbs: (await indexedDB.databases()).map((d) => d.name),
          cache: (await (await caches.match("/x"))?.text()) ?? null,
          cacheKeys: await caches.keys(),
        };
      });

    await write(pa, "A");
    await write(pb, "B");
    await write(plain, "real");
    const own = (v: string) => ({
      ls: v,
      lsProp: v,
      lsKeys: ["k"],
      lsLength: 1,
      ss: v,
      idb: v,
      dbName: "db",
      dbs: ["db"],
      cache: v,
      cacheKeys: ["c"],
    });
    expect(await read(pa)).toEqual(own("A"));
    expect(await read(pb)).toEqual(own("B"));
    expect(await read(plain)).toEqual(own("real"));

    // clear() only clears the caller's namespace.
    await pb.evaluate(() => localStorage.clear());
    expect(await pb.evaluate(() => localStorage.length)).toBe(0);
    expect(await pa.evaluate(() => localStorage.getItem("k"))).toBe("A");
    expect(await plain.evaluate(() => localStorage.getItem("k"))).toBe("real");

    // `storage` events: a second tab of A hears A's writes, B does not.
    const pa2 = await facet.openIn(A.name, url);
    const listen = (page: Page) =>
      page.evaluate(() => {
        (window as any).__events = [];
        window.addEventListener("storage", (e) =>
          (window as any).__events.push(`${e.key}=${e.newValue}`),
        );
      });
    await listen(pa2);
    await listen(pb);
    await pa.evaluate(() => localStorage.setItem("ev", "1"));
    await expect
      .poll(() => pa2.evaluate(() => (window as any).__events))
      .toEqual(["ev=1"]);
    await pb.waitForTimeout(200);
    expect(await pb.evaluate(() => (window as any).__events)).toEqual([]);

    // BroadcastChannel: same name, different containers, no crosstalk.
    const subscribe = (page: Page) =>
      page.evaluate(() => {
        (window as any).__bc = [];
        const ch = new BroadcastChannel("chan");
        ch.onmessage = (e) => (window as any).__bc.push(e.data);
        (window as any).__ch = ch;
        return ch.name;
      });
    expect(await subscribe(pa2)).toBe("chan");
    await subscribe(pb);
    await subscribe(plain);
    await pa.evaluate(() => new BroadcastChannel("chan").postMessage("from-A"));
    await expect
      .poll(() => pa2.evaluate(() => (window as any).__bc))
      .toEqual(["from-A"]);
    await pb.waitForTimeout(200);
    expect(await pb.evaluate(() => (window as any).__bc)).toEqual([]);
    expect(await plain.evaluate(() => (window as any).__bc)).toEqual([]);
  });

  test("SharedWorker is gone and service workers are refused in containers; without strict mode, unmanaged plain tabs keep both", async ({
    facet,
  }) => {
    await facet.api("updateSettings", { strictMode: false }); // strict mode would refuse workers everywhere
    const A = await facet.container("A");
    const page = await facet.openIn(A.name, at("a.localhost", "/sw-page"));
    await expect(page.locator("#sw")).toHaveText("rejected: SecurityError");
    expect(await page.evaluate(() => typeof SharedWorker)).toBe("undefined");
    expect(await page.evaluate(() => typeof Worker)).toBe("function");
    // Dedicated workers are fine: their requests belong to the tab and carry the container's cookies.
    await page.evaluate(() => (document.cookie = "w=A; Path=/"));
    const fromWorker = await page.evaluate(
      () =>
        new Promise<string>((resolve) => {
          const w = new Worker("/dedicated.js");
          w.onmessage = (e) => resolve(e.data);
        }),
    );
    expect(fromWorker).toContain("w=A");

    // Plain tab on a site containers use: refused as well (a real-profile worker would serve container tabs).
    const managed = await facet.plain(at("a.localhost", "/sw-page"));
    await expect(managed.locator("#sw")).toHaveText("rejected: SecurityError");

    // Plain tab on a site no container has visited: untouched.
    const free = await facet.plain(at("nosw.localhost", "/sw-page"));
    await expect(free.locator("#sw")).toHaveText("registered");
    expect(await free.evaluate(() => typeof SharedWorker)).toBe("function");

    // Once a container visits that site, the real profile's worker is removed and new registrations are refused.
    const visit = await facet.openIn(A.name, at("nosw.localhost", "/blank"));
    await expect(visit.locator("h1")).toHaveText("nosw.localhost");
    await expect
      .poll(
        () =>
          free.evaluate(
            async () =>
              (await navigator.serviceWorker.getRegistrations()).length,
          ),
        { timeout: 10_000 },
      )
      .toBe(0);
    await expect
      .poll(async () =>
        (await facet.api<string[]>("getManagedSites")).includes(
          "nosw.localhost",
        ),
      )
      .toBe(true);
    await free.reload();
    await expect(free.locator("#sw")).toHaveText("rejected: SecurityError");
  });

  test("a page reading the beacon URL itself learns its own cookies at most, never another site’s", async ({
    facet,
  }) => {
    const A = await facet.container("A");
    const set = (v: string) => `/set?c=${encodeURIComponent(`${v}; Path=/`)}`;
    const page = await facet.openIn(
      A.name,
      at("cdn.localhost", set("cdnsecret=1")),
    );
    await go(page, at("a.localhost", set("mine=1")));
    await go(page, at("a.localhost", "/login?user=alice&next=/blank"));
    await expect(page.locator("h1")).toHaveText("a.localhost");

    const leaked = await page.evaluate(async () => {
      const r = await fetch("http://ctr.localhost/whoami");
      return r.text();
    });
    const payload = JSON.parse(leaked);
    expect(payload.c).toMatch(/^[a-z2-7]{16}$/); // an opaque per-site key, never the container ID
    expect(leaked).not.toContain(A.id);
    expect(payload.n).toBe(A.name); // "Show container name to pages" is on by default
    expect(leaked).toContain("mine");
    expect(leaked).not.toContain("cdnsecret"); // other site of the same container
    expect(leaked).not.toContain("sid"); // HttpOnly

    // The page marker for agents is on the top document; the bridge element is gone before page scripts run.
    expect(
      await page.evaluate(() => document.documentElement.dataset.ctr),
    ).toBe(A.name);
    expect(
      await page.evaluate(() => document.querySelector("facet-bridge")),
    ).toBeNull();
    const plain = await facet.plain(at("a.localhost", "/blank"));
    expect(
      await plain.evaluate(() => document.documentElement.dataset.ctr ?? null),
    ).toBeNull();
  });

  test("patched APIs still look native", async ({ facet }) => {
    const A = await facet.container("A");
    const page = await facet.openIn(A.name, at("a.localhost", "/blank"));
    const out = await page.evaluate(() => {
      const getter = Object.getOwnPropertyDescriptor(
        Document.prototype,
        "cookie",
      )!.get!;
      return {
        open: window.open.toString(),
        getItem: Storage.prototype.getItem.toString(),
        getter: Function.prototype.toString.call(getter),
        toStringItself: Function.prototype.toString.toString(),
        getItemName: Storage.prototype.getItem.name,
        getItemLength: Storage.prototype.getItem.length,
        isStorage: localStorage instanceof Storage,
        tag: Object.prototype.toString.call(localStorage),
      };
    });
    expect(out.open).toContain("[native code]");
    expect(out.getItem).toContain("[native code]");
    expect(out.getter).toContain("[native code]");
    expect(out.toStringItself).toContain("[native code]");
    expect(out).toMatchObject({
      getItemName: "getItem",
      getItemLength: 1,
      isStorage: true,
      tag: "[object Storage]",
    });
  });
});
