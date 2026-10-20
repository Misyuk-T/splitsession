import { describe, expect, it } from "vitest";

import { CookieJar } from "../../core";
import { StaleNavigationDetector } from "../../engine/capture/stale-detector";
import { CookieCapture } from "./cookie-capture";
import type { WebRequestDetails } from "./types";

const TAB = 7;
const CID = "c1";
const HOST = "https://shop.example.com";

/** CookieCapture with a real jar and detector; rules, tabs and browser calls are stubs. */
function setup() {
  const jar = new CookieJar();
  const navigations: string[] = [];
  const tabs = {
    get: (tabId: number) =>
      tabId === TAB
        ? {
            containerId: CID,
            activeSince: Date.now() - 60_000,
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
  return { capture, jar, hop, values, navigations };
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
