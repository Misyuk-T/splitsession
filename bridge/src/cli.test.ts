import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { EXTENSION_ID } from "../../src/bridge/protocol";
import {
  buildHostManifest,
  buildLauncher,
  clientSnippets,
  type Env,
  HOST_ENTRY_FILE,
  install,
  LAUNCHER_FILE,
  parseArgs,
  resolveClients,
  type Runner,
  status,
  uninstall,
  UsageError,
} from "./cli";
import {
  browsersFor,
  HOST_MANIFEST_FILE,
  hostDir,
  manifestDir,
  socketDir,
} from "./paths";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), "ssb-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("paths per browser and platform", () => {
  it("macOS: Application Support, one folder per browser", () => {
    const base = "/Users/me/Library/Application Support";
    const dir = (b: Parameters<typeof manifestDir>[0]) =>
      manifestDir(b, "/Users/me", "darwin", {});
    expect(dir("chrome")).toBe(`${base}/Google/Chrome/NativeMessagingHosts`);
    expect(dir("chromium")).toBe(`${base}/Chromium/NativeMessagingHosts`);
    expect(dir("brave")).toBe(
      `${base}/BraveSoftware/Brave-Browser/NativeMessagingHosts`,
    );
    expect(dir("edge")).toBe(`${base}/Microsoft Edge/NativeMessagingHosts`);
    expect(dir("arc")).toBe(`${base}/Arc/User Data/NativeMessagingHosts`);
    expect(hostDir("/Users/me", "darwin", {})).toBe(
      `${base}/SplitSession/host`,
    );
    expect(socketDir("/Users/me", "darwin", {})).toBe(`${base}/SplitSession`);
  });

  it("Linux: the XDG config directory, no Arc", () => {
    const dir = (b: Parameters<typeof manifestDir>[0], env = {}) =>
      manifestDir(b, "/home/me", "linux", env);
    expect(dir("chrome")).toBe(
      "/home/me/.config/google-chrome/NativeMessagingHosts",
    );
    expect(dir("chromium")).toBe(
      "/home/me/.config/chromium/NativeMessagingHosts",
    );
    expect(dir("edge")).toBe(
      "/home/me/.config/microsoft-edge/NativeMessagingHosts",
    );
    expect(dir("chrome", { XDG_CONFIG_HOME: "/x/cfg" })).toBe(
      "/x/cfg/google-chrome/NativeMessagingHosts",
    );
    // A relative XDG_CONFIG_HOME is ignored, as the spec says.
    expect(dir("chrome", { XDG_CONFIG_HOME: "rel" })).toBe(
      "/home/me/.config/google-chrome/NativeMessagingHosts",
    );
    expect(hostDir("/home/me", "linux", {})).toBe(
      "/home/me/.config/SplitSession/host",
    );
    expect(browsersFor("linux")).not.toContain("arc");
    expect(browsersFor("darwin")).toContain("arc");
  });
});

describe("host manifest and launcher", () => {
  it("allows exactly the given extension IDs", () => {
    const m = buildHostManifest("/h/launcher", [EXTENSION_ID]);
    expect(m).toMatchObject({
      name: "com.splitsession.bridge",
      path: "/h/launcher",
      type: "stdio",
      allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
    });
    expect(
      buildHostManifest("/h/launcher", ["a".repeat(32), "b".repeat(32)])
        .allowed_origins,
    ).toEqual([
      `chrome-extension://${"a".repeat(32)}/`,
      `chrome-extension://${"b".repeat(32)}/`,
    ]);
  });

  it("the launcher pins node and passes the allowed origins to the host", () => {
    const script = buildLauncher("/opt/node v/bin/node", "/h/bridge.mjs", [
      EXTENSION_ID,
    ]);
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).toContain(
      `exec '/opt/node v/bin/node' /h/bridge.mjs host --allow-origin=chrome-extension://${EXTENSION_ID}/ "$@"`,
    );
  });
});

