import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  type ClientCtx,
  codexTable,
  ConfigError,
  jsonEntry,
  readCodexEntry,
  registerClient,
  registerJson,
  removeCodexToml,
  unregisterClient,
  unregisterJson,
  upsertCodexToml,
} from "./clients";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), "ssc-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const NODE = "/usr/bin/node";
const ENTRY = "/h/splitsession-bridge.mjs";
const table = codexTable(NODE, ENTRY);

function ctxIn(home: string, plat = "darwin"): ClientCtx {
  return {
    home,
    platform: plat,
    penv: {},
    node: NODE,
    entry: ENTRY,
    run: () => ({ status: null, stdout: "", stderr: "" }), // no claude / codex CLI
    log: () => {},
    now: () => new Date("2026-10-14T12:00:00.123Z"),
  };
}

const backups = (file: string) =>
  readdirSync(path.dirname(file)).filter((f) =>
    f.startsWith(`${path.basename(file)}.bak-`),
  );

describe("JSON configs (Cursor, Claude Desktop, Gemini CLI, VS Code)", () => {
  const entry = jsonEntry("cursor", NODE, ENTRY);

  it("creates a missing file (and its folder) with 2-space JSON, no backup", () => {
    const file = path.join(tmp(), "a", "b", "mcp.json");
    const o = registerJson(file, "mcpServers", entry, ctxIn("/x"));
    expect(o.status).toBe("added");
    expect(o.backup).toBeUndefined();
    expect(readFileSync(file, "utf8")).toBe(
      `${JSON.stringify({ mcpServers: { splitsession: entry } }, null, 2)}\n`,
    );
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("keeps other servers and other keys, adds ours, and writes one backup of the original", () => {
    const file = path.join(tmp(), "settings.json");
    const original = `${JSON.stringify(
      {
        theme: "dark",
        mcpServers: { other: { command: "x", env: { TOKEN: "secret" } } },
      },
      null,
      2,
    )}\n`;
    writeFileSync(file, original);
    const o = registerJson(file, "mcpServers", entry, ctxIn("/x"));
    expect(o.status).toBe("added");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      theme: "dark",
      mcpServers: {
        other: { command: "x", env: { TOKEN: "secret" } },
        splitsession: entry,
      },
    });
    expect(backups(file)).toEqual(["settings.json.bak-20261014T120000123Z"]);
    expect(readFileSync(o.backup ?? "", "utf8")).toBe(original);
  });

  it("is idempotent: the second run changes nothing and writes no backup", () => {
    const file = path.join(tmp(), "mcp.json");
    registerJson(file, "mcpServers", entry, ctxIn("/x"));
    const first = readFileSync(file, "utf8");
    const again = registerJson(file, "mcpServers", entry, ctxIn("/x"));
    expect(again.status).toBe("unchanged");
    expect(readFileSync(file, "utf8")).toBe(first);
    expect(backups(file)).toEqual([]);
  });

  it("replaces an older splitsession entry (another node or path) in place", () => {
    const file = path.join(tmp(), "mcp.json");
    writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          a: { command: "a" },
          splitsession: { command: "old", args: ["/old.mjs", "mcp"] },
          z: { command: "z" },
        },
      }),
    );
    const o = registerJson(file, "mcpServers", entry, ctxIn("/x"));
    expect(o.status).toBe("updated");
    const doc = JSON.parse(readFileSync(file, "utf8"));
    expect(Object.keys(doc.mcpServers)).toEqual(["a", "splitsession", "z"]);
    expect(doc.mcpServers.splitsession).toEqual(entry);
  });

  it("keeps the file's own indent and missing final newline", () => {
    const file = path.join(tmp(), "mcp.json");
    writeFileSync(file, '{\n\t"mcpServers": {}\n}');
    registerJson(file, "mcpServers", entry, ctxIn("/x"));
    const text = readFileSync(file, "utf8");
    expect(text.startsWith('{\n\t"mcpServers": {\n\t\t"splitsession"')).toBe(
      true,
    );
    expect(text.endsWith("}")).toBe(true);
  });

  it("treats an empty file as an empty object", () => {
    const file = path.join(tmp(), "mcp.json");
    writeFileSync(file, "");
    expect(registerJson(file, "mcpServers", entry, ctxIn("/x")).status).toBe(
      "added",
    );
  });

  it("refuses files it cannot edit without losing anything (comments, wrong shape)", () => {
    const d = tmp();
    const commented = path.join(d, "c.json");
    writeFileSync(commented, '{\n  // keep\n  "servers": {}\n}\n');
    expect(() =>
      registerJson(commented, "servers", entry, ctxIn("/x")),
    ).toThrow(ConfigError);
    expect(readFileSync(commented, "utf8")).toContain("// keep");

    const array = path.join(d, "a.json");
    writeFileSync(array, "[]");
    expect(() => registerJson(array, "mcpServers", entry, ctxIn("/x"))).toThrow(
      /JSON object/,
    );

    const wrong = path.join(d, "w.json");
    writeFileSync(wrong, '{"mcpServers": []}');
    expect(() => registerJson(wrong, "mcpServers", entry, ctxIn("/x"))).toThrow(
      /not an object/,
    );
    expect(readdirSync(d).some((f) => f.includes(".bak-"))).toBe(false);
    expect(readdirSync(d).some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it("writes through a symlinked dotfile instead of replacing the link", () => {
    const d = tmp();
    const real = path.join(d, "dotfiles", "mcp.json");
    mkdirSync(path.dirname(real));
    writeFileSync(real, '{"mcpServers":{}}\n');
    const link = path.join(d, "mcp.json");
    symlinkSync(real, link);
    registerJson(link, "mcpServers", entry, ctxIn("/x"));
    expect(readFileSync(real, "utf8")).toContain("splitsession");
  });

  it("unregister removes only the splitsession key, with a backup; absent is a no-op", () => {
    const file = path.join(tmp(), "mcp.json");
    expect(unregisterJson(file, "mcpServers", ctxIn("/x")).status).toBe(
      "absent",
    );
    expect(existsSync(file)).toBe(false);

    writeFileSync(
      file,
      JSON.stringify({
        keep: 1,
        mcpServers: { other: { command: "o" }, splitsession: entry },
      }),
    );
    const o = unregisterJson(file, "mcpServers", ctxIn("/x"));
    expect(o.status).toBe("removed");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      keep: 1,
      mcpServers: { other: { command: "o" } },
    });
    expect(backups(file)).toHaveLength(1);
    expect(unregisterJson(file, "mcpServers", ctxIn("/x")).status).toBe(
      "absent",
    );
  });

  it("VS Code uses `servers` with type stdio", () => {
    const home = tmp();
    const ctx = ctxIn(home, "darwin");
    expect(registerClient("vscode", ctx).ok).toBe(true);
    const file = path.join(
      home,
      "Library",
      "Application Support",
      "Code",
      "User",
      "mcp.json",
    );
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      servers: {
        splitsession: {
          type: "stdio",
          command: NODE,
          args: [ENTRY, "mcp"],
        },
      },
    });
    expect(unregisterClient("vscode", ctx)).toContain("removed");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ servers: {} });
  });

  it("Claude Desktop exists on macOS only", () => {
    const home = tmp();
    expect(registerClient("claude-desktop", ctxIn(home, "linux")).ok).toBe(
      false,
    );
    expect(registerClient("claude-desktop", ctxIn(home, "darwin")).ok).toBe(
      true,
    );
    expect(
      existsSync(
        path.join(
          home,
          "Library",
          "Application Support",
          "Claude",
          "claude_desktop_config.json",
        ),
      ),
    ).toBe(true);
  });
});

