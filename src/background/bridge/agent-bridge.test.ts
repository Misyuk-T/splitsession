import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryStorageArea } from "../../engine/storage/storage-area";
import { createLogger } from "../log";
import {
  AgentBridge,
  BRIDGE_ALARM,
  BRIDGE_STATE_KEY,
  type ProfileIdentity,
  RELEASE_GRACE_MS,
} from "./agent-bridge";

class FakePort {
  sent: any[] = [];
  disconnected = false;
  private messageListeners: Array<(m: unknown) => void> = [];
  private disconnectListeners: Array<() => void> = [];
  onMessage = {
    addListener: (l: (m: unknown) => void) =>
      void this.messageListeners.push(l),
  };

  onDisconnect = {
    addListener: (l: () => void) => void this.disconnectListeners.push(l),
  };

  /** The `hello` the extension opens every connection with (kept apart from the answers). */
  hello: any = null;

  postMessage(m: unknown) {
    if ((m as { type?: string }).type === "hello") this.hello = m;
    else this.sent.push(m);
  }

  disconnect() {
    this.disconnected = true;
  }

  // test side
  receive(m: unknown) {
    for (const l of this.messageListeners) l(m);
  }

  die() {
    for (const l of this.disconnectListeners) l();
  }
}

function setup(identity?: ProfileIdentity) {
  const ports: FakePort[] = [];
  const state = { lastError: undefined as { message: string } | undefined };
  const alarms = { create: vi.fn(), clear: vi.fn(async () => true) };
  const b = {
    runtime: {
      connectNative: vi.fn(() => {
        const p = new FakePort();
        ports.push(p);
        return p;
      }),
      get lastError() {
        return state.lastError;
      },
    },
    alarms,
    tabs: {
      get: vi.fn(async (id: number) => {
        if (id !== 3) throw new Error("No tab with id");
        return { id, windowId: 1, url: "https://www.reddit.com/r/x" };
      }),
      query: vi.fn(async () => [
        { id: 3, windowId: 1, title: "secret", url: "https://a.test/" },
        { windowId: 1 },
      ]),
    },
  };
  const area = new MemoryStorageArea();
  const log = createLogger(50);
  vi.spyOn(console, "debug").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const bridge = new AgentBridge(b as never, area, log, identity);
  const run = vi.fn(
    async (
      tool: string,
      _args: unknown,
      meta: {
        tabId?: number;
        host?: string;
        session?: string;
        signal?: AbortSignal;
      },
    ) => {
      meta.tabId = 5;
      meta.host = "a.test";
      if (tool === "boom") throw new Error("tool failed");
      return { content: [{ type: "text" as const, text: "ok" }] };
    },
  );
  bridge.setRunner({ run });
  return { bridge, b, ports, state, alarms, area, log, run };
}

