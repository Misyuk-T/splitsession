import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ClientResponse } from "../../src/bridge/protocol";
import { UsageError } from "./cli";
import { Dispatcher, Unreachable } from "./dispatch";
import { liveDispatcher } from "./mcp";
import { BRIDGE_DIR_ENV, MANIFEST_DIRS_ENV, SOCKET_ENV } from "./paths";
import type { Endpoint } from "./profiles";
import { isExampleCom, parseTryArgs, runTry } from "./try";

const SECRET_TITLE = "Inbox (3) - private mail";
const SECRET_URL = "https://mail.example.org/u/0/#inbox/secret-thread";

interface Tab {
  tabId: number;
  title: string;
  url: string;
  container: { id: string; name: string } | null;
}

const TABS: Tab[] = [
  { tabId: 1, title: SECRET_TITLE, url: SECRET_URL, container: null },
  {
    tabId: 2,
    title: "Example Domain",
    url: "https://example.com/",
    container: { id: "c1", name: "Work" },
  },
  {
    tabId: 3,
    title: "Bank",
    url: "https://bank.example.org/account/42",
    container: { id: "c1", name: "Work" },
  },
  {
    tabId: 4,
    title: "Not it",
    url: "https://example.com.evil.org/",
    container: { id: "c2", name: "Home" },
  },
  {
    tabId: 5,
    title: "Not it either",
    url: "https://sub.example.com/",
    container: null,
  },
  {
    tabId: 6,
    title: "Plain",
    url: "http://example.com/x?y=1",
    container: null,
  },
];

const ep = (key: string): Endpoint => ({
  key,
  socket: `/b/${key}.sock`,
  legacy: false,
  ino: 1,
});

const text = (...blocks: string[]): ClientResponse => ({
  id: 1,
  ok: true,
  result: { content: blocks.map((t) => ({ type: "text", text: t })) },
});
const json = (v: unknown) => text(JSON.stringify(v));

/** A fake extension behind each endpoint; records every call. */
function world(keys: string[]) {
  const calls: Array<{ key: string; tool: string; args: any }> = [];
  const gone: string[] = [];
  const d = new Dispatcher({
    discover: () => keys.map(ep),
    unreachable: () => "bridge is off — turn it on in SplitSession Settings",
    gone: (e) => gone.push(e.key),
    call: async (e, tool, args) => {
      calls.push({ key: e.key, tool, args });
      if (tool === "__profile")
        return json({ profileKey: e.key, profileLabel: `P-${e.key}` });
      if (tool === "__tabs")
        return json(TABS.map((t) => ({ tabId: t.tabId, windowId: 1 })));
      if (tool === "bridge_info")
        return json({
          profileLabel: `P-${e.key}`,
          windows: 2,
          tabs: TABS.length,
          containers: 2,
          extensionVersion: "0.2.0",
          mode: "basic",
        });
      if (tool === "list_containers")
        return json([
          { id: "c1", name: "Work", color: "blue", tabCount: 2 },
          { id: "c2", name: "Home", color: "red", tabCount: 1 },
        ]);
      if (tool === "list_tabs") return json(TABS);
      if (tool === "get_tab_text") {
        if (args.tabId !== 2) return { id: 1, ok: false, error: "no such tab" };
        return text(
          JSON.stringify({
            tabId: 2,
            url: "https://example.com/",
            title: "Example Domain",
          }),
          "Example Domain\n\nThis domain is for use in illustrative examples in documents.",
        );
      }
      if (tool === "snapshot")
        return text(
          JSON.stringify({ tabId: 2 }),
          [
            '- heading "Example Domain" [ref=e1]',
            "- paragraph:",
            '  - text "This domain is for use"',
            '- link "Learn more" [ref=e2] /url=https://iana.org/domains/example',
          ].join("\n"),
        );
      throw new Unreachable("ECONNREFUSED");
    },
  });
  return { d, calls, gone };
}

