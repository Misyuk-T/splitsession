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
  /** An extension of 0.1.x: no `__profile` / `__tabs`. */
  old?: boolean;
  /** The host process's session, stamped on every answer (none: a host of 0.1.x). */
  session?: string;
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
      const r = answer(p, tool, args);
      return p.session ? { ...r, session: p.session } : r;
    },
  });
  return { d, gone };
}

function answer(
  p: FakeProfile,
  tool: string,
  args: Record<string, unknown>,
): ClientResponse {
  // An extension of 0.1.x treats every "__" tool as internal and answers "pong".
  if (tool.startsWith("__") && p.old)
    return {
      id: 1,
      ok: true,
      result: { content: [{ type: "text", text: "pong" }] },
    };
  if (tool === "__profile")
    return text({ profileKey: p.ep.key, profileLabel: p.label });
  if (tool === "__tabs")
    return text(p.tabs.map((t) => ({ tabId: t.tabId, windowId: t.windowId })));
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
    // A click on the new tab finds it in b.
    expect(
      json(await d.run("click", { tabId: opened.tabId, ref: "e1" })),
    ).toMatchObject({ by: "bbbbbbbbbb" });
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
    // Its socket refuses: nobody has tab 2 now, so nothing is done anywhere.
    expect((r.content![0] as { text: string }).text).toMatch(
      /no tab with id 2 in any connected Chrome profile/,
    );
    expect(a.calls.some((c) => c.tool === "click")).toBe(false);
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

  describe("tab tools: a live owner check every time, and the tab must be the one the agent saw", () => {
    const err = (r: { content?: unknown[] }) =>
      (r.content![0] as { text: string }).text;
    const did = (p: FakeProfile, tool: string) =>
      p.calls.filter((c) => c.tool === tool).length;

    it("asks every profile who has the tab (uncounted __tabs) on every call, cache or not, and acts in the only owner", async () => {
      const a = profile("aaaaaaaaaa", "Work", [1]);
      const b = profile("bbbbbbbbbb", "Home", [7]);
      const { d } = world([a, b]);
      for (let i = 0; i < 2; i += 1)
        expect(
          json(await d.run("click", { tabId: 7, ref: "e1" })),
        ).toMatchObject({ by: "bbbbbbbbbb" });
      expect(a.calls.map((c) => c.tool)).toEqual(["__tabs", "__tabs"]);
      expect(b.calls.map((c) => c.tool)).toEqual([
        "__tabs",
        "click",
        "__tabs",
        "click",
      ]);
      const missing = await d.run("click", { tabId: 99, ref: "e1" });
      expect(err(missing)).toMatch(
        /no tab with id 99 in any connected Chrome profile/,
      );
    });

    it("one profile connected: the same live check (no shortcut)", async () => {
      const a = { ...profile("aaaaaaaaaa", "Work", [1]), session: "s1" };
      const { d } = world([a]);
      await d.run("click", { tabId: 1, ref: "e1" });
      expect(a.calls.map((c) => c.tool)).toEqual(["__tabs", "click"]);
      expect(err(await d.run("click", { tabId: 2, ref: "e1" }))).toMatch(
        /no tab with id 2/,
      );
    });

    it("repro P1-1: a list of one profile does not make a shared ID safe; close_tab refuses instead of closing A's tab", async () => {
      const a = profile("aaaaaaaaaa", "Work", [7]);
      const b = profile("bbbbbbbbbb", "Home", [7]);
      const { d } = world([a, b]);
      await d.run("list_tabs", { profile: "Work" });
      const r = await d.run("close_tab", { tabId: 7 });
      expect(r.isError).toBe(true);
      expect(err(r)).toMatch(
        /tab id 7 exists in several Chrome profiles .*Pass profile/,
      );
      expect(did(a, "close_tab") + did(b, "close_tab")).toBe(0);
    });

    it("repro P1-1, later collision: an ID seen in one profile that another profile gets too is refused as ambiguous", async () => {
      const a = profile("aaaaaaaaaa", "Work", [7]);
      const b = profile("bbbbbbbbbb", "Home", [1]);
      const { d } = world([a, b]);
      await d.run("list_tabs", {});
      b.tabs.push({ tabId: 7, windowId: 1, title: "B's own" });
      expect(err(await d.run("close_tab", { tabId: 7 }))).toMatch(
        /exists in several Chrome profiles/,
      );
      expect(did(a, "close_tab") + did(b, "close_tab")).toBe(0);
      // Saying which one works: the agent saw 7 in A.
      expect(
        json(await d.run("close_tab", { tabId: 7, profile: "Work" })),
      ).toMatchObject({ by: "aaaaaaaaaa" });
    });

    it("repro P1-2: A's tab 7 seen, A disconnects, B gets tab 7: the stale ID is refused, B's tab is not touched", async () => {
      const a = { ...profile("aaaaaaaaaa", "Work", [7]), session: "sa" };
      const b = { ...profile("bbbbbbbbbb", "Home", [1]), session: "sb" };
      const { d } = world([a, b]);
      await d.run("list_tabs", {});
      a.down = true;
      b.tabs.push({ tabId: 7, windowId: 1, title: "unrelated" });
      const r = await d.run("close_tab", { tabId: 7 });
      expect(r.isError).toBe(true);
      expect(err(r)).toMatch(
        /stale tab id 7: the tab you saw in the Chrome profile key aaaaaaaaaa \(not connected now\) is gone; nothing was done\. Call list_tabs again/,
      );
      expect(did(b, "close_tab")).toBe(0);
      // A fresh look clears it: now 7 is B's tab, seen in B.
      await d.run("list_tabs", {});
      expect(json(await d.run("close_tab", { tabId: 7 }))).toMatchObject({
        by: "bbbbbbbbbb",
      });
    });

    it("the same profile after a host restart (new session) with a reused ID: stale until listed again", async () => {
      const a = { ...profile("aaaaaaaaaa", "Work", [7]), session: "s1" };
      const { d } = world([a]);
      await d.run("list_tabs", {});
      a.session = "s2"; // Chrome restarted: a new host, tab numbers start again
      a.tabs = [{ tabId: 7, windowId: 1, title: "another page" }];
      const r = await d.run("click", { tabId: 7, ref: "e1" });
      expect(err(r)).toMatch(
        /stale tab id 7: .*"Work" \(key aaaaaaaaaa\) is gone \(that profile's bridge has restarted since/,
      );
      expect(did(a, "click")).toBe(0);
      await d.run("list_tabs", {});
      expect(
        (await d.run("click", { tabId: 7, ref: "e1" })).isError,
      ).toBeUndefined();
    });

    it("a host of 0.1.x has no session: a new socket inode counts as a restart", async () => {
      const a = profile("aaaaaaaaaa", "Work", [7]);
      const { d } = world([a]);
      await d.run("list_tabs", {});
      a.ep = { ...a.ep, ino: 2 };
      expect(err(await d.run("click", { tabId: 7, ref: "e1" }))).toMatch(
        /stale tab id 7/,
      );
      expect(did(a, "click")).toBe(0);
    });

    it("explicit profile: acts only there, the tab must be there, and an ID the agent saw elsewhere is stale until that profile is listed", async () => {
      const a = { ...profile("aaaaaaaaaa", "Work", [7]), session: "sa" };
      const b = { ...profile("bbbbbbbbbb", "Home", [3]), session: "sb" };
      const { d } = world([a, b]);
      await d.run("list_tabs", {});
      expect(
        err(await d.run("click", { tabId: 7, ref: "e1", profile: "Home" })),
      ).toMatch(
        /no tab with id 7 in the Chrome profile "Home" \(key bbbbbbbbbb\)/,
      );
      expect(did(a, "__tabs")).toBe(0); // only the named profile is asked
      b.tabs.push({ tabId: 7, windowId: 1, title: "B's 7" });
      expect(
        err(await d.run("click", { tabId: 7, ref: "e1", profile: "Home" })),
      ).toMatch(/stale tab id 7: .*"Work"/);
      expect(did(b, "click")).toBe(0);
      await d.run("list_tabs", { profile: "Home" }); // the agent now has seen B's 7 too
      expect(
        json(await d.run("click", { tabId: 7, ref: "e1", profile: "Home" })),
      ).toMatchObject({ by: "bbbbbbbbbb" });
      expect(
        json(await d.run("click", { tabId: 7, ref: "e1", profile: "Work" })),
      ).toMatchObject({ by: "aaaaaaaaaa" });
    });

    it("a tab moved to another window of the same profile is still the same tab", async () => {
      const a = { ...profile("aaaaaaaaaa", "Work", [7], 1), session: "s1" };
      const b = { ...profile("bbbbbbbbbb", "Home", [2]), session: "s2" };
      const { d } = world([a, b]);
      await d.run("list_tabs", {});
      a.tabs[0]!.windowId = 9;
      expect(json(await d.run("click", { tabId: 7, ref: "e1" }))).toMatchObject(
        { by: "aaaaaaaaaa" },
      );
    });

    it("an ID the agent never saw is acted on when exactly one profile has it; a tab it opened is remembered where it opened it", async () => {
      const a = { ...profile("aaaaaaaaaa", "Work", [7]), session: "sa" };
      const b = { ...profile("bbbbbbbbbb", "Home", []), session: "sb" };
      const { d } = world([a, b]);
      expect((await d.run("reload", { tabId: 7 })).isError).toBeUndefined();
      const { tabId } = json(
        await d.run("open_tab", { url: "about:blank", profile: "Home" }),
      );
      b.session = "sb2"; // b's host restarts; the new tab's number reappears in b
      expect(err(await d.run("click", { tabId, ref: "e1" }))).toMatch(
        /stale tab id/,
      );
    });

    it("names and lookups use the extension's uncounted tools; an extension of 0.1.x is asked bridge_info and list_tabs instead", async () => {
      const a = profile("aaaaaaaaaa", "Work", [1]);
      const b = { ...profile("bbbbbbbbbb", "Old", [2]), old: true };
      const { d } = world([a, b]);
      const tabs = json(await d.run("list_tabs", {}));
      expect(
        tabs.map((t: { profile: { label: string } }) => t.profile.label),
      ).toEqual(["Work", "Old"]);
      expect(a.calls.map((c) => c.tool).sort()).toEqual([
        "__profile",
        "list_tabs",
      ]);
      expect(b.calls.map((c) => c.tool).sort()).toEqual([
        "__profile",
        "bridge_info",
        "list_tabs",
      ]);
      a.calls.length = 0;
      b.calls.length = 0;
      expect(json(await d.run("click", { tabId: 2, ref: "e1" }))).toMatchObject(
        { by: "bbbbbbbbbb" },
      );
      expect(a.calls.map((c) => c.tool)).toEqual(["__tabs"]);
      expect(b.calls.map((c) => c.tool)).toEqual([
        "__tabs",
        "list_tabs",
        "click",
      ]);
    });
  });
});
