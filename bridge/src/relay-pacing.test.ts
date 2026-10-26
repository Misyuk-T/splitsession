import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type ClientResponse,
  type HostToExtension,
  TAB_URL_TOOL,
} from "../../src/bridge/protocol";
import {
  isEnterKey,
  paceTarget,
  siteGapFromEnv,
  siteKey,
  SitePacer,
} from "./pacing";
import { Relay } from "./relay";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

describe("pacing helpers", () => {
  it("the site is the registrable domain, else the host; pages without a site have none", () => {
    expect(siteKey("https://www.reddit.com/r/x")).toBe("reddit.com");
    expect(siteKey("https://old.reddit.com/")).toBe("reddit.com");
    expect(siteKey("https://a.b.example.co.uk/")).toBe("example.co.uk");
    expect(siteKey("https://someone.github.io/")).toBe("someone.github.io");
    expect(siteKey("http://127.0.0.1:8080/x")).toBe("127.0.0.1");
    expect(siteKey("http://localhost:3000/")).toBe("localhost");
    expect(siteKey("about:blank")).toBeNull();
    expect(siteKey("chrome://settings")).toBeNull();
    expect(siteKey("not a url")).toBeNull();
  });

  it("which actions are paced, and where their site comes from", () => {
    expect(paceTarget("navigate", { tabId: 1, url: "https://a.com" })).toEqual({
      kind: "url",
      url: "https://a.com",
    });
    expect(paceTarget("open_tab", { url: "https://a.com" })).toEqual({
      kind: "url",
      url: "https://a.com",
    });
    expect(
      paceTarget("open_in_container", { url: "https://a.com", container: "w" }),
    ).toEqual({ kind: "url", url: "https://a.com" });
    for (const tool of [
      "navigate_back",
      "navigate_forward",
      "reload",
      "click",
      "select_option",
      "upload_file",
    ])
      expect(paceTarget(tool, { tabId: 4 })).toEqual({ kind: "tab", tabId: 4 });
    expect(paceTarget("press_key", { tabId: 4, key: "Enter" })).toEqual({
      kind: "tab",
      tabId: 4,
    });
    expect(paceTarget("press_key", { tabId: 4, key: "Escape" })).toBeNull();
    // read-only tools, typing and run_js never wait
    for (const tool of [
      "snapshot",
      "get_tab_text",
      "screenshot_tab",
      "list_tabs",
      "scroll",
      "type",
      "run_js",
      "hover",
      "wait_for",
      "close_tab",
    ])
      expect(paceTarget(tool, { tabId: 4, url: "https://a.com" })).toBeNull();
  });

  it("Enter in a combination counts, other keys do not", () => {
    expect(isEnterKey("Enter")).toBe(true);
    expect(isEnterKey("shift+enter")).toBe(true);
    expect(isEnterKey("NumpadEnter")).toBe(true);
    expect(isEnterKey("Tab")).toBe(false);
    expect(isEnterKey(undefined)).toBe(false);
  });

  it("the gap comes from the env: a number, 0 for off, the default otherwise", () => {
    expect(siteGapFromEnv(undefined)).toBe(1500);
    expect(siteGapFromEnv("")).toBe(1500);
    expect(siteGapFromEnv("200")).toBe(200);
    expect(siteGapFromEnv("0")).toBe(0);
    expect(siteGapFromEnv("-5")).toBe(1500);
    expect(siteGapFromEnv("soon")).toBe(1500);
  });

  it("the pacer hands out slots gap apart per site, and refuses past the cap", () => {
    let now = 1000;
    const pacer = new SitePacer(1500, 4000, () => now);
    expect(pacer.reserve("a.com")).toBe(0);
    expect(pacer.reserve("a.com")).toBe(1500);
    expect(pacer.reserve("a.com")).toBe(3000);
    expect(pacer.reserve("b.com")).toBe(0); // another site has its own queue
    expect(pacer.reserve("a.com")).toBeNull(); // 4.5 s of waiting is over the 4 s cap
    now += 10_000;
    expect(pacer.reserve("a.com")).toBe(0);
  });
});