async function run(
  keys: string[],
  args: string[],
  w = world(keys),
): Promise<{ code: number; out: string; w: ReturnType<typeof world> }> {
  const lines: string[] = [];
  const code = await runTry(parseTryArgs(args), w.d, {
    log: (l) => lines.push(l),
    version: "9.9.9",
  });
  return { code, out: lines.join("\n"), w };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("try: arguments", () => {
  it("parses --profile and --tab, with = or a space", () => {
    expect(parseTryArgs([])).toEqual({});
    expect(parseTryArgs(["--tab", "12", "--profile", "Work"])).toEqual({
      tab: 12,
      profile: "Work",
    });
    expect(parseTryArgs(["--tab", "1650728899"]).tab).toBe(1650728899);
    expect(parseTryArgs(["--tab=7", "--profile=k1"])).toEqual({
      tab: 7,
      profile: "k1",
    });
  });
  it("refuses a bad tab ID, a missing value and unknown options", () => {
    for (const bad of [
      ["--tab", "abc"],
      ["--tab", "-1"],
      ["--tab"],
      ["--profile"],
      ["--click", "e1"],
    ])
      expect(() => parseTryArgs(bad)).toThrow(UsageError);
  });
});

describe("try: report", () => {
  it("one PASS line per step, exit code 0", async () => {
    const { code, out } = await run(["k1"], []);
    expect(code).toBe(0);
    expect(out).toContain(
      'PASS  bridge_info: profile "P-k1" (key k1): extension 0.2.0, mode basic, 2 windows, 6 tabs, 2 containers',
    );
    expect(out).toContain(
      "PASS  list_containers: 2 containers: Work (blue), Home (red)",
    );
    expect(out).toContain(
      "PASS  list_tabs: 6 tabs (2 in Work, 1 in Home, 3 outside containers)",
    );
    expect(out).toMatch(/PASS: the bridge works/);
    expect(out).not.toMatch(/FAIL/);
  });

  it("without --tab: a hint, and the IDs of tabs whose host is exactly example.com (nothing else about other tabs)", async () => {
    const { out } = await run(["k1"], []);
    expect(out).toContain("tabs on example.com: tab 2 (container Work), tab 6");
    expect(out).not.toContain("tab 4");
    expect(out).not.toContain("tab 5");
    expect(out).not.toMatch(/tab 1[^0-9]/);
  });

  it("without example.com open: says how to open one", async () => {
    const w = world(["k1"]);
    const saved = TABS.splice(0, TABS.length, TABS[0]!);
    try {
      const { out } = await run(["k1"], [], w);
      expect(out).toContain("open https://example.com");
    } finally {
      TABS.splice(0, TABS.length, ...saved);
    }
  });

  it("never prints a title or URL of a tab, with or without --tab", async () => {
    for (const args of [[], ["--tab", "2"]]) {
      const { out } = await run(["k1"], args);
      for (const secret of [
        SECRET_TITLE,
        SECRET_URL,
        "mail.example.org",
        "Bank",
        "bank.example.org",
        "evil.org",
        "sub.example.com",
        "x?y=1",
      ])
        expect(out).not.toContain(secret);
    }
  });

  it("runs only read-only tools: no click, type, navigate, open or close", async () => {
    const { w } = await run(["k1"], ["--tab", "2"]);
    const allowed = new Set([
      "__profile",
      "__tabs",
      "bridge_info",
      "list_containers",
      "list_tabs",
      "get_tab_text",
      "snapshot",
    ]);
    for (const c of w.calls) expect(allowed.has(c.tool)).toBe(true);
  });
});

describe("try: --tab", () => {
  it("reads the text (200 chars at most asked for) and the snapshot of that tab only", async () => {
    const { code, out, w } = await run(["k1"], ["--tab", "2"]);
    expect(code).toBe(0);
    expect(out).toContain(
      'PASS  get_tab_text: tab 2: "Example Domain This domain is for use in illustrative examples in documents."',
    );
    expect(out).toContain("PASS  snapshot: tab 2: 2 elements with a ref");
    expect(out).toContain('- heading "Example Domain" [ref=e1]');
    expect(out).not.toContain("hint:");
    const reads = w.calls.filter(
      (c) => c.tool === "get_tab_text" || c.tool === "snapshot",
    );
    expect(reads.map((c) => c.args.tabId)).toEqual([2, 2]);
    expect(w.calls.find((c) => c.tool === "get_tab_text")!.args.maxChars).toBe(
      200,
    );
  });

  it("cuts a long text to about 200 characters and a long snapshot to 10 lines", async () => {
    const w = world(["k1"]);
    const orig = w.d.run.bind(w.d);
    w.d.run = async (name, args) =>
      name === "get_tab_text"
        ? {
            content: [
              { type: "text", text: "{}" },
              { type: "text", text: "x".repeat(900) },
            ],
          }
        : name === "snapshot"
          ? {
              content: [
                { type: "text", text: "{}" },
                {
                  type: "text",
                  text: Array.from(
                    { length: 40 },
                    (_, i) => `- button "b${i}" [ref=e${i}]`,
                  ).join("\n"),
                },
              ],
            }
          : orig(name, args);
    const { out } = await run(["k1"], ["--tab", "2"], w);
    expect(out).toMatch(/get_tab_text: tab 2: "x{200}…"/);
    expect(out).toContain("40 elements with a ref");
    expect(out).toContain('"b9"');
    expect(out).not.toContain('"b10"');
  });

  it("a tab that does not exist is a FAIL with the extension's reason, exit code 1", async () => {
    const { code, out } = await run(["k1"], ["--tab", "99"]);
    expect(code).toBe(1);
    expect(out).toMatch(/FAIL {2}get_tab_text: .*no tab with id 99/);
    expect(out).toMatch(/FAIL {2}snapshot: /);
    expect(out).toMatch(/\nFAIL$/);
  });
});

describe("try: failures", () => {
  it("nothing connected: FAIL with the message that says what to do, exit 1", async () => {
    const { code, out } = await run([], []);
    expect(code).toBe(1);
    expect(out).toContain(
      "FAIL  bridge_info: bridge is off — turn it on in SplitSession Settings",
    );
  });

  it("several profiles without --profile: lists them, then FAILs and asks for --profile", async () => {
    const { code, out, w } = await run(["k1", "k2"], []);
    expect(code).toBe(1);
    expect(out).toContain('profile "P-k1" (key k1)');
    expect(out).toContain('profile "P-k2" (key k2)');
    expect(out).toMatch(/FAIL {2}profile: 2 Chrome profiles .* --profile/);
    expect(w.calls.some((c) => c.tool === "list_tabs")).toBe(false);
  });

  it("several profiles with --profile: the steps run for that one only", async () => {
    const { code, out, w } = await run(["k1", "k2"], ["--profile", "P-k2"]);
    expect(code).toBe(0);
    expect(out).toContain('profile "P-k2" (key k2)');
    expect(out).not.toContain("(key k1)");
    expect(
      w.calls.filter((c) => c.tool === "list_tabs").map((c) => c.key),
    ).toEqual(["k2"]);
  });

  it("an unknown --profile: FAIL with the connected ones", async () => {
    const { code, out } = await run(["k1"], ["--profile", "nope"]);
    expect(code).toBe(1);
    expect(out).toMatch(
      /FAIL {2}bridge_info: No connected Chrome profile is named "nope"/,
    );
  });
});

describe("try: example.com host", () => {
  it("only exactly example.com over http(s)", () => {
    expect(isExampleCom("https://example.com/")).toBe(true);
    expect(isExampleCom("http://example.com/a?b")).toBe(true);
    for (const no of [
      "https://example.com.evil.org/",
      "https://sub.example.com/",
      "https://notexample.com/",
      "https://evil.org/example.com",
      "file:///example.com",
      "chrome://example.com/",
      "",
      undefined,
    ])
      expect(isExampleCom(no)).toBe(false);
  });
});

describe("try: writes nothing", () => {
  /** A socket file whose host is gone: a child process binds it and is killed, so the file stays. */
  async function staleSocket(file: string): Promise<void> {
    const child = spawn(process.execPath, [
      "-e",
      `require("net").createServer().listen(${JSON.stringify(file)}, () => console.log("up"))`,
    ]);
    await new Promise<void>((resolve) =>
      child.stdout.once("data", () => resolve()),
    );
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    const old = new Date(Date.now() - 60_000);
    utimesSync(file, old, old);
  }

  const setup = async () => {
    const root = mkdtempSync(path.join("/tmp", "ts-"));
    dirs.push(root);
    const bridges = path.join(root, "bridges");
    mkdirSync(bridges);
    const sock = path.join(bridges, "dddddddddd.sock");
    await staleSocket(sock);
    const env = {
      [SOCKET_ENV]: path.join(root, "bridge.sock"),
      [BRIDGE_DIR_ENV]: bridges,
      [MANIFEST_DIRS_ENV]: path.join(root, "none"),
    };
    return { sock, env };
  };

  it("leaves a stale socket file alone (try) where the MCP server removes it", async () => {
    const { sock, env } = await setup();
    const lines: string[] = [];
    const code = await runTry({}, liveDispatcher(env, { name: "" }, false), {
      log: (l) => lines.push(l),
    });
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/FAIL {2}bridge_info: /);
    expect(existsSync(sock)).toBe(true);

    // The control: the MCP server's dispatcher does clean it up, so the test above proves something.
    await liveDispatcher(env, { name: "" }).run("list_tabs", {});
    for (let i = 0; i < 40 && existsSync(sock); i += 1)
      await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(sock)).toBe(false);
  });
});