describe("AI client snippets", () => {
  const s = clientSnippets("/usr/bin/node", "/h/splitsession-bridge.mjs");
  it("Claude Code", () => {
    expect(s.claude).toBe(
      "claude mcp add --scope user splitsession -- /usr/bin/node /h/splitsession-bridge.mjs mcp",
    );
  });
  it("Codex (TOML)", () => {
    expect(s.codex).toBe(
      [
        "[mcp_servers.splitsession]",
        'command = "/usr/bin/node"',
        'args = ["/h/splitsession-bridge.mjs","mcp"]',
      ].join("\n"),
    );
  });
  it("Cursor (JSON)", () => {
    expect(JSON.parse(s.cursor)).toEqual({
      mcpServers: {
        splitsession: {
          command: "/usr/bin/node",
          args: ["/h/splitsession-bridge.mjs", "mcp"],
        },
      },
    });
  });
  it("Claude Desktop, Gemini CLI (mcpServers) and VS Code (servers + type stdio)", () => {
    const entry = {
      command: "/usr/bin/node",
      args: ["/h/splitsession-bridge.mjs", "mcp"],
    };
    expect(JSON.parse(s["claude-desktop"])).toEqual({
      mcpServers: { splitsession: entry },
    });
    expect(JSON.parse(s.gemini)).toEqual({
      mcpServers: { splitsession: entry },
    });
    expect(JSON.parse(s.vscode)).toEqual({
      servers: { splitsession: { type: "stdio", ...entry } },
    });
  });
  it("quotes paths with spaces for the shell and escapes them in TOML and JSON", () => {
    const q = clientSnippets(
      "/n/node",
      "/Users/me/Library/Application Support/x.mjs",
    );
    expect(q.claude).toContain("'/Users/me/Library/Application Support/x.mjs'");
    expect(q.codex).toContain('"/Users/me/Library/Application Support/x.mjs"');
  });
});

describe("argument parsing", () => {
  it("defaults: install -> chrome, no --client given, the Full extension", () => {
    const o = parseArgs(["install"], "darwin");
    expect(o).toMatchObject({
      command: "install",
      browsers: ["chrome"],
      extensionIds: [EXTENSION_ID],
    });
    expect(o.clients).toBeUndefined();
  });
  it("--client takes a list, all and none", () => {
    const clients = (...a: string[]) =>
      parseArgs(["install", ...a], "linux").clients;
    expect(clients("--client", "claude,codex")).toEqual(["claude", "codex"]);
    expect(clients("--client", "vscode", "--client=gemini,vscode")).toEqual([
      "vscode",
      "gemini",
    ]);
    expect(clients("--client", "all")).toEqual([
      "claude",
      "codex",
      "cursor",
      "claude-desktop",
      "gemini",
      "vscode",
    ]);
    expect(clients("--client", "none")).toEqual([]);
    expect(() => clients("--client", "none,codex")).toThrow(
      /cannot be combined/,
    );
  });
  it("uninstall and status default to every browser of the platform", () => {
    expect(parseArgs(["uninstall"], "linux").browsers).toEqual([
      "chrome",
      "chromium",
      "brave",
      "edge",
    ]);
    expect(parseArgs(["status"], "darwin").browsers).toContain("arc");
  });
  it("takes --flag value, --flag=value, repeats and commas", () => {
    const o = parseArgs(
      [
        "install",
        "--browser",
        "brave,edge",
        "--browser=arc",
        "--client=codex",
        "--extension-id",
        "p".repeat(32),
      ],
      "darwin",
    );
    expect(o.browsers).toEqual(["brave", "edge", "arc"]);
    expect(o.clients).toEqual(["codex"]);
    expect(o.extensionIds).toEqual(["p".repeat(32)]);
  });
  it("rejects what it cannot honour", () => {
    expect(() => parseArgs(["frobnicate"])).toThrow(UsageError);
    expect(() =>
      parseArgs(["install", "--browser", "firefox"], "darwin"),
    ).toThrow(/unknown browser/);
    expect(() => parseArgs(["install", "--browser", "arc"], "linux")).toThrow(
      /not available/,
    );
    expect(() => parseArgs(["install", "--extension-id", "nope"])).toThrow(
      /not an extension ID/,
    );
    expect(() => parseArgs(["install", "--client", "vim"])).toThrow(
      /unknown client/,
    );
    expect(() => parseArgs(["install", "--client"])).toThrow(/needs a value/);
    expect(() => parseArgs(["install", "--wat"])).toThrow(/unknown option/);
  });
});

