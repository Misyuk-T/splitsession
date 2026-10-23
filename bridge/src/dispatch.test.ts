import { describe, expect, it, vi } from "vitest";

import type { ClientResponse } from "../../src/bridge/protocol";
import { bridgeInfo, Dispatcher, Unreachable } from "./dispatch";
import type { Endpoint } from "./profiles";

/** A fake Chrome profile behind a socket: its label, tabs and containers, and every call it got. */
interface FakeProfile {
  ep: Endpoint;
  label: string | null;
  tabs: Array<{ tabId: number; windowId: number; title: string }>;
  containers: Array<{ id: string; name: string }>;
  calls: Array<{ tool: string; args: Record<string, unknown> }>;
  down?: boolean;
}

const ep = (key: string, ino = 1, legacy = false): Endpoint => ({
  key,
  socket: `/b/${key}.sock`,
  legacy,
  ino,
});

const text = (value: unknown): ClientResponse => ({
  id: 1,
  ok: true,
  result: { content: [{ type: "text", text: JSON.stringify(value) }] },
});

function world(profiles: FakeProfile[]) {
  const gone = vi.fn();
  const live = () => profiles.filter((p) => !p.down);
  const d = new Dispatcher({
    discover: () => live().map((p) => p.ep),
    unreachable: () => "bridge is off",
    gone,
    call: async (e, tool, args) => {
      const p = profiles.find((x) => x.ep.socket === e.socket);
      if (!p || p.down) throw new Unreachable("ECONNREFUSED");
      p.calls.push({ tool, args });
      if (tool === "bridge_info")
        return text({
          profileLabel: p.label,
          windows: 1,
          tabs: p.tabs.length,
          containers: p.containers.length,
          extensionVersion: "0.2.0",
        });
      if (tool === "list_tabs") {
        if (
          typeof args.containerId === "string" &&
          !p.containers.some((c) => c.name === args.containerId)
        )
          return {
            id: 1,
            ok: false,
            error: `no container "${args.containerId}"`,
          };
        return text(
          p.tabs.filter(
            (t) => args.windowId === undefined || t.windowId === args.windowId,
          ),
        );
      }
      if (tool === "list_containers") return text(p.containers);
      if (tool === "open_tab" || tool === "open_in_container") {
        const tabId = 1000 + p.tabs.length;
        p.tabs.push({ tabId, windowId: 1, title: "new" });
        return text({ tabId, url: args.url });
      }
      if (typeof args.tabId === "number") {
        if (!p.tabs.some((t) => t.tabId === args.tabId))
          return {
            id: 1,
            ok: false,
            error: `no tab with id ${args.tabId} (it may have been closed; call list_tabs)`,
          };
        return text({ tabId: args.tabId, done: tool, by: p.ep.key });
      }
      return text({ tool });
    },
  });
  return { d, gone };
}

const profile = (
  key: string,
  label: string | null,
  tabs: number[],
  windowId = 1,
): FakeProfile => ({
  ep: ep(key),
  label,
  tabs: tabs.map((tabId) => ({ tabId, windowId, title: `t${tabId}` })),
  containers: [{ id: `c-${key}`, name: `box-${key}` }],
  calls: [],
});

const json = (r: { content?: Array<{ type: string; text?: string }> }) =>
  JSON.parse((r.content![0] as { text: string }).text);