describe("Codex config.toml edits", () => {
  const SAMPLE = `# my codex config
model = "gpt-6"   # keep this comment

[mcp_servers.other]
command = "npx"
args = ["-y", "thing"]  # trailing
env = { TOKEN = "secret" }

[projects."/Users/me/x"]
trust_level = "trusted"
`;

  it("appends the table after a blank line and keeps everything else byte for byte", () => {
    const next = upsertCodexToml(SAMPLE, table);
    expect(next).toBe(`${SAMPLE}\n${table.join("\n")}\n`);
    expect(readCodexEntry(next)).toEqual({
      command: NODE,
      args: [ENTRY, "mcp"],
    });
  });

  it("uninstalling what was appended gives back the original text exactly", () => {
    expect(removeCodexToml(upsertCodexToml(SAMPLE, table))).toBe(SAMPLE);
    expect(removeCodexToml("")).toBe("");
    expect(removeCodexToml(upsertCodexToml("", table))).toBe("");
  });

  it("replaces an existing table in the middle, leaving the neighbours and their comments", () => {
    const text = `[a]
x = 1

[mcp_servers.splitsession]
command = "old"
args = [
  "/old.mjs",   # was
  "mcp",
]

# about b
[b]
y = 2
`;
    const next = upsertCodexToml(text, table);
    expect(next).toBe(`[a]
x = 1

${table.join("\n")}

# about b
[b]
y = 2
`);
    // idempotent
    expect(upsertCodexToml(next, table)).toBe(next);
  });

  it("reads a multi-line args array, and quoted table names", () => {
    const text = `[mcp_servers."splitsession"]
command = "/n"
args = [
  "/e.mjs",
  "mcp",
]
`;
    expect(readCodexEntry(text)).toEqual({
      command: "/n",
      args: ["/e.mjs", "mcp"],
    });
    expect(readCodexEntry(SAMPLE)).toBeUndefined();
  });

  it("removes the table together with its sub-tables, nothing else", () => {
    const text = `a = 1

[mcp_servers.splitsession]
command = "n"
args = ["e", "mcp"]

[mcp_servers.splitsession.env]
K = "v"

[keep]
z = 1
`;
    expect(removeCodexToml(text)).toBe(`a = 1

[keep]
z = 1
`);
  });

  it("does not mistake header-looking text in strings or arrays for tables", () => {
    const text = `note = """
[mcp_servers.splitsession]
"""
list = [
  [1, 2]
]
`;
    expect(readCodexEntry(text)).toBeUndefined();
    expect(removeCodexToml(text)).toBe(text);
    expect(upsertCodexToml(text, table)).toBe(`${text}\n${table.join("\n")}\n`);
  });

  it("refuses a definition it does not understand (inline table, dotted keys)", () => {
    expect(() =>
      upsertCodexToml(
        '[mcp_servers]\nsplitsession = { command = "x" }\n',
        table,
      ),
    ).toThrow(ConfigError);
    expect(() =>
      upsertCodexToml('mcp_servers.splitsession.command = "x"\n', table),
    ).toThrow(ConfigError);
  });

  it("keeps CRLF line endings", () => {
    const next = upsertCodexToml("a = 1\r\n", table);
    expect(next).toBe(`a = 1\r\n\r\n${table.join("\r\n")}\r\n`);
  });

  it("through the file: backup, idempotent, uninstall, no CLI", () => {
    const home = tmp();
    const file = path.join(home, ".codex", "config.toml");
    mkdirSync(path.dirname(file));
    writeFileSync(file, SAMPLE);
    const ctx = ctxIn(home);

    expect(registerClient("codex", ctx).ok).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(`${SAMPLE}\n${table.join("\n")}\n`);
    expect(backups(file)).toHaveLength(1);
    expect(
      readFileSync(
        path.join(path.dirname(file), backups(file)[0] ?? ""),
        "utf8",
      ),
    ).toBe(SAMPLE);

    expect(registerClient("codex", ctx).message).toContain("unchanged");
    expect(backups(file)).toHaveLength(1);

    expect(unregisterClient("codex", ctx)).toContain("removed");
    expect(readFileSync(file, "utf8")).toBe(SAMPLE);
    expect(unregisterClient("codex", ctx)).toContain("not registered");
  });

  it("creates ~/.codex/config.toml when missing", () => {
    const home = tmp();
    expect(registerClient("codex", ctxIn(home)).ok).toBe(true);
    expect(readFileSync(path.join(home, ".codex", "config.toml"), "utf8")).toBe(
      `${table.join("\n")}\n`,
    );
  });

  it("falls back to the file when `codex mcp add` fails", () => {
    const home = tmp();
    const ctx = {
      ...ctxIn(home),
      run: (_c: string, args: string[]) => ({
        status: args.includes("--help") ? 0 : args[1] === "add" ? 1 : 0,
        stdout: "",
        stderr: "nope",
      }),
    };
    expect(registerClient("codex", ctx).ok).toBe(true);
    expect(existsSync(path.join(home, ".codex", "config.toml"))).toBe(true);
  });
});

describe("Claude Code", () => {
  it("skips the CLI when ~/.claude.json already holds this exact entry", () => {
    const home = tmp();
    const calls: string[][] = [];
    writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          splitsession: {
            type: "stdio",
            command: NODE,
            args: [ENTRY, "mcp"],
            env: {},
          },
        },
      }),
    );
    const ctx: ClientCtx = {
      ...ctxIn(home),
      run: (c, a) => {
        calls.push([c, ...a]);
        return { status: 0, stdout: "", stderr: "" };
      },
    };
    expect(registerClient("claude", ctx).message).toContain("unchanged");
    expect(calls).toEqual([["claude", "--version"]]);
    // uninstall goes through the CLI (Claude Code owns that file)
    expect(unregisterClient("claude", ctx)).toContain("removed");
    expect(calls.at(-1)).toEqual([
      "claude",
      "mcp",
      "remove",
      "--scope",
      "user",
      "splitsession",
    ]);
  });
});