describe("relay: per-site pacing", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function paced(options: { siteGapMs?: number; siteWaitCapMs?: number } = {}) {
    const sent: HostToExtension[] = [];
    /** What the extension says a tab shows (the `__tab_url` question). */
    const urls = new Map<number, string>();
    const relay: Relay = new Relay({
      sendToExtension: (m) => {
        sent.push(m);
        if (m.type === "request" && m.tool === TAB_URL_TOOL) {
          const tabId = (m.args as { tabId: number }).tabId;
          const url = urls.get(tabId);
          queueMicrotask(() =>
            relay.handleExtension({
              type: "response",
              id: m.id,
              ok: true,
              result: text(JSON.stringify({ url: url ?? null })),
            }),
          );
        }
      },
      timeoutMs: 60_000,
      siteGapMs: options.siteGapMs ?? 1500,
      ...(options.siteWaitCapMs
        ? { siteWaitCapMs: options.siteWaitCapMs }
        : {}),
      now: () => Date.now(),
    });
    const client = (name?: string) => {
      const got: ClientResponse[] = [];
      let n = 0;
      const call = (tool: string, args: Record<string, unknown> = {}) => {
        const id = relay.addClient((r) => got.push(r));
        relay.handleClient(id, {
          id: ++n,
          tool,
          args,
          ...(name ? { session: name } : {}),
        });
        return id;
      };
      return { got, call };
    };
    /** The tool requests that reached the extension (not the host's own questions). */
    const requests = () =>
      sent.filter(
        (m) => m.type === "request" && m.tool !== TAB_URL_TOOL,
      ) as Array<Extract<HostToExtension, { type: "request" }>>;
    return { relay, sent, urls, client, requests };
  }

  it("the first action on a site goes at once; the next waits out the gap, in order", async () => {
    const { client, requests } = paced();
    const a = client("agent-a");
    a.call("navigate", { tabId: 1, url: "https://www.reddit.com/a" });
    expect(requests()).toHaveLength(1);
    a.call("navigate", { tabId: 1, url: "https://old.reddit.com/b" });
    a.call("open_tab", { url: "https://reddit.com/c" });
    expect(requests()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1499);
    expect(requests()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(requests()).toHaveLength(2);
    expect((requests()[1]!.args as { url: string }).url).toBe(
      "https://old.reddit.com/b",
    );
    await vi.advanceTimersByTimeAsync(1500);
    expect(requests()).toHaveLength(3);
    expect((requests()[2]!.args as { url: string }).url).toBe(
      "https://reddit.com/c",
    );
  });

  it("other sites do not wait for each other", () => {
    const { client, requests } = paced();
    const a = client("agent-a");
    a.call("navigate", { tabId: 1, url: "https://a.com/" });
    a.call("navigate", { tabId: 2, url: "https://b.com/" });
    a.call("open_tab", { url: "https://c.org/" });
    expect(requests()).toHaveLength(3);
  });

  it("the queue is shared by every session of the profile", async () => {
    const { client, requests } = paced();
    const a = client("agent-a");
    const b = client("agent-b");
    a.call("navigate", { tabId: 1, url: "https://reddit.com/a" });
    b.call("navigate", { tabId: 2, url: "https://reddit.com/b" });
    expect(requests()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1500);
    expect(requests()).toHaveLength(2);
    expect(requests()[1]!.session).toBe("agent-b");
  });

  it("read-only tools, typing and run_js never wait, even while the site is busy", () => {
    const { client, requests } = paced();
    const a = client("agent-a");
    a.call("navigate", { tabId: 1, url: "https://reddit.com/a" });
    a.call("navigate", { tabId: 1, url: "https://reddit.com/b" }); // waits
    for (const tool of ["snapshot", "get_tab_text", "type", "run_js", "scroll"])
      a.call(tool, { tabId: 1 });
    expect(requests().map((r) => r.tool)).toEqual([
      "navigate",
      "snapshot",
      "get_tab_text",
      "type",
      "run_js",
      "scroll",
    ]);
  });

  it("a click is paced by the site its tab shows now, asked of the extension", async () => {
    const { client, requests, urls, sent } = paced();
    urls.set(5, "https://www.reddit.com/r/x");
    urls.set(6, "https://example.com/");
    const a = client("agent-a");
    a.call("navigate", { tabId: 1, url: "https://reddit.com/a" });
    a.call("click", { tabId: 5, ref: "e1" });
    await vi.advanceTimersByTimeAsync(0);
    expect(requests().map((r) => r.tool)).toEqual(["navigate"]); // the click waits
    expect(
      sent.some((m) => m.type === "request" && m.tool === TAB_URL_TOOL),
    ).toBe(true);
    a.call("click", { tabId: 6, ref: "e1" }); // another site
    await vi.advanceTimersByTimeAsync(0);
    expect(requests().map((r) => r.tool)).toEqual(["navigate", "click"]);
    await vi.advanceTimersByTimeAsync(1500);
    expect(requests().map((r) => r.tool)).toEqual([
      "navigate",
      "click",
      "click",
    ]);
  });

  it("an extension that cannot say which address a tab shows is not paced", async () => {
    const { client, requests, relay, sent } = paced();
    const a = client("agent-a");
    // an older extension answers "pong" to every `__` question
    const asked = sent.length;
    a.call("click", { tabId: 5 });
    const q = sent.at(asked) as { id: number };
    relay.handleExtension({
      type: "response",
      id: q.id,
      ok: true,
      result: text("pong"),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(requests()).toHaveLength(1);
  });

  it("Enter is paced, other keys are not", async () => {
    const { client, requests, urls } = paced();
    urls.set(5, "https://reddit.com/");
    const a = client("agent-a");
    a.call("navigate", { tabId: 5, url: "https://reddit.com/" });
    a.call("press_key", { tabId: 5, key: "Escape" });
    a.call("press_key", { tabId: 5, key: "Enter" });
    await vi.advanceTimersByTimeAsync(0);
    expect(requests().map((r) => r.tool)).toEqual(["navigate", "press_key"]);
    await vi.advanceTimersByTimeAsync(1500);
    expect(requests().map((r) => r.tool)).toEqual([
      "navigate",
      "press_key",
      "press_key",
    ]);
  });

  it("past the cap the action is answered 'site busy' instead of queued", async () => {
    const { client, requests } = paced({
      siteGapMs: 1500,
      siteWaitCapMs: 3000,
    });
    const a = client("agent-a");
    for (let i = 0; i < 3; i++)
      a.call("navigate", { tabId: 1, url: `https://reddit.com/${i}` });
    const late = client("agent-b");
    late.call("navigate", { tabId: 2, url: "https://reddit.com/late" }); // would wait 4.5 s
    expect(late.got).toHaveLength(1);
    expect(late.got[0]).toMatchObject({ ok: false });
    expect((late.got[0] as { error: string }).error).toMatch(
      /^site busy: reddit\.com/,
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(requests()).toHaveLength(3);
    // the queue drained: the site is free again
    late.call("navigate", { tabId: 2, url: "https://reddit.com/later" });
    expect(requests()).toHaveLength(4);
  });

  it("the default cap is 30 s", async () => {
    const { client, requests } = paced();
    const a = client("agent-a");
    for (let i = 0; i < 21; i++)
      a.call("navigate", { tabId: 1, url: `https://reddit.com/${i}` }); // 20 waits of 1.5 s = 30 s
    const over = client("agent-b");
    over.call("navigate", { tabId: 2, url: "https://reddit.com/over" }); // 31.5 s
    expect((over.got[0] as { error: string }).error).toMatch(/site busy/);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(requests()).toHaveLength(21);
  });

  it("a client that leaves while waiting does not get its action done", async () => {
    const { client, requests, relay } = paced();
    const a = client("agent-a");
    a.call("navigate", { tabId: 1, url: "https://reddit.com/a" });
    const id = a.call("navigate", { tabId: 1, url: "https://reddit.com/b" });
    relay.removeClient(id);
    await vi.advanceTimersByTimeAsync(5000);
    expect(requests()).toHaveLength(1);
  });

  it("when the extension goes away, waiting actions are answered with the reason", async () => {
    const { client, relay } = paced();
    const a = client("agent-a");
    a.call("navigate", { tabId: 1, url: "https://reddit.com/a" });
    const b = client("agent-a");
    b.call("navigate", { tabId: 1, url: "https://reddit.com/b" });
    relay.extensionGone("bridge switched off");
    expect(b.got[0]).toMatchObject({ ok: false, error: "bridge switched off" });
  });

  it("gap 0 (or none) means no pacing at all", () => {
    const off = paced({ siteGapMs: 0 });
    const a = off.client("agent-a");
    a.call("navigate", { tabId: 1, url: "https://reddit.com/a" });
    a.call("navigate", { tabId: 1, url: "https://reddit.com/b" });
    expect(off.requests()).toHaveLength(2);
  });

  it("pages without a site (about:blank) are not paced", () => {
    const { client, requests } = paced();
    const a = client("agent-a");
    a.call("open_tab", { url: "about:blank" });
    a.call("open_tab", { url: "about:blank" });
    expect(requests()).toHaveLength(2);
  });
});

describe("relay: session name for the extension", () => {
  it("is sent cleaned of everything but letters, digits, space and - _ .", () => {
    const sent: HostToExtension[] = [];
    const relay = new Relay({ sendToExtension: (m) => sent.push(m) });
    const id = relay.addClient(() => {});
    relay.handleClient(id, {
      id: 1,
      tool: "snapshot",
      args: { tabId: 1 },
      session: "<img src=x onerror=alert(1)>-ab12",
    });
    expect(sent.at(-1)).toMatchObject({
      session: "img srcx onerroralert1-ab12",
    });
  });

  it("is absent without a session", () => {
    const sent: HostToExtension[] = [];
    const relay = new Relay({ sendToExtension: (m) => sent.push(m) });
    const id = relay.addClient(() => {});
    relay.handleClient(id, { id: 1, tool: "snapshot", args: { tabId: 1 } });
    expect(sent.at(-1)).not.toHaveProperty("session");
  });
});
