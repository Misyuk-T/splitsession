import { describe, expect, it } from "vitest";

import { CookieJar } from "../../core";
import { StaleNavigationDetector } from "../../engine/capture/stale-detector";
import { CookieCapture } from "./cookie-capture";
import type { WebRequestDetails } from "./types";
import { senderTopLevelSite } from "./urls";

const TAB = 7;
const CID = "c1";
const HOST = "https://shop.example.com";

/** CookieCapture with a real jar and detector; rules, tabs and browser calls are stubs. */
function setup({ activeAgoMs = 60_000 } = {}) {
  const jar = new CookieJar();
  const navigations: string[] = [];
  const tabs = {
    get: (tabId: number) =>
      tabId === TAB
        ? {
            containerId: CID,
            activeSince: Date.now() - activeAgoMs,
            topLevelSite: "https://example.com",
          }
        : undefined,
    tabsOf: () => [TAB],
  };
  const detector = new StaleNavigationDetector({
    containerOf: (tabId) => (tabId === TAB ? CID : undefined),
  });
  const capture = new CookieCapture({
    b: {
      tabs: {
        update: async (_id: number, { url }: { url: string }) => {
          navigations.push(url);
        },
        sendMessage: async () => {},
      },
    },
    ready: async () => {},
    tabs,
    containers: { jar: () => jar, touchJar: () => {} },
    log: () => {},
    prepareNavigation: async () => {},
    rules: { invalidate: async () => {}, sync: async () => {} },
    detector,
  } as never);
  let seq = 0;
  /** One main-frame hop: the send (with the Cookie header it carried), then its response. */
  const hop = async (
    path: string,
    sentCookie: string | null,
    setCookies: string[],
    { method = "GET", status = 200, requestId = `r${++seq}` } = {},
  ) => {
    const base: WebRequestDetails = {
      requestId,
      url: `${HOST}${path}`,
      method,
      tabId: TAB,
      type: "main_frame",
      frameId: 0,
      timeStamp: Date.now(),
    };
    capture.noteSend({
      ...base,
      requestHeaders: sentCookie ? [{ name: "Cookie", value: sentCookie }] : [],
    });
    capture.noteResponse({
      ...base,
      timeStamp: Date.now(),
      statusCode: status,
      responseHeaders: setCookies.map((value) => ({
        name: "Set-Cookie",
        value,
      })),
    });
    await new Promise((r) => setTimeout(r, 0));
  };
  const values = (name: string) =>
    jar
      .all()
      .filter((c) => c.name === name)
      .map((c) => `${c.hostOnly ? "host" : "domain"}:${c.value}`);
  return {
    capture,
    jar,
    hop,
    values,
    navigations,
    base: (path: string, requestId: string) =>
      ({
        requestId,
        url: `${HOST}${path}`,
        method: "GET",
        tabId: TAB,
        type: "main_frame",
        frameId: 0,
        timeStamp: Date.now(),
      }) as WebRequestDetails,
  };
}

describe("CookieCapture: a stale hop's answer and the cookie it missed", () => {
  it("Drupal: the hop after the login redirect went out without the session; its anonymous session is not imported", async () => {
    const { hop, values } = setup();
    const cookie = "path=/; domain=.shop.example.com; secure; HttpOnly";
    await hop("/user/login", null, [`SSESS=login; ${cookie}`], {
      method: "POST",
      status: 303,
      requestId: "login",
    });
    await hop("/user/1?check_logged_in=1", null, [`SSESS=anon; ${cookie}`], {
      status: 302,
      requestId: "login",
    });
    expect(values("SSESS")).toEqual(["domain:login"]);
  });

  it("a rotation answered to a request carrying the current value is imported (A -> B, then B -> C)", async () => {
    const { hop, values } = setup();
    await hop("/a", null, ["sid=A; Path=/"]);
    await hop("/b", "sid=A", ["sid=B; Path=/"]);
    await hop("/c", "sid=B", ["sid=C; Path=/"]);
    expect(values("sid")).toEqual(["host:C"]);
  });

  it("a logout answered to a request carrying the current value deletes the cookie", async () => {
    const { hop, values } = setup();
    await hop("/a", null, ["sid=A; Path=/"]);
    await hop("/b", "sid=A", ["sid=B; Path=/"]);
    await hop("/logout", "sid=B", ["sid=; Max-Age=0; Path=/"]);
    expect(values("sid")).toEqual([]);
  });

  it("a host-only cookie deleted beside a Domain cookie of the same name: a request carrying only the Domain one is fresh", async () => {
    const { hop, values } = setup();
    await hop("/a", null, [
      "sid=d1; Path=/; Domain=shop.example.com",
      "sid=h1; Path=/",
    ]);
    await hop("/b", "sid=d1; sid=h1", ["sid=; Max-Age=0; Path=/"]);
    expect(values("sid")).toEqual(["domain:d1"]);
    await hop("/c", "sid=d1", ["sid=h2; Path=/"]);
    expect(values("sid").sort()).toEqual(["domain:d1", "host:h2"]);
  });
});

