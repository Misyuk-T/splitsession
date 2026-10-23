import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { encodeFrame, FrameReader } from "../../src/bridge/framing";
import { EXTENSION_ORIGIN } from "../../src/bridge/protocol";
import { liveDispatcher } from "./mcp";

const t0 = (r: { content?: unknown[] }) =>
  (r.content![0] as { text: string }).text;

/**
 * The host as Chrome runs it (a real process, the real bundle), with this test playing the extension on its stdin/stdout,
 * and the MCP server's dispatcher talking to the hosts' sockets. Two (or three) "profiles" are two (or three) hosts.
 */

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
let bundleDir = "";
let bundle = "";

beforeAll(async () => {
  bundleDir = mkdtempSync("/tmp/fbb-");
  bundle = path.join(bundleDir, "bridge.mjs");
  await build({
    absWorkingDir: root,
    entryPoints: ["bridge/src/main.ts"],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    define: { __VERSION__: JSON.stringify("0.0.0-test") },
    banner: {
      js: "import { createRequire as __r } from 'node:module'; const require = __r(import.meta.url);",
    },
    logLevel: "silent",
  });
}, 30_000);
afterAll(() => rmSync(bundleDir, { recursive: true, force: true }));

const dirs: string[] = [];
const hosts: FakeExtension[] = [];
const tmp = () => {
  const d = mkdtempSync("/tmp/fb-");
  dirs.push(d);
  return d;
};
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Handler = (tool: string, args: Record<string, unknown>) => unknown;

/** One Chrome profile's extension end: starts a host, says hello (or not), answers its requests with `handler`. */
class FakeExtension {
  readonly messages: any[] = [];
  readonly child: ChildProcess;
  private readonly reader = new FrameReader();
  private waiters: Array<() => void> = [];
  exited: Promise<number | null>;

  constructor(
    env: NodeJS.ProcessEnv,
    private readonly handler: Handler = () => ({ ok: true }),
  ) {
    this.child = spawn(process.execPath, [bundle, "host", EXTENSION_ORIGIN], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "ignore"],
    });
    this.exited = new Promise((r) =>
      this.child.once("exit", (code) => r(code)),
    );
    this.child.stdout!.on("data", (chunk: Buffer) => {
      for (const m of this.reader.push(chunk) as any[]) {
        this.messages.push(m);
        if (m.type === "request") this.answer(m);
        for (const w of this.waiters.splice(0)) w();
      }
    });
  }

  hello(profileKey: string, version = 2): this {
    this.child.stdin!.write(
      encodeFrame({ type: "hello", version, profileKey }),
    );
    return this;
  }

  private answer(m: {
    id: number;
    tool: string;
    args: Record<string, unknown>;
  }) {
    let reply: unknown;
    try {
      reply = {
        type: "response",
        id: m.id,
        ok: true,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify(this.handler(m.tool, m.args ?? {})),
            },
          ],
        },
      };
    } catch (error) {
      reply = {
        type: "response",
        id: m.id,
        ok: false,
        error: (error as Error).message,
      };
    }
    if (!this.child.stdin!.destroyed)
      this.child.stdin!.write(encodeFrame(reply));
  }

  async next(type: string, timeoutMs = 5_000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.find((m) => m.type === type);
      if (found) return found;
      if (Date.now() > deadline)
        throw new Error(
          `no ${type} from the host: ${JSON.stringify(this.messages)}`,
        );
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, 50);
      });
    }
  }

  /** The switch goes off: Chrome closes the host's stdin. */
  async close(): Promise<void> {
    if (this.child.exitCode !== null) return;
    this.child.stdin!.end();
    await Promise.race([this.exited, new Promise((r) => setTimeout(r, 2_000))]);
    if (this.child.exitCode === null) this.child.kill("SIGKILL");
  }
}

const start = (env: NodeJS.ProcessEnv, handler?: Handler) => {
  const h = new FakeExtension(env, handler);
  hosts.push(h);
  return h;
};