/** A sandbox: a fake home, a fake bundle to copy, and a recording runner for `claude`. */
function sandbox(runner?: Runner) {
  const root = tmp();
  const source = path.join(root, "bundle.mjs");
  writeFileSync(source, "// the bridge\n");
  const out: string[] = [];
  const calls: string[][] = [];
  const run: Runner =
    runner ??
    ((command, args) => {
      calls.push([command, ...args]);
      return { status: 0, stdout: "", stderr: "" };
    });
  const env: Env = {
    log: (l) => out.push(l),
    run: (c, a) => {
      if (runner) calls.push([c, ...a]);
      return run(c, a);
    },
    home: path.join(root, "home"),
    platform: "linux",
    node: "/usr/bin/node",
    sourceEntry: source,
    version: "9.9.9",
    process: {},
  };
  return { root, env, out, calls, text: () => out.join("\n") };
}

describe("install / uninstall", () => {
  it("writes the host copy, the launcher and a manifest per browser, and registers with Claude Code", () => {
    const sb = sandbox();
    const options = parseArgs(
      ["install", "--browser", "chrome,brave", "--client", "claude"],
      "linux",
    );
    expect(install(options, sb.env)).toBe(0);

    const host = hostDir(sb.env.home, "linux", {});
    expect(readFileSync(path.join(host, HOST_ENTRY_FILE), "utf8")).toBe(
      "// the bridge\n",
    );
    const launcher = path.join(host, LAUNCHER_FILE);
    expect(statSync(launcher).mode & 0o111).not.toBe(0);
    expect(readFileSync(launcher, "utf8")).toContain("/usr/bin/node");

    for (const b of ["chrome", "brave"] as const) {
      const file = path.join(
        manifestDir(b, sb.env.home, "linux", {}),
        HOST_MANIFEST_FILE,
      );
      expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
        name: "com.splitsession.bridge",
        path: launcher,
        allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
      });
    }
    // claude: probed, the old registration removed, the new one added with the host copy.
    expect(sb.calls).toEqual([
      ["claude", "--version"],
      ["claude", "mcp", "remove", "--scope", "user", "splitsession"],
      [
        "claude",
        "mcp",
        "add",
        "--scope",
        "user",
        "splitsession",
        "--",
        "/usr/bin/node",
        path.join(host, HOST_ENTRY_FILE),
        "mcp",
      ],
    ]);
    expect(sb.text()).toContain("registered");
  });

  it("is idempotent", () => {
    const sb = sandbox();
    const options = parseArgs(["install", "--client", "claude"], "linux");
    expect(install(options, sb.env)).toBe(0);
    const manifest = path.join(
      manifestDir("chrome", sb.env.home, "linux", {}),
      HOST_MANIFEST_FILE,
    );
    const first = readFileSync(manifest, "utf8");
    expect(install(options, sb.env)).toBe(0);
    expect(readFileSync(manifest, "utf8")).toBe(first);
  });

  it("prints the Claude command when `claude` is missing, and installs anyway", () => {
    const sb = sandbox(() => ({ status: null, stdout: "", stderr: "" }));
    expect(
      install(parseArgs(["install", "--client", "claude"], "linux"), sb.env),
    ).toBe(0);
    expect(sb.text()).toContain(
      "claude mcp add --scope user splitsession -- /usr/bin/node",
    );
    expect(sb.calls).toEqual([["claude", "--version"]]);
  });

  it("prints a failed `claude mcp add` with its reason", () => {
    const sb = sandbox((_c, args) =>
      args[0] === "mcp" && args[1] === "add"
        ? { status: 1, stdout: "", stderr: "boom" }
        : { status: 0, stdout: "", stderr: "" },
    );
    expect(
      install(parseArgs(["install", "--client", "claude"], "linux"), sb.env),
    ).toBe(0);
    expect(sb.text()).toMatch(/failed: boom/);
    expect(sb.text()).toContain("claude mcp add --scope user splitsession");
  });

  it("without --client nothing is registered: no commands, no files, every snippet printed", () => {
    const sb = sandbox();
    install(parseArgs(["install"], "linux"), sb.env);
    expect(sb.calls).toEqual([]);
    expect(existsSync(path.join(sb.env.home ?? "", ".cursor"))).toBe(false);
    for (const needle of [
      "claude mcp add",
      "[mcp_servers.splitsession]",
      "~/.cursor/mcp.json",
      "~/.gemini/settings.json",
      "claude_desktop_config.json",
      "mcp.json",
      '"mcpServers"',
      '"servers"',
    ])
      expect(sb.text()).toContain(needle);
  });

  it("--client writes each client's config file and prints nothing to add", () => {
    const sb = sandbox(() => ({ status: null, stdout: "", stderr: "" })); // no claude, no codex
    sb.env.platform = "darwin";
    const home = sb.env.home ?? "";
    install(
      parseArgs(
        ["install", "--client", "codex,cursor,gemini,vscode,claude-desktop"],
        "darwin",
      ),
      sb.env,
    );
    const entry = path.join(hostDir(home, "darwin", {}), HOST_ENTRY_FILE);
    const mcp = { command: "/usr/bin/node", args: [entry, "mcp"] };
    const json = (...p: string[]) =>
      JSON.parse(readFileSync(path.join(home, ...p), "utf8"));
    expect(json(".cursor", "mcp.json")).toEqual({
      mcpServers: { splitsession: mcp },
    });
    expect(json(".gemini", "settings.json")).toEqual({
      mcpServers: { splitsession: mcp },
    });
    expect(
      json(
        "Library",
        "Application Support",
        "Claude",
        "claude_desktop_config.json",
      ),
    ).toEqual({ mcpServers: { splitsession: mcp } });
    expect(
      json("Library", "Application Support", "Code", "User", "mcp.json"),
    ).toEqual({
      servers: { splitsession: { type: "stdio", ...mcp } },
    });
    expect(
      readFileSync(path.join(home, ".codex", "config.toml"), "utf8"),
    ).toContain("[mcp_servers.splitsession]");
    expect(sb.text()).not.toContain("add this to");
  });

  it("--client codex uses `codex mcp add` when the codex CLI is there", () => {
    const sb = sandbox();
    install(parseArgs(["install", "--client", "codex"], "linux"), sb.env);
    const entry = path.join(hostDir(sb.env.home, "linux", {}), HOST_ENTRY_FILE);
    expect(sb.calls).toEqual([
      ["codex", "mcp", "add", "--help"],
      ["codex", "mcp", "remove", "splitsession"],
      [
        "codex",
        "mcp",
        "add",
        "splitsession",
        "--",
        "/usr/bin/node",
        entry,
        "mcp",
      ],
    ]);
    expect(existsSync(path.join(sb.env.home ?? "", ".codex"))).toBe(false);
  });

  it("a config it cannot edit safely is left alone and the snippet is printed", () => {
    const sb = sandbox();
    const file = path.join(sb.env.home ?? "", ".cursor", "mcp.json");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '// my servers\n{ "mcpServers": {} }\n');
    install(parseArgs(["install", "--client", "cursor"], "linux"), sb.env);
    expect(readFileSync(file, "utf8")).toBe(
      '// my servers\n{ "mcpServers": {} }\n',
    );
    expect(sb.text()).toContain("not plain JSON");
    expect(sb.text()).toContain("Cursor: add this to ~/.cursor/mcp.json");
  });

  it("a custom extension ID goes into the manifest and the launcher", () => {
    const sb = sandbox();
    const id = "k".repeat(32);
    install(
      parseArgs(["install", "--extension-id", id, "--client", "none"], "linux"),
      sb.env,
    );
    const host = hostDir(sb.env.home, "linux", {});
    const manifest = JSON.parse(
      readFileSync(
        path.join(
          manifestDir("chrome", sb.env.home, "linux", {}),
          HOST_MANIFEST_FILE,
        ),
        "utf8",
      ),
    );
    expect(manifest.allowed_origins).toEqual([`chrome-extension://${id}/`]);
    expect(readFileSync(path.join(host, LAUNCHER_FILE), "utf8")).toContain(
      `--allow-origin=chrome-extension://${id}/`,
    );
  });

  it("--dir / --host-dir keep everything inside the given folders", () => {
    const sb = sandbox();
    const dir = path.join(sb.root, "native");
    const hostDirectory = path.join(sb.root, "hostcopy");
    install(
      parseArgs(
        [
          "install",
          "--client",
          "none",
          "--dir",
          dir,
          "--host-dir",
          hostDirectory,
        ],
        "linux",
      ),
      sb.env,
    );
    expect(existsSync(path.join(dir, HOST_MANIFEST_FILE))).toBe(true);
    expect(existsSync(path.join(hostDirectory, HOST_ENTRY_FILE))).toBe(true);
    expect(existsSync(hostDir(sb.env.home, "linux", {}))).toBe(false);
  });

  it("uninstall removes the manifests and the host copy, and is safe to repeat", () => {
    const sb = sandbox();
    install(parseArgs(["install", "--client", "none"], "linux"), sb.env);
    const options = parseArgs(["uninstall"], "linux");
    expect(uninstall(options, sb.env)).toBe(0);
    expect(
      existsSync(
        path.join(
          manifestDir("chrome", sb.env.home, "linux", {}),
          HOST_MANIFEST_FILE,
        ),
      ),
    ).toBe(false);
    expect(existsSync(hostDir(sb.env.home, "linux", {}))).toBe(false);
    expect(uninstall(options, sb.env)).toBe(0);
    expect(sb.text()).toContain("facet"); // the old-name hint
  });

  it("uninstall removes only the splitsession entry from every client, with backups", () => {
    const sb = sandbox(() => ({ status: null, stdout: "", stderr: "" }));
    const home = sb.env.home ?? "";
    install(parseArgs(["install", "--client", "all"], "linux"), sb.env);
    // Add another server next to ours in Cursor's file.
    const cursor = path.join(home, ".cursor", "mcp.json");
    const doc = JSON.parse(readFileSync(cursor, "utf8"));
    doc.mcpServers.other = { command: "x", env: { TOKEN: "secret" } };
    writeFileSync(cursor, JSON.stringify(doc, null, 2));
    sb.out.length = 0;

    expect(uninstall(parseArgs(["uninstall"], "linux"), sb.env)).toBe(0);
    expect(JSON.parse(readFileSync(cursor, "utf8"))).toEqual({
      mcpServers: { other: { command: "x", env: { TOKEN: "secret" } } },
    });
    expect(sb.text()).not.toContain("secret");
    expect(
      readFileSync(path.join(home, ".codex", "config.toml"), "utf8"),
    ).not.toContain("splitsession");
    expect(sb.text()).toContain("Cursor: removed");
    expect(sb.text()).toContain("backup:");
    // Claude Code's file was never written (no CLI): nothing to remove there.
    expect(sb.text()).toContain("Claude Code: not registered");
  });

  it("uninstall with --dir / --host-dir leaves AI clients alone unless --client is given", () => {
    const sb = sandbox();
    const home = sb.env.home ?? "";
    install(parseArgs(["install", "--client", "cursor"], "linux"), sb.env);
    const scratch = [
      "--dir",
      path.join(sb.root, "n"),
      "--host-dir",
      path.join(sb.root, "h"),
    ];
    uninstall(parseArgs(["uninstall", ...scratch], "linux"), sb.env);
    expect(
      readFileSync(path.join(home, ".cursor", "mcp.json"), "utf8"),
    ).toContain("splitsession");
    uninstall(
      parseArgs(["uninstall", "--client", "cursor", ...scratch], "linux"),
      sb.env,
    );
    expect(
      readFileSync(path.join(home, ".cursor", "mcp.json"), "utf8"),
    ).not.toContain("splitsession");
  });

  it("also removes the leftovers of the old name (Facet)", () => {
    const sb = sandbox();
    const dir = path.join(sb.root, "native");
    const hostDirectory = path.join(sb.root, "hostcopy");
    mkdirSync(dir, { recursive: true });
    mkdirSync(hostDirectory, { recursive: true });
    writeFileSync(path.join(dir, "com.facet.bridge.json"), "{}");
    writeFileSync(path.join(hostDirectory, "facet-bridge.mjs"), "");
    install(
      parseArgs(
        [
          "install",
          "--client",
          "none",
          "--dir",
          dir,
          "--host-dir",
          hostDirectory,
        ],
        "linux",
      ),
      sb.env,
    );
    expect(existsSync(path.join(dir, "com.facet.bridge.json"))).toBe(false);
    expect(existsSync(path.join(hostDirectory, "facet-bridge.mjs"))).toBe(
      false,
    );
  });

  it("says Windows is not supported yet", () => {
    const sb = sandbox();
    sb.env.platform = "win32";
    expect(install(parseArgs(["install"], "win32"), sb.env)).toBe(1);
    expect(uninstall(parseArgs(["uninstall"], "win32"), sb.env)).toBe(1);
    expect(sb.text()).toContain("not supported yet");
    expect(existsSync(hostDir(sb.env.home, "win32", {}))).toBe(false);
  });
});