describe("Dispatcher: one MCP server, several Chrome profiles", () => {
  it("no profile connected: the off message", async () => {
    const { d } = world([]);
    const r = await d.run("list_tabs", {});
    expect(r.isError).toBe(true);
    expect((r.content![0] as { text: string }).text).toBe("bridge is off");
  });

  it("one profile: every call goes there, with no profile argument needed, and the profile argument never reaches the extension", async () => {
    const a = profile("aaaaaaaaaa", "Work", [5]);
    const { d } = world([a]);
    const opened = await d.run("open_tab", { url: "https://x.test/" });
    expect(opened.isError).toBeUndefined();
    expect(json(opened)).toMatchObject({ tabId: 1001 });
    const clicked = await d.run("click", { tabId: 5, ref: "e1" });
    expect(json(clicked)).toMatchObject({ by: "aaaaaaaaaa" });
    await d.run("click", { tabId: 5, ref: "e1", profile: "work" });
    expect(a.calls.every((c) => !("profile" in c.args))).toBe(true);
  });

  it("bridge_info: one profile keeps the old top-level fields; several give a list and ask for names", async () => {
    const a = profile("aaaaaaaaaa", "Work", [1]);
    const one = world([a]);
    expect(json(await one.d.run("bridge_info", {}))).toMatchObject({
      profileKey: "aaaaaaaaaa",
      profileLabel: "Work",
      tabs: 1,
      extensionVersion: "0.2.0",
      profiles: [{ profileKey: "aaaaaaaaaa", label: "Work" }],
    });
    const b = profile("bbbbbbbbbb", null, [2]);
    const two = world([a, b]);
    const info = json(await two.d.run("bridge_info", {}));
    expect(info.profileLabel).toBeUndefined();
    expect(info.profiles).toEqual([
      expect.objectContaining({ profileKey: "aaaaaaaaaa", label: "Work" }),
      expect.objectContaining({ profileKey: "bbbbbbbbbb", label: null }),
    ]);
    expect(info.hint).toMatch(/Profile name/);
    expect(
      json(await two.d.run("bridge_info", { profile: "work" })),
    ).toMatchObject({
      profileKey: "aaaaaaaaaa",
    });
  });

  it("list_tabs and list_containers put every profile together, each item tagged with its profile; profile filters", async () => {
    const a = profile("aaaaaaaaaa", "Work", [1, 2]);
    const b = profile("bbbbbbbbbb", "Home", [3]);
    const { d } = world([a, b]);
    const tabs = json(await d.run("list_tabs", {}));
    expect(
      tabs.map((t: { tabId: number; profile: unknown }) => [
        t.tabId,
        t.profile,
      ]),
    ).toEqual([
      [1, { key: "aaaaaaaaaa", label: "Work" }],
      [2, { key: "aaaaaaaaaa", label: "Work" }],
      [3, { key: "bbbbbbbbbb", label: "Home" }],
    ]);
    const containers = json(await d.run("list_containers", {}));
    expect(containers).toEqual([
      {
        id: "c-aaaaaaaaaa",
        name: "box-aaaaaaaaaa",
        profile: { key: "aaaaaaaaaa", label: "Work" },
      },
      {
        id: "c-bbbbbbbbbb",
        name: "box-bbbbbbbbbb",
        profile: { key: "bbbbbbbbbb", label: "Home" },
      },
    ]);
    const home = json(await d.run("list_tabs", { profile: "HOME" }));
    expect(home.map((t: { tabId: number }) => t.tabId)).toEqual([3]);
    const byKey = json(await d.run("list_tabs", { profile: "aaaaaaaaaa" }));
    expect(byKey).toHaveLength(2);
    const unknown = await d.run("list_tabs", { profile: "Gaming" });
    expect(unknown.isError).toBe(true);
    expect((unknown.content![0] as { text: string }).text).toMatch(
      /No connected Chrome profile is named "Gaming". Connected: "Work" \(key aaaaaaaaaa\), "Home" \(key bbbbbbbbbb\)/,
    );
  });

  it("a container filter that only one profile knows is not an error; one nobody knows is", async () => {
    const a = profile("aaaaaaaaaa", "Work", [1]);
    const b = profile("bbbbbbbbbb", "Home", [2]);
    const { d } = world([a, b]);
    const r = await d.run("list_tabs", { containerId: "box-bbbbbbbbbb" });
    expect(r.isError).toBeUndefined();
    expect(json(r).map((t: { tabId: number }) => t.tabId)).toEqual([2]);
    const none = await d.run("list_tabs", { containerId: "nope" });
    expect(none.isError).toBe(true);
    expect((none.content![0] as { text: string }).text).toMatch(
      /no container "nope"/,
    );
  });

  it("a tool on a tab goes to the profile that has the tab: from the cache, or by asking every profile", async () => {
    const a = profile("aaaaaaaaaa", "Work", [1]);
    const b = profile("bbbbbbbbbb", "Home", [7]);
    const { d } = world([a, b]);
    // Never listed: found by asking.
    expect(json(await d.run("click", { tabId: 7, ref: "e1" }))).toMatchObject({
      by: "bbbbbbbbbb",
    });
    expect(a.calls.map((c) => c.tool)).toEqual(["list_tabs"]);
    // Now cached: no more lookups.
    a.calls.length = 0;
    b.calls.length = 0;
    expect(json(await d.run("snapshot", { tabId: 7 }))).toMatchObject({
      by: "bbbbbbbbbb",
    });
    expect(a.calls).toEqual([]);
    expect(b.calls.map((c) => c.tool)).toEqual(["snapshot"]);
    const missing = await d.run("click", { tabId: 99, ref: "e1" });
    expect((missing.content![0] as { text: string }).text).toMatch(
      /no tab with id 99 in any connected Chrome profile/,
    );
  });

  it("a cached tab that moved (closed, Chrome restarted) is looked up again once", async () => {
    const a = profile("aaaaaaaaaa", "Work", [7]);
    const b = profile("bbbbbbbbbb", "Home", []);
    const { d } = world([a, b]);
    await d.run("list_tabs", {});
    a.tabs = [];
    b.tabs = [{ tabId: 7, windowId: 1, title: "x" }];
    expect(json(await d.run("click", { tabId: 7, ref: "e1" }))).toMatchObject({
      by: "bbbbbbbbbb",
    });
  });

  it("a host that restarted (new socket inode) does not inherit the old cache", async () => {
    const a = profile("aaaaaaaaaa", "Work", [7]);
    const b = profile("bbbbbbbbbb", "Home", []);
    const { d } = world([a, b]);
    await d.run("list_tabs", {});
    a.ep = { ...a.ep, ino: 2 };
    a.tabs = [];
    b.tabs = [{ tabId: 7, windowId: 1, title: "x" }];
    a.calls.length = 0;
    expect(json(await d.run("click", { tabId: 7, ref: "e1" }))).toMatchObject({
      by: "bbbbbbbbbb",
    });
    expect(a.calls.map((c) => c.tool)).toEqual(["list_tabs"]); // asked, not clicked
  });

  it("the same tab ID in two profiles (separate Chrome processes) needs profile, and then goes where it says", async () => {
    const a = profile("aaaaaaaaaa", "Work", [5]);
    const b = profile("bbbbbbbbbb", "Home", [5]);
    const { d } = world([a, b]);
    await d.run("list_tabs", {});
    const r = await d.run("click", { tabId: 5, ref: "e1" });
    expect(r.isError).toBe(true);
    expect((r.content![0] as { text: string }).text).toMatch(
      /tab id 5 exists in several Chrome profiles .*Pass profile/,
    );
    expect(
      json(await d.run("click", { tabId: 5, ref: "e1", profile: "Home" })),
    ).toMatchObject({
      by: "bbbbbbbbbb",
    });
    // A list of one profile does not make the ID unambiguous.
    await d.run("list_tabs", { profile: "Work" });
    expect((await d.run("click", { tabId: 5, ref: "e1" })).isError).toBe(true);
  });

  it("opening a tab with several profiles and no profile is an error that lists them; profile or windowId decide", async () => {
    const a = profile("aaaaaaaaaa", "Work", [1], 10);
    const b = profile("bbbbbbbbbb", null, [2], 20);
    const { d } = world([a, b]);
    const r = await d.run("open_in_container", {
      url: "https://x.test/",
      container: "c",
    });
    expect(r.isError).toBe(true);
    expect((r.content![0] as { text: string }).text).toBe(
      'Several Chrome profiles have the SplitSession agent bridge on: "Work" (key aaaaaaaaaa), unnamed (key bbbbbbbbbb). Say which one with profile: "<name or key>" (bridge_info lists them); a tool on a tab finds the tab\'s profile by itself.',
    );
    expect(a.calls.some((c) => c.tool === "open_in_container")).toBe(false);
    expect(b.calls.some((c) => c.tool === "open_in_container")).toBe(false);
    const opened = json(
      await d.run("open_tab", {
        url: "https://x.test/",
        profile: "bbbbbbbbbb",
      }),
    );
    expect(b.tabs.some((t) => t.tabId === opened.tabId)).toBe(true);
    // The new tab is remembered: a click on it goes to b without a lookup.
    a.calls.length = 0;
    expect(
      json(await d.run("click", { tabId: opened.tabId, ref: "e1" })),
    ).toMatchObject({ by: "bbbbbbbbbb" });
    expect(a.calls).toEqual([]);
    const inWindow = json(
      await d.run("open_tab", { url: "https://y.test/", windowId: 10 }),
    );
    expect(a.tabs.some((t) => t.tabId === inWindow.tabId)).toBe(true);
  });

  it("a profile switched off between the scan and the call is left out of lists and reported for a tab", async () => {
    const a = profile("aaaaaaaaaa", "Work", [1]);
    const b = profile("bbbbbbbbbb", "Home", [2]);
    const { d, gone } = world([a, b]);
    await d.run("list_tabs", {});
    const realDiscover = [a.ep, b.ep];
    b.down = true;
    // The socket file is still there (a leftover), so discovery still lists it.
    (d as unknown as { d: { discover: () => Endpoint[] } }).d.discover = () =>
      realDiscover;
    const tabs = json(await d.run("list_tabs", {}));
    expect(tabs.map((t: { tabId: number }) => t.tabId)).toEqual([1]);
    expect(gone).toHaveBeenCalledWith(b.ep);
    const r = await d.run("click", { tabId: 2, ref: "e1" });
    expect(r.isError).toBe(true);
    expect((r.content![0] as { text: string }).text).toMatch(
      /not connected any more/,
    );
  });

  it("two profiles with the same name: the name is refused, the key works", async () => {
    const a = profile("aaaaaaaaaa", "Work", [1]);
    const b = profile("bbbbbbbbbb", "work", [2]);
    const { d } = world([a, b]);
    const r = await d.run("open_tab", { url: "about:blank", profile: "Work" });
    expect((r.content![0] as { text: string }).text).toMatch(
      /Several connected Chrome profiles are named "Work".*Use the key/,
    );
    expect(
      (await d.run("open_tab", { url: "about:blank", profile: "bbbbbbbbbb" }))
        .isError,
    ).toBeUndefined();
  });

  it("bridgeInfo marks a legacy (0.1.x) profile", () => {
    const out = bridgeInfo([
      { profileKey: "legacy", label: null, legacy: true },
    ]);
    expect(out).toMatchObject({ profileKey: "legacy", profileLabel: null });
    expect(out.legacyNote).toMatch(/0\.1\.x/);
  });
});
