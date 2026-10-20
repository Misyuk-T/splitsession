import { at, expect, go, pageJson, pageText, test } from "./fixtures";

interface JarCookie {
  name: string;
  value: string;
  domain: string;
  httpOnly: boolean;
}

test.describe("network cookies", () => {
  test("302 login with an HttpOnly cookie: two containers, a plain tab and the real profile stay apart", async ({
    facet,
  }) => {
    const A = await facet.container("A");
    const B = await facet.container("B");
    const pa = await facet.openIn(
      A.name,
      at("a.localhost", "/login?user=alice"),
    );
    const pb = await facet.openIn(B.name, at("a.localhost", "/login?user=bob"));
    await expect(pa.locator("#user")).toHaveText("alice");
    await expect(pb.locator("#user")).toHaveText("bob");
    expect((await pageJson(pa, "/me")).user).toBe("alice");
    expect((await pageJson(pb, "/me")).user).toBe("bob");

    // A reload is a fresh main_frame request: it carries the container session too.
    await pa.reload();
    await expect(pa.locator("#user")).toHaveText("alice");

    const plain = await facet.plain(at("a.localhost", "/whoami"));
    await expect(plain.locator("#user")).toHaveText("anonymous");
    expect((await pageJson(plain, "/me")).user).toBeNull();
    expect(await facet.realCookies(at("a.localhost"))).toEqual([]);

    // HttpOnly: in the jar, never in document.cookie.
    expect(await pa.evaluate(() => document.cookie)).not.toContain("sid=");
    const jar = await facet.api<JarCookie[]>("getJar", A.id);
    expect(jar.find((c) => c.name === "sid")).toMatchObject({
      httpOnly: true,
      domain: "a.localhost",
    });

    // The real profile logs in on its own; containers do not notice, and a container login does not log it out.
    await go(plain, at("a.localhost", "/login?user=real"));
    await expect(plain.locator("#user")).toHaveText("real");
    await go(pa, at("a.localhost", "/login?user=alice2"));
    await expect(pa.locator("#user")).toHaveText("alice2");
    await plain.reload();
    await expect(plain.locator("#user")).toHaveText("real");
    expect((await pageJson(pb, "/me")).user).toBe("bob");
    expect(
      (await facet.realCookies(at("a.localhost"))).map((c) => c.name),
    ).toEqual(["sid"]);
  });

  test("fetch and XHR logins, then an immediate fetch, each in its own container", async ({
    facet,
  }) => {
    const A = await facet.container("A");
    const B = await facet.container("B");
    const pa = await facet.openIn(A.name, at("b.localhost", "/blank"));
    const pb = await facet.openIn(B.name, at("b.localhost", "/blank"));

    const meA = await pa.evaluate(async () => {
      await fetch("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user: "carol" }),
      });
      return (await fetch("/me")).json();
    });
    expect(meA.user).toBe("carol");

    const meB = await pb.evaluate(
      () =>
        new Promise<{ user: string | null }>((resolve) => {
          const xhr = new XMLHttpRequest();
          xhr.open("POST", "/api/login");
          xhr.setRequestHeader("content-type", "application/json");
          xhr.onload = async () => resolve(await (await fetch("/me")).json());
          xhr.send(JSON.stringify({ user: "dave" }));
        }),
    );
    expect(meB.user).toBe("dave");
    expect((await pageJson(pa, "/me")).user).toBe("carol");

    const plain = await facet.plain(at("b.localhost", "/blank"));
    expect((await pageJson(plain, "/me")).user).toBeNull();
    expect(await facet.realCookies(at("b.localhost"))).toEqual([]);
  });

  test("host-only cookies stay on their host, Domain cookies reach subdomains", async ({
    facet,
  }) => {
    const A = await facet.container("A");
    const set = `/set?c=${encodeURIComponent("hostonly=1; Path=/")}&c=${encodeURIComponent("wide=1; Domain=a.localhost; Path=/")}`;
    const page = await facet.openIn(A.name, at("a.localhost", set));
    await expect(page.locator("#set")).toContainText("hostonly=1");

    const onHost = await pageText(page, "/echo");
    expect(onHost).toContain("hostonly=1");
    expect(onHost).toContain("wide=1");

    await go(page, at("sub.a.localhost", "/echo"));
    const onSub = await page.locator("body").textContent();
    expect(onSub).toContain("wide=1");
    expect(onSub).not.toContain("hostonly");

    await go(page, at("sub.a.localhost", "/blank"));
    expect(await page.evaluate(() => document.cookie)).toBe("wide=1");
    await go(page, at("a.localhost", "/blank"));
    expect(
      (await page.evaluate(() => document.cookie)).split("; ").sort(),
    ).toEqual(["hostonly=1", "wide=1"]);

    // The other direction: another container and the real profile have neither cookie, on either host.
    const B = await facet.container("B");
    const pb = await facet.openIn(B.name, at("sub.a.localhost", "/echo"));
    expect(await pb.locator("body").textContent()).toBe("");
    await go(pb, at("a.localhost", "/echo"));
    expect(await pb.locator("body").textContent()).toBe("");
    const plain = await facet.plain(at("sub.a.localhost", "/echo"));
    expect(await plain.locator("body").textContent()).toBe("");
    expect(await facet.realCookies(at("a.localhost"))).toEqual([]);
    expect(await facet.realCookies(at("sub.a.localhost"))).toEqual([]);
  });

  test("a cross-site iframe gets the container’s SameSite=None cookies of its own host, not its Lax ones", async ({
    facet,
  }) => {
    const A = await facet.container("A");
    const B = await facet.container("B");
    const setFor = (v: string) =>
      at(
        "cdn.localhost",
        `/set?c=${encodeURIComponent(`cdnid=${v}; Path=/; SameSite=None; Secure`)}&c=${encodeURIComponent(`cdnlax=${v}; Path=/`)}`,
      );
    const pa = await facet.openIn(A.name, setFor("A"));
    const pb = await facet.openIn(B.name, setFor("B"));
    await go(pa, at("a.localhost", "/frame-host"));
    await go(pb, at("a.localhost", "/frame-host"));
    await expect(pa.frameLocator("#f").locator("#cookies")).toHaveText(
      "cdnid=A",
    );
    await expect(pa.frameLocator("#f").locator("#doc")).toHaveText("cdnid=A");
    await expect(pb.frameLocator("#f").locator("#cookies")).toHaveText(
      "cdnid=B",
    );
    await expect(pb.frameLocator("#f").locator("#doc")).toHaveText("cdnid=B");

    const plain = await facet.plain(at("a.localhost", "/frame-host"));
    await expect(plain.frameLocator("#f").locator("#cookies")).toHaveText("");
    await expect(plain.frameLocator("#f").locator("#doc")).toHaveText("");
    expect(await facet.realCookies(at("cdn.localhost"))).toEqual([]);
  });

  test("cross-domain OAuth through 302s keeps each container identity on both domains", async ({
    facet,
  }) => {
    const A = await facet.container("A");
    const B = await facet.container("B");
    const pa = await facet.openIn(
      A.name,
      at("sso.localhost", "/sso/login?user=sso-alice"),
    );
    const pb = await facet.openIn(
      B.name,
      at("sso.localhost", "/sso/login?user=sso-bob"),
    );
    await expect(pa.locator("#user")).toHaveText("sso-alice");
    await expect(pb.locator("#user")).toHaveText("sso-bob");

    await go(pa, at("a.localhost", "/oauth/start"));
    await go(pb, at("a.localhost", "/oauth/start"));
    await expect(pa.locator("#user")).toHaveText("sso-alice");
    await expect(pb.locator("#user")).toHaveText("sso-bob");

    const plain = await facet.plain(at("a.localhost", "/oauth/start"));
    await expect(plain.locator("#user")).toHaveText("anonymous"); // sso: not logged in in the real profile
    expect(await facet.realCookies(at("sso.localhost"))).toEqual([]);
    expect(
      (await facet.realCookies(at("a.localhost"))).filter(
        (c) => c.name === "sid",
      ),
    ).toEqual([]);
  });
  // Drupal 10 (bug report on a Drupal Commerce site): the login form POSTs, the answer redirects at once with the new
  // session cookie, and Chrome follows before the rules carry it. The stale hop is answered with a fresh anonymous
  // session; importing that replaced the login in the jar ("your browser must accept cookies"; the second try worked).
  for (const { status, anonymousFirst } of [
    { status: 303, anonymousFirst: false },
    { status: 303, anonymousFirst: true },
    { status: 302, anonymousFirst: false },
  ]) {
    test(`a Drupal-style form login (POST, ${status}${anonymousFirst ? ", over an anonymous session" : ""}) succeeds on the first try`, async ({
      facet,
    }) => {
      const A = await facet.container("A");
      const login = `/drupal/user/login?status=${status}&user=alice`;
      const page = await facet.openIn(
        A.name,
        at("a.localhost", anonymousFirst ? "/drupal/user/1" : login),
      );
      if (anonymousFirst) {
        // Like a Commerce cart: the container already holds an anonymous session the login migrates.
        await expect(page.locator("#login")).toBeVisible();
        await go(page, at("a.localhost", login));
      }
      // A person logs in seconds after the tab got its container. Within the first second the assignment check
      // (Set-Cookie of a request whose header is not from the jar is ignored) would hide the bug.
      await page.waitForTimeout(1_200);
      await page.click("#submit");
      await expect(page.locator("#user")).toHaveText("alice", {
        timeout: 10_000,
      });
      await expect(page.locator("#error")).toHaveCount(0);
      await page.reload();
      await expect(page.locator("#user")).toHaveText("alice");
      const jar = await facet.api<JarCookie[]>("getJar", A.id);
      expect(jar.filter((c) => c.name === "SESSdrupal")).toHaveLength(1);
      expect(await facet.realCookies(at("a.localhost"))).toEqual([]);
    });
  }
});