describe("status", () => {
  it("reports nothing installed, then installed", async () => {
    const sb = sandbox();
    sb.env.process = { FACET_BRIDGE_SOCKET: path.join(sb.root, "none.sock") };
    const options = parseArgs(["status", "--browser", "chrome"], "linux");
    expect(await status(options, sb.env)).toBe(1);
    expect(sb.text()).toContain("host program:  not installed");
    expect(sb.text()).toContain("chrome    not installed");
    expect(sb.text()).toContain("not there");

    sb.out.length = 0;
    install(parseArgs(["install", "--client", "none"], "linux"), {
      ...sb.env,
      process: {},
    });
    expect(
      await status(options, {
        ...sb.env,
        process: { FACET_BRIDGE_SOCKET: path.join(sb.root, "none.sock") },
      }),
    ).toBe(0);
    expect(sb.text()).toContain("host program:  installed");
    expect(sb.text()).toContain("chrome    installed");
    expect(sb.text()).toContain(`chrome-extension://${EXTENSION_ID}/`);
    expect(sb.text()).toContain("9.9.9");
  });

  it("lists which AI clients have it registered", async () => {
    const sb = sandbox();
    sb.env.process = { FACET_BRIDGE_SOCKET: path.join(sb.root, "none.sock") };
    install(parseArgs(["install", "--client", "cursor,gemini"], "linux"), {
      ...sb.env,
      process: {},
    });
    sb.out.length = 0;
    await status(parseArgs(["status", "--browser", "chrome"], "linux"), sb.env);
    expect(sb.text()).toMatch(/Cursor\s+registered: \/usr\/bin\/node/);
    expect(sb.text()).toMatch(/Gemini CLI\s+registered/);
    expect(sb.text()).toMatch(/Codex\s+not registered/);
    expect(sb.text()).toMatch(/VS Code\s+not registered/);

    // Pointing at some other program: flagged.
    const file = path.join(sb.env.home ?? "", ".gemini", "settings.json");
    writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          splitsession: { command: "n", args: ["/old.mjs", "mcp"] },
        },
      }),
    );
    sb.out.length = 0;
    await status(parseArgs(["status", "--client", "gemini"], "linux"), sb.env);
    expect(sb.text()).toMatch(
      /Gemini CLI\s+registered, but not to this host copy/,
    );
  });
});