describe("AgentBridge", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("stays off, and connects to nothing, until switched on", async () => {
    const { bridge, b } = setup();
    await bridge.sync(false);
    expect(b.runtime.connectNative).not.toHaveBeenCalled();
    expect(bridge.state().status).toBe("off");
  });

  it("connects to com.splitsession.bridge and is connected when the host says ready", async () => {
    const { bridge, b, ports, alarms } = setup();
    await bridge.sync(true, true);
    expect(b.runtime.connectNative).toHaveBeenCalledWith(
      "com.splitsession.bridge",
    );
    expect(bridge.state().status).toBe("connecting");
    expect(alarms.create).toHaveBeenCalledWith(BRIDGE_ALARM, {
      periodInMinutes: 1,
    });
    ports[0]!.receive({ type: "ready", version: 1, socket: "/s" });
    expect(bridge.state().status).toBe("connected");
  });

  it("hands the host's session name (cleaned) to the tool and records it in the action log", async () => {
    const { bridge, ports, run, log } = setup();
    await bridge.sync(true, true);
    const port = ports[0]!;
    port.receive({ type: "ready", version: 2, socket: "/s" });
    port.receive({
      type: "request",
      id: 1,
      tool: "get_tab_text",
      args: { tabId: 5 },
      session: "claude-code-a1b2",
    });
    port.receive({
      type: "request",
      id: 2,
      tool: "get_tab_text",
      args: { tabId: 5 },
      session: "<img src=x onerror=alert(1)>",
    });
    port.receive({ type: "request", id: 3, tool: "get_tab_text", args: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(run.mock.calls.map((c) => c[2].session)).toEqual([
      "claude-code-a1b2",
      "img srcx onerroralert1",
      undefined,
    ]);
    const logged = log
      .entries()
      .filter((e) => e.message === "agent action")
      .map((e) => (e.data as { session?: string }).session);
    expect(logged).toEqual([
      "claude-code-a1b2",
      "img srcx onerroralert1",
      undefined,
    ]);
  });

  it("answers the host's __tab_url (per-site pacing) with the address only, never counted", async () => {
    const { bridge, ports, run } = setup();
    await bridge.sync(true, true);
    const port = ports[0]!;
    port.receive({ type: "ready", version: 2, socket: "/s" });
    port.receive({
      type: "request",
      id: 1,
      tool: "__tab_url",
      args: { tabId: 3 },
    });
    port.receive({
      type: "request",
      id: 2,
      tool: "__tab_url",
      args: { tabId: 9 },
    });
    port.receive({ type: "request", id: 3, tool: "__tab_url", args: {} });
    await vi.advanceTimersByTimeAsync(0);
    const text = (id: number) =>
      port.sent.find((m) => m.id === id)?.result.content[0].text;
    expect(JSON.parse(text(1))).toEqual({ url: "https://www.reddit.com/r/x" });
    expect(JSON.parse(text(2))).toEqual({ url: null });
    expect(text(3)).toBe("pong");
    expect(run).not.toHaveBeenCalled();
    expect(bridge.state()).toMatchObject({ actions: 0, recent: [] });
  });

  it("answers requests through the router, counts and logs them without page content", async () => {
    const { bridge, ports, run, log } = setup();
    await bridge.sync(true, true);
    const port = ports[0]!;
    port.receive({ type: "ready", version: 1, socket: "/s" });
    port.receive({
      type: "request",
      id: 7,
      tool: "get_tab_text",
      args: { tabId: 5 },
    });
    port.receive({
      type: "request",
      id: 8,
      tool: "boom",
      args: { text: "secret" },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);
    expect(port.sent).toEqual([
      {
        type: "response",
        id: 7,
        ok: true,
        result: { content: [{ type: "text", text: "ok" }] },
      },
      { type: "response", id: 8, ok: false, error: "tool failed" },
    ]);
    expect(bridge.state()).toMatchObject({ actions: 2, lastTool: "boom" });
    const entries = log.entries().filter((e) => e.message === "agent action");
    expect(entries.map((e) => e.data)).toEqual([
      {
        tool: "get_tab_text",
        tabId: 5,
        host: "a.test",
        ok: true,
        ms: expect.any(Number),
      },
      {
        tool: "boom",
        tabId: 5,
        host: "a.test",
        ok: false,
        ms: expect.any(Number),
        error: "tool failed",
      },
    ]);
    expect(JSON.stringify(entries)).not.toContain("secret");
  });

  it("keeps the latest five actions, newest first, with the tab they touched", async () => {
    const { bridge, ports, run } = setup();
    await bridge.sync(true, true);
    const port = ports[0]!;
    port.receive({ type: "ready", version: 1, socket: "/s" });
    run.mockImplementation(
      async (
        tool: string,
        _a: unknown,
        meta: { tabId?: number; host?: string; title?: string },
      ) => {
        if (tool === "get_tab_text")
          Object.assign(meta, { tabId: 5, host: "a.test", title: "Inbox" });
        if (tool === "boom") throw new Error("tool failed");
        return { content: [{ type: "text" as const, text: "ok" }] };
      },
    );
    for (const [id, tool] of [
      ["1", "list_tabs"],
      ["2", "get_tab_text"],
      ["3", "boom"],
      ["4", "list_containers"],
      ["5", "list_tabs"],
      ["6", "list_tabs"],
    ] as const) {
      port.receive({ type: "request", id: Number(id), tool, args: {} });
      await vi.advanceTimersByTimeAsync(0);
    }
    const recent = bridge.state().recent;
    expect(recent.map((r) => r.tool)).toEqual([
      "list_tabs",
      "list_tabs",
      "list_containers",
      "boom",
      "get_tab_text",
    ]); // the first list_tabs fell off
    expect(recent[4]).toMatchObject({
      ok: true,
      title: "Inbox",
      host: "a.test",
    });
    expect(recent[3]).toMatchObject({ ok: false, title: null });
    expect(bridge.state().actions).toBe(6);
    // A fresh "on" starts the list again.
    await bridge.sync(false);
    await bridge.sync(true, true);
    expect(bridge.state().recent).toEqual([]);
  });

  it("never runs, counts or lists the host's internal keepalive and session calls", async () => {
    const { bridge, ports, run, log } = setup();
    await bridge.sync(true, true);
    const port = ports[0]!;
    port.receive({ type: "ready", version: 1, socket: "/s" });
    port.receive({ type: "request", id: 1, tool: "__session", args: {} });
    port.receive({ type: "request", id: 2, tool: "__ping" });
    port.receive({ type: "request", id: 3, tool: "list_tabs", args: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    expect(bridge.state().actions).toBe(1);
    expect(bridge.state().recent.map((r) => r.tool)).toEqual(["list_tabs"]);
    expect(port.sent.map((m) => m.id)).toEqual([1, 2, 3]); // the host still gets answers
    expect(
      log.entries().filter((e) => e.message === "agent action"),
    ).toHaveLength(1);
  });

  it('turning it off disconnects the port and clears the retry alarm; the counter restarts on the next "on"', async () => {
    const { bridge, ports, alarms } = setup();
    await bridge.sync(true, true);
    ports[0]!.receive({ type: "ready", version: 1, socket: "/s" });
    ports[0]!.receive({ type: "request", id: 1, tool: "list_tabs", args: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.state().actions).toBe(1);
    await bridge.sync(false);
    expect(ports[0]!.disconnected).toBe(true);
    expect(alarms.clear).toHaveBeenCalledWith(BRIDGE_ALARM);
    expect(bridge.state()).toMatchObject({ status: "off", actions: 1 });
    await bridge.sync(true, true);
    expect(bridge.state().actions).toBe(0);
  });

  it("a late answer after switching off is dropped, not sent to a new connection", async () => {
    const { bridge, ports, run } = setup();
    let release!: () => void;
    run.mockImplementationOnce(
      () => new Promise((r) => (release = () => r({ content: [] }))),
    );
    await bridge.sync(true, true);
    ports[0]!.receive({ type: "ready", version: 1, socket: "/s" });
    ports[0]!.receive({ type: "request", id: 1, tool: "list_tabs", args: {} });
    await bridge.sync(false);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(ports[0]!.sent).toEqual([]);
  });

  it("hands every tool a signal that is aborted when the switch goes off, and runs nothing once it is off", async () => {
    const { bridge, ports, run } = setup();
    let signal: AbortSignal | undefined;
    run.mockImplementationOnce(
      async (_t, _a, meta: { signal?: AbortSignal }) => {
        signal = meta.signal;
        return new Promise(() => {});
      },
    );
    await bridge.sync(true, true);
    ports[0]!.receive({ type: "ready", version: 1, socket: "/s" });
    ports[0]!.receive({ type: "request", id: 1, tool: "click", args: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(signal?.aborted).toBe(false);
    await bridge.sync(false);
    expect(signal?.aborted).toBe(true);
    // A request that arrives from the old port after "off" does not reach the router at all.
    run.mockClear();
    ports[0]!.receive({ type: "request", id: 2, tool: "click", args: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(run).not.toHaveBeenCalled();
    // Switching on again gives the next connection a fresh, live signal.
    await bridge.sync(true, true);
    ports[1]!.receive({ type: "ready", version: 1, socket: "/s" });
    run.mockImplementationOnce(
      async (_t, _a, meta: { signal?: AbortSignal }) => {
        signal = meta.signal;
        return { content: [] };
      },
    );
    ports[1]!.receive({ type: "request", id: 3, tool: "click", args: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(signal?.aborted).toBe(false);
  });

  it("aborts running tools when the connection drops, not only when the switch goes off", async () => {
    const { bridge, ports, run, state } = setup();
    let signal: AbortSignal | undefined;
    run.mockImplementationOnce(
      async (_t, _a, meta: { signal?: AbortSignal }) => {
        signal = meta.signal;
        return new Promise(() => {});
      },
    );
    await bridge.sync(true, true);
    ports[0]!.receive({ type: "ready", version: 1, socket: "/s" });
    ports[0]!.receive({ type: "request", id: 1, tool: "click", args: {} });
    await vi.advanceTimersByTimeAsync(0);
    state.lastError = { message: "Native host has exited." };
    ports[0]!.die();
    expect(signal?.aborted).toBe(true);
  });

  it('says "busy" when another Chrome profile holds the bridge, stays busy while it looks again, and connects when the other lets go', async () => {
    const { bridge, b, ports, state } = setup();
    await bridge.sync(true, true);
    ports[0]!.receive({
      type: "busy",
      reason: "another Chrome profile is connected",
    });
    expect(bridge.state()).toMatchObject({
      status: "busy",
      error: "another Chrome profile is connected",
    });
    state.lastError = { message: "Native host has exited." };
    ports[0]!.die();
    expect(bridge.state().status).toBe("busy"); // not "error": nothing is broken
    await vi.advanceTimersByTimeAsync(9_999);
    expect(b.runtime.connectNative).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(b.runtime.connectNative).toHaveBeenCalledTimes(2);
    expect(bridge.state().status).toBe("busy"); // no flicker to "connecting" between looks
    ports[1]!.receive({
      type: "busy",
      reason: "another Chrome profile is connected",
    });
    ports[1]!.die();
    await vi.advanceTimersByTimeAsync(10_001); // still busy: it keeps looking at the same pace (no back-off growth)
    expect(b.runtime.connectNative).toHaveBeenCalledTimes(3);
    ports[2]!.receive({ type: "ready", version: 1, socket: "/s" });
    expect(bridge.state()).toMatchObject({ status: "connected", error: null });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(b.runtime.connectNative).toHaveBeenCalledTimes(3);
  });

  it("switching off while busy stops the looking", async () => {
    const { bridge, b, ports } = setup();
    await bridge.sync(true, true);
    ports[0]!.receive({ type: "busy", reason: "x" });
    ports[0]!.die();
    await bridge.sync(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(b.runtime.connectNative).toHaveBeenCalledTimes(1);
    expect(bridge.state().status).toBe("off");
  });

  it('reports a missing host and does not hammer Chrome; "check again" tries once more', async () => {
    const { bridge, b, ports, state } = setup();
    await bridge.sync(true, true);
    state.lastError = { message: "Specified native messaging host not found." };
    ports[0]!.die();
    expect(bridge.state()).toMatchObject({
      status: "host-missing",
      error: "Specified native messaging host not found.",
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(b.runtime.connectNative).toHaveBeenCalledTimes(1); // only the alarm / the button retry
    bridge.handleAlarm(BRIDGE_ALARM);
    expect(b.runtime.connectNative).toHaveBeenCalledTimes(2);
    state.lastError = undefined;
    ports[1]!.receive({ type: "ready", version: 1, socket: "/s" });
    expect(bridge.state().status).toBe("connected");
  });

  it("reconnects with a growing back-off when the host exits, and resets it after a successful connection", async () => {
    const { bridge, b, ports, state } = setup();
    await bridge.sync(true, true);
    state.lastError = { message: "Native host has exited." };
    ports[0]!.die();
    expect(bridge.state()).toMatchObject({
      status: "error",
      error: "Native host has exited.",
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(b.runtime.connectNative).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2); // 1 s
    expect(b.runtime.connectNative).toHaveBeenCalledTimes(2);
    ports[1]!.die();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(b.runtime.connectNative).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2); // 2 s
    expect(b.runtime.connectNative).toHaveBeenCalledTimes(3);
    ports[2]!.receive({ type: "ready", version: 1, socket: "/s" });
    ports[2]!.die();
    await vi.advanceTimersByTimeAsync(1_001); // back to 1 s
    expect(b.runtime.connectNative).toHaveBeenCalledTimes(4);
  });

  it("shows the host's own explanation when it says why it is exiting", async () => {
    const { bridge, ports, state } = setup();
    await bridge.sync(true, true);
    ports[0]!.receive({
      type: "fatal",
      message: "cannot listen on /s: EACCES",
    });
    state.lastError = { message: "Native host has exited." };
    ports[0]!.die();
    expect(bridge.state().error).toBe("cannot listen on /s: EACCES");
  });

  it("gives up on a host that starts but never says ready", async () => {
    const { bridge, ports } = setup();
    await bridge.sync(true, true);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(ports[0]!.disconnected).toBe(true);
    expect(bridge.state()).toMatchObject({
      status: "error",
      error: "the host started but did not answer",
    });
  });

  it("keeps the counter across a worker restart and publishes its state for the UI", async () => {
    const first = setup();
    await first.bridge.sync(true, true);
    first.ports[0]!.receive({ type: "ready", version: 1, socket: "/s" });
    first.ports[0]!.receive({
      type: "request",
      id: 1,
      tool: "list_tabs",
      args: {},
    });
    await vi.advanceTimersByTimeAsync(0);
    const stored = first.area.data.get(BRIDGE_STATE_KEY) as {
      actions: number;
      status: string;
    };
    expect(stored).toMatchObject({ actions: 1, status: "connected" });

    const area = new MemoryStorageArea();
    await area.set({ [BRIDGE_STATE_KEY]: stored });
    const again = new AgentBridge(
      {
        runtime: { connectNative: vi.fn(() => new FakePort()) },
        alarms: { create: vi.fn(), clear: vi.fn() },
      } as never,
      area,
      createLogger(5),
    );
    await again.sync(true, false);
    expect(again.state()).toMatchObject({
      status: "connecting",
      actions: 1,
      recent: [expect.objectContaining({ tool: "list_tabs" })],
    });
  });

  it("lets go of what the agent left behind a grace after the last MCP client has gone, unless one comes back", async () => {
    const { bridge, ports } = setup();
    const release = vi.fn(async () => {});
    bridge.setRunner({ run: vi.fn(async () => ({ content: [] })), release });
    await bridge.sync(true, true);
    const port = ports[0]!;
    port.receive({ type: "ready", version: 1, socket: "/s" });
    port.receive({ type: "clients", count: 1 });
    port.receive({ type: "clients", count: 0 });
    await vi.advanceTimersByTimeAsync(RELEASE_GRACE_MS - 1_000);
    expect(release).not.toHaveBeenCalled();
    port.receive({ type: "clients", count: 1 }); // a restarting client came back in time
    await vi.advanceTimersByTimeAsync(RELEASE_GRACE_MS);
    expect(release).not.toHaveBeenCalled();
    port.receive({ type: "clients", count: 0 });
    await vi.advanceTimersByTimeAsync(RELEASE_GRACE_MS + 100);
    expect(release).toHaveBeenCalledTimes(1);
    // Switched off during the grace: the off switch does its own cleanup, nothing is released twice.
    port.receive({ type: "clients", count: 0 });
    await bridge.sync(false);
    await vi.advanceTimersByTimeAsync(RELEASE_GRACE_MS * 2);
    expect(release).toHaveBeenCalledTimes(1);
  });

  describe("several Chrome profiles (protocol 2)", () => {
    const identity = (keys: string[], label = "") => {
      let i = 0;
      const id = {
        key: vi.fn(async () => keys[i]!),
        renewKey: vi.fn(async () => keys[++i]!),
        label: vi.fn(async () => label),
      };
      return id;
    };

    it("opens every connection with hello and this profile's key, the same key each time", async () => {
      const { bridge, ports } = setup(identity(["k1abc23def"], "Work"));
      await bridge.sync(true, true);
      expect(ports[0]!.hello).toEqual({
        type: "hello",
        version: 2,
        profileKey: "k1abc23def",
      });
      ports[0]!.receive({
        type: "ready",
        version: 2,
        socket: "/b/k1abc23def.sock",
        profileKey: "k1abc23def",
      });
      expect(bridge.state()).toMatchObject({
        status: "connected",
        hostOutdated: false,
        profileKey: "k1abc23def",
        profileLabel: "Work",
      });
      ports[0]!.die();
      await vi.advanceTimersByTimeAsync(1_001);
      expect(ports[1]!.hello.profileKey).toBe("k1abc23def");
    });

    it("an older host (protocol 1) works but is flagged for an update; a newer one is not", async () => {
      const { bridge, ports } = setup();
      await bridge.sync(true, true);
      ports[0]!.receive({ type: "ready", version: 1, socket: "/s" });
      expect(bridge.state()).toMatchObject({
        status: "connected",
        hostOutdated: true,
        profiles: null,
      });
      await bridge.sync(false);
      expect(bridge.state().hostOutdated).toBe(false);
      await bridge.sync(true, true);
      ports[1]!.receive({ type: "ready", version: 2, socket: "/b/x.sock" });
      expect(bridge.state().hostOutdated).toBe(false);
    });

    it('an older host\'s "busy" (one socket for every profile) asks for an update', async () => {
      const { bridge, ports } = setup();
      await bridge.sync(true, true);
      ports[0]!.receive({
        type: "busy",
        reason: "another Chrome profile is connected",
      });
      expect(bridge.state()).toMatchObject({
        status: "busy",
        hostOutdated: true,
      });
    });

    it("publishes how many profiles have the bridge on, and forgets it when switched off", async () => {
      const { bridge, ports } = setup();
      await bridge.sync(true, true);
      ports[0]!.receive({ type: "ready", version: 2, socket: "/b/x.sock" });
      ports[0]!.receive({ type: "profiles", count: 3 });
      expect(bridge.state().profiles).toBe(3);
      ports[0]!.receive({ type: "profiles", count: 2 });
      expect(bridge.state().profiles).toBe(2);
      await bridge.sync(false);
      expect(bridge.state().profiles).toBeNull();
    });

    it("its own socket held: looks again after a second; held again, the key is taken by another profile and is renewed", async () => {
      const id = identity(["k1abc23def", "n2ewkey456"]);
      const { bridge, b, ports, state } = setup(id);
      await bridge.sync(true, true);
      state.lastError = { message: "Native host has exited." };
      ports[0]!.receive({
        type: "busy",
        code: "same-profile",
        reason: "a bridge host for this Chrome profile is already running",
      });
      ports[0]!.die();
      expect(bridge.state().status).toBe("connecting"); // nothing for the user to do yet
      await vi.advanceTimersByTimeAsync(999);
      expect(b.runtime.connectNative).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2);
      expect(b.runtime.connectNative).toHaveBeenCalledTimes(2);
      expect(ports[1]!.hello.profileKey).toBe("k1abc23def");
      expect(id.renewKey).not.toHaveBeenCalled();
      ports[1]!.receive({ type: "busy", code: "same-profile", reason: "x" });
      ports[1]!.die();
      await vi.advanceTimersByTimeAsync(0);
      expect(id.renewKey).toHaveBeenCalledTimes(1);
      expect(b.runtime.connectNative).toHaveBeenCalledTimes(3);
      expect(ports[2]!.hello.profileKey).toBe("n2ewkey456");
      ports[2]!.receive({
        type: "ready",
        version: 2,
        socket: "/b/n2ewkey456.sock",
      });
      expect(bridge.state()).toMatchObject({
        status: "connected",
        profileKey: "n2ewkey456",
      });
    });

    it("a quick off and on whose old host left in time keeps the key", async () => {
      const id = identity(["k1abc23def", "unused0000"]);
      const { bridge, ports } = setup(id);
      await bridge.sync(true, true);
      ports[0]!.receive({ type: "busy", code: "same-profile", reason: "x" });
      ports[0]!.die();
      await vi.advanceTimersByTimeAsync(1_001);
      ports[1]!.receive({ type: "ready", version: 2, socket: "/b/k.sock" });
      // A later single "busy" starts counting from zero again.
      ports[1]!.die();
      await vi.advanceTimersByTimeAsync(1_001);
      ports[2]!.receive({ type: "busy", code: "same-profile", reason: "x" });
      ports[2]!.die();
      await vi.advanceTimersByTimeAsync(1_001);
      expect(id.renewKey).not.toHaveBeenCalled();
      expect(ports[3]!.hello.profileKey).toBe("k1abc23def");
    });

    it("a new profile name shows at once", async () => {
      const { bridge } = setup(identity(["k1abc23def"], "Old"));
      await bridge.sync(true, true);
      expect(bridge.state().profileLabel).toBe("Old");
      bridge.labelChanged("New");
      expect(bridge.state().profileLabel).toBe("New");
    });

    it("answers the MCP server's __profile and __tabs itself: IDs and the name only, never counted or listed", async () => {
      const { bridge, ports, run } = setup(identity(["k1abc23def"], "Work"));
      await bridge.sync(true, true);
      const port = ports[0]!;
      port.receive({ type: "ready", version: 2, socket: "/b/k.sock" });
      port.receive({ type: "request", id: 1, tool: "__profile", args: {} });
      port.receive({ type: "request", id: 2, tool: "__tabs", args: {} });
      await vi.advanceTimersByTimeAsync(0);
      const text = (id: number) =>
        port.sent.find((m) => m.id === id)?.result.content[0].text;
      expect(JSON.parse(text(1))).toEqual({
        profileKey: "k1abc23def",
        profileLabel: "Work",
      });
      expect(JSON.parse(text(2))).toEqual([{ tabId: 3, windowId: 1 }]);
      expect(run).not.toHaveBeenCalled();
      expect(bridge.state()).toMatchObject({ actions: 0, recent: [] });
    });
  });
});