describe("CookieCapture: right after the tab's assignment", () => {
  const MS = "esctx=1; Path=/";

  it("a Set-Cookie is imported when the jar rotated the sent values while the response was on its way", async () => {
    const { capture, jar, base, values } = setup({ activeAgoMs: 200 });
    await jar.setFromHeader("buid=A; Path=/", {
      url: `${HOST}/`,
      now: Date.now(),
    });
    const details = base("/a", "ms1");
    capture.noteSend({
      ...details,
      requestHeaders: [{ name: "Cookie", value: "buid=A" }],
    });
    await new Promise((r) => setTimeout(r, 0));
    // Another response of the same page rotates buid before this one arrives.
    jar.setFromHeader("buid=B; Path=/", { url: `${HOST}/`, now: Date.now() });
    capture.noteResponse({
      ...details,
      timeStamp: Date.now(),
      statusCode: 200,
      responseHeaders: [{ name: "Set-Cookie", value: MS }],
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(values("esctx")).toEqual(["host:1"]);
  });

  it("a request that carried a pair the container never had is still ignored", async () => {
    const { capture, base, values } = setup({ activeAgoMs: 200 });
    const details = base("/a", "ms2");
    capture.noteSend({
      ...details,
      requestHeaders: [{ name: "Cookie", value: "profile=secret" }],
    });
    await new Promise((r) => setTimeout(r, 0));
    capture.noteResponse({
      ...details,
      timeStamp: Date.now(),
      statusCode: 200,
      responseHeaders: [{ name: "Set-Cookie", value: MS }],
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(values("esctx")).toEqual([]);
  });
});

describe("CookieCapture: top-level site of a content script's message right after a cross-site navigation", () => {
  // The tab record still says example.com (onCommitted has not moved it); the page is on shop.example.org.
  const origin = "https://shop.example.org";
  const top = { frameId: 0, origin } as never;
  const frame = { frameId: 3, origin } as never;
  const partitioned = "pk=1; Path=/; Secure; Partitioned";

  it("a top frame's write and snapshot use its own site; a frame's use the tab record", async () => {
    const { capture, jar } = setup();
    const a = await capture.cookieWrite(TAB, top, partitioned, "/", Date.now());
    expect(jar.all().map((c) => c.partitionKey)).toEqual([
      "https://example.org",
    ]);
    expect(a.ok && a.cookies?.map((c) => c.name)).toEqual(["pk"]);

    const b = await capture.cookieWrite(
      TAB,
      frame,
      "fk=1; Path=/; Secure; Partitioned",
      "/",
      Date.now(),
    );
    expect(b.ok).toBe(true);
    expect(jar.all().find((c) => c.name === "fk")?.partitionKey).toBe(
      "https://example.com",
    );
    // The snapshot of the frame sees the partitioned cookie of the tab's recorded site only.
    expect(
      capture
        .siteSnapshot(CID, "shop.example.org", "https://example.com")
        .map((c) => c.name),
    ).toEqual(["fk"]);
  });

  it("senderTopLevelSite: top frame -> own site (full PSL), frame or unknown origin -> the recorded one", () => {
    const rec = "https://example.com";
    expect(senderTopLevelSite({ frameId: 0, origin } as never, rec)).toBe(
      "https://example.org",
    );
    expect(senderTopLevelSite({ frameId: 3, origin } as never, rec)).toBe(rec);
    expect(senderTopLevelSite({ frameId: 0 } as never, rec)).toBe(rec);
  });
});