describe("interactive client choice", () => {
  const ask = (answers: string[]) => {
    const asked: string[] = [];
    return {
      asked,
      ask: (q: string) => {
        asked.push(q);
        return Promise.resolve(answers.shift() ?? "");
      },
    };
  };

  it("asks Y/n for each client it finds and keeps the yeses", async () => {
    const sb = sandbox((c) =>
      c === "claude"
        ? { status: 0, stdout: "", stderr: "" }
        : { status: null, stdout: "", stderr: "" },
    );
    mkdirSync(path.join(sb.env.home ?? "", ".cursor"), { recursive: true });
    mkdirSync(path.join(sb.env.home ?? "", ".gemini"), { recursive: true });
    const q = ask(["", "n", "yes"]);
    const clients = await resolveClients(parseArgs(["install"], "linux"), {
      ...sb.env,
      interactive: true,
      ask: q.ask,
    });
    expect(clients).toEqual(["claude", "gemini"]);
    expect(q.asked).toHaveLength(3);
    expect(sb.text()).toContain("[x] Claude Code [x] Cursor [x] Gemini CLI");
  });

  it("is `none` when not interactive, and an explicit --client wins", async () => {
    const sb = sandbox();
    const q = ask([]);
    expect(
      await resolveClients(parseArgs(["install"], "linux"), sb.env),
    ).toEqual([]);
    expect(
      await resolveClients(
        parseArgs(["install", "--client", "vscode"], "linux"),
        {
          ...sb.env,
          interactive: true,
          ask: q.ask,
        },
      ),
    ).toEqual(["vscode"]);
    expect(q.asked).toEqual([]);
  });

  it("says so when no client is found", async () => {
    const sb = sandbox(() => ({ status: null, stdout: "", stderr: "" }));
    const q = ask([]);
    expect(
      await resolveClients(parseArgs(["install"], "linux"), {
        ...sb.env,
        interactive: true,
        ask: q.ask,
      }),
    ).toEqual([]);
    expect(sb.text()).toContain("No supported AI client found");
  });
});