/** A profile's tabs, as its extension would list them (`old`: an extension of 0.1.x, which says "pong" to `__` tools). */
const tabsOf =
  (ids: number[], old = false) =>
  (tool: string, args: Record<string, unknown>) => {
    if (tool.startsWith("__") && old) return "pong";
    if (tool === "__profile")
      return { profileKey: "k", profileLabel: `label-${ids[0]}` };
    if (tool === "__tabs") return ids.map((tabId) => ({ tabId, windowId: 1 }));
    if (tool === "bridge_info")
      return {
        profileLabel: `label-${ids[0]}`,
        windows: 1,
        tabs: ids.length,
        containers: 0,
        extensionVersion: "0.2.0",
      };
    if (tool === "list_tabs")
      return ids.map((tabId) => ({ tabId, windowId: 1, title: `t${tabId}` }));
    if (tool === "list_containers") return [];
    if (typeof args.tabId === "number") {
      if (!ids.includes(args.tabId))
        throw new Error(
          `no tab with id ${args.tabId} (it may have been closed; call list_tabs)`,
        );
      return { tabId: args.tabId, done: tool, in: ids[0] };
    }
    return { tool };
  };

describe("the host, one per Chrome profile", () => {
  it("with hello: listens on bridges/<key>.sock (0600 in a 0700 directory), says ready v2, counts profiles; removes its socket when switched off", async () => {
    const dir = tmp();
    const env = { FACET_BRIDGE_SOCKET: path.join(dir, "bridge.sock") };
    const a = start(env).hello("aaaaaaaaaa");
    const ready = await a.next("ready");
    const sock = path.join(dir, "bridges", "aaaaaaaaaa.sock");
    expect(ready).toEqual({
      type: "ready",
      version: 2,
      socket: sock,
      profileKey: "aaaaaaaaaa",
      session: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
    expect(statSync(sock).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(dir, "bridges")).mode & 0o777).toBe(0o700);
    expect(existsSync(path.join(dir, "bridge.sock"))).toBe(false);
    expect((await a.next("profiles")).count).toBe(1);

    const b = start(env).hello("bbbbbbbbbb");
    expect((await b.next("ready")).socket).toBe(
      path.join(dir, "bridges", "bbbbbbbbbb.sock"),
    );
    expect((await b.next("profiles")).count).toBe(2);

    await b.close();
    expect(existsSync(path.join(dir, "bridges", "bbbbbbbbbb.sock"))).toBe(
      false,
    );
    expect(existsSync(sock)).toBe(true);
  });

  it("a second host for the same key says busy (same-profile) and leaves the live one alone", async () => {
    const dir = tmp();
    const env = { FACET_BRIDGE_SOCKET: path.join(dir, "bridge.sock") };
    const a = start(env).hello("aaaaaaaaaa");
    await a.next("ready");
    const again = start(env).hello("aaaaaaaaaa");
    expect(await again.next("busy")).toMatchObject({ code: "same-profile" });
    expect(await again.exited).toBe(0);
    expect(existsSync(path.join(dir, "bridges", "aaaaaaaaaa.sock"))).toBe(true);
  });

  it("a malformed key is refused before anything is created", async () => {
    const dir = tmp();
    const h = start({
      FACET_BRIDGE_SOCKET: path.join(dir, "bridge.sock"),
    }).hello("../evil");
    expect((await h.next("fatal")).message).toMatch(/bad hello/);
    expect(existsSync(path.join(dir, "bridges"))).toBe(false);
  });

  it("without hello (an extension of 0.1.x): the one shared bridge.sock, ready v1, and another such profile is busy", async () => {
    const dir = tmp();
    const env = { FACET_BRIDGE_SOCKET: path.join(dir, "bridge.sock") };
    const old = start(env);
    const ready = await old.next("ready", 6_000);
    expect(ready).toEqual({
      type: "ready",
      version: 1,
      socket: path.join(dir, "bridge.sock"),
    });
    expect(old.messages.some((m) => m.type === "profiles")).toBe(false);
    const other = start(env);
    expect(await other.next("busy", 6_000)).toEqual({
      type: "busy",
      reason: "another Chrome profile is connected",
    });
  }, 15_000);
});

describe("the MCP server's dispatcher against real hosts", () => {
  it("two profiles at once: lists both, routes a tab tool to the profile that has the tab, refuses an unnamed open, and forgets a profile switched off", async () => {
    const dir = tmp();
    const env = {
      FACET_BRIDGE_SOCKET: path.join(dir, "bridge.sock"),
      FACET_BRIDGE_MANIFEST_DIRS: path.join(dir, "none"),
    };
    const a = start(env, tabsOf([1, 2])).hello("aaaaaaaaaa");
    const b = start(env, tabsOf([3])).hello("bbbbbbbbbb");
    await a.next("ready");
    await b.next("ready");
    const d = liveDispatcher(env);

    const listed = JSON.parse(t0(await d.run("list_tabs", {})));
    expect(
      listed.map((t: any) => [t.tabId, t.profile.key, t.profile.label]),
    ).toEqual([
      [1, "aaaaaaaaaa", "label-1"],
      [2, "aaaaaaaaaa", "label-1"],
      [3, "bbbbbbbbbb", "label-3"],
    ]);
    const clicked = await d.run("click", { tabId: 3, ref: "e1" });
    expect(JSON.parse(t0(clicked))).toMatchObject({
      done: "click",
      in: 3,
    });
    expect(
      b.messages.filter((m) => m.type === "request" && m.tool === "click"),
    ).toHaveLength(1);
    expect(
      a.messages.filter((m) => m.type === "request" && m.tool === "click"),
    ).toHaveLength(0);

    const open = await d.run("open_in_container", {
      url: "https://x.test/",
      container: "c",
    });
    expect(open.isError).toBe(true);
    expect(t0(open)).toMatch(
      /Several Chrome profiles .*"label-1" \(key aaaaaaaaaa\), "label-3" \(key bbbbbbbbbb\)/,
    );
    const opened = await d.run("open_tab", {
      url: "about:blank",
      profile: "label-3",
    });
    expect(opened.isError).toBeUndefined();
    const req = b.messages.find(
      (m) => m.type === "request" && m.tool === "open_tab",
    );
    expect(req.args).toEqual({ url: "about:blank" }); // `profile` is the MCP server's own

    await b.close();
    const after = JSON.parse(t0(await d.run("list_tabs", {})));
    expect(after.map((t: any) => t.tabId)).toEqual([1, 2]);
    // One profile left: an open needs no profile any more.
    expect(
      (await d.run("open_tab", { url: "about:blank" })).isError,
    ).toBeUndefined();
    await a.close();
    const none = await d.run("list_tabs", {});
    expect(none.isError).toBe(true);
    expect(t0(none)).toMatch(/not installed|is off/);
  });

  it("every answer carries the host's session; the profile's next host has a new one, and a tab ID seen under the old one is refused as stale", async () => {
    const dir = tmp();
    const env = {
      FACET_BRIDGE_SOCKET: path.join(dir, "bridge.sock"),
      FACET_BRIDGE_MANIFEST_DIRS: path.join(dir, "none"),
    };
    const first = start(env, tabsOf([7])).hello("aaaaaaaaaa");
    const s1 = (await first.next("ready")).session;
    const d = liveDispatcher(env);
    await d.run("list_tabs", {});
    expect(
      (await d.run("click", { tabId: 7, ref: "e1" })).isError,
    ).toBeUndefined();
    await first.close();
    // Chrome restarted: a new host for the same profile, and tab 7 is now another page.
    const second = start(env, tabsOf([7])).hello("aaaaaaaaaa");
    const s2 = (await second.next("ready")).session;
    expect(s2).not.toBe(s1);
    const r = await d.run("click", { tabId: 7, ref: "e1" });
    expect(r.isError).toBe(true);
    expect(t0(r)).toMatch(/stale tab id 7/);
    expect(
      second.messages.filter((m) => m.type === "request" && m.tool === "click"),
    ).toHaveLength(0);
    await d.run("list_tabs", {});
    expect(
      (await d.run("click", { tabId: 7, ref: "e1" })).isError,
    ).toBeUndefined();
  });

  it("an old extension on the shared socket and a new one on its own socket are both reachable", async () => {
    const dir = tmp();
    const env = {
      FACET_BRIDGE_SOCKET: path.join(dir, "bridge.sock"),
      FACET_BRIDGE_MANIFEST_DIRS: path.join(dir, "none"),
    };
    const fresh = start(env, tabsOf([10])).hello("aaaaaaaaaa");
    const old = start(env, tabsOf([20], true));
    await fresh.next("ready");
    await old.next("ready", 6_000);
    const d = liveDispatcher(env);
    const info = JSON.parse(t0(await d.run("bridge_info", {})));
    expect(
      info.profiles.map((p: any) => [p.profileKey, p.legacy ?? false]),
    ).toEqual([
      ["aaaaaaaaaa", false],
      ["legacy", true],
    ]);
    expect(info.legacyNote).toMatch(/0\.1\.x/);
    const r = await d.run("get_tab_text", { tabId: 20 });
    expect(JSON.parse(t0(r))).toMatchObject({ in: 20 });
  }, 15_000);
});
