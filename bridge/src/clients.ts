// Registering the MCP server (`<node> <host copy> mcp`) with AI clients, and taking it out again. Pure text edits
// (JSON, TOML) are separate from the file and process effects so the tests can drive both with a temporary HOME.
//
// Every edit touches only the `splitsession` entry: the rest of the file is kept as it was (JSON is re-serialised with
// the file's own indent; TOML is edited line by line, so comments and other tables stay byte for byte). A file that
// changes is first copied to `<file>.bak-<timestamp>`, then replaced atomically (temp file + rename). A file this
// program cannot edit safely (comments in JSON, an unexpected shape) is left alone and the snippet is printed instead.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { appSupport } from "./paths";

export const MCP_NAME = "splitsession";

export const CLIENT_KEYS = [
  "claude",
  "codex",
  "cursor",
  "claude-desktop",
  "gemini",
  "vscode",
] as const;
export type ClientKey = (typeof CLIENT_KEYS)[number];
export const CLIENT_LABEL: Record<ClientKey, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  "claude-desktop": "Claude Desktop",
  gemini: "Gemini CLI",
  vscode: "VS Code",
};

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}
export type Runner = (command: string, args: string[]) => RunResult;

export const defaultRunner: Runner = (command, args) => {
  const r = spawnSync(command, args, { encoding: "utf8", timeout: 30_000 });
  return {
    status: r.error ? null : r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
};

export interface ClientCtx {
  home: string;
  platform: string;
  /** Environment variables (CODEX_HOME, CLAUDE_CONFIG_DIR, XDG_CONFIG_HOME). */
  penv: NodeJS.ProcessEnv;
  node: string;
  /** The host copy the clients start: `<node> <entry> mcp`. */
  entry: string;
  run: Runner;
  log: (line: string) => void;
  now: () => Date;
}

/** An expected, explainable failure (an unreadable or unusual config file). */
export class ConfigError extends Error {}

// ----- where each client keeps its configuration -------------------------------------------------------------------

export interface ClientPaths {
  /** Claude Code's user-scope settings (read to see what is registered; written only by `claude mcp`). */
  claudeJson: string;
  codex: string;
  cursor: string;
  /** macOS only. */
  claudeDesktop: string | null;
  gemini: string;
  vscode: string | null;
}

export function clientPaths(
  home: string,
  plat: string,
  penv: NodeJS.ProcessEnv,
): ClientPaths {
  const abs = (v: string | undefined) =>
    v && path.isAbsolute(v) ? v : undefined;
  const support = appSupport(home, plat, penv);
  return {
    claudeJson: path.join(abs(penv.CLAUDE_CONFIG_DIR) ?? home, ".claude.json"),
    codex: path.join(
      abs(penv.CODEX_HOME) ?? path.join(home, ".codex"),
      "config.toml",
    ),
    cursor: path.join(home, ".cursor", "mcp.json"),
    claudeDesktop:
      plat === "darwin"
        ? path.join(support, "Claude", "claude_desktop_config.json")
        : null,
    gemini: path.join(home, ".gemini", "settings.json"),
    vscode: path.join(support, "Code", "User", "mcp.json"),
  };
}

// ----- what is written ---------------------------------------------------------------------------------------------

/** The JSON object each client stores under its servers key. */
export function jsonEntry(
  client: ClientKey,
  node: string,
  entry: string,
): Record<string, unknown> {
  const base = { command: node, args: [entry, "mcp"] };
  return client === "vscode" ? { type: "stdio", ...base } : base;
}

/** Key that holds the servers: `servers` in VS Code, `mcpServers` elsewhere. */
export const serversKey = (client: ClientKey): string =>
  client === "vscode" ? "servers" : "mcpServers";

export function codexTable(node: string, entry: string): string[] {
  return [
    `[mcp_servers.${MCP_NAME}]`,
    `command = ${JSON.stringify(node)}`,
    `args = ${JSON.stringify([entry, "mcp"])}`,
  ];
}

// ----- JSON configs ------------------------------------------------------------------------------------------------

interface JsonDoc {
  value: Record<string, unknown>;
  indent: string;
  newline: boolean;
  existed: boolean;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Reads a JSON object file. Missing or empty is an empty object. Comments, syntax errors and non-objects throw. */
export function readJsonDoc(file: string): JsonDoc {
  if (!existsSync(file))
    return { value: {}, indent: "  ", newline: true, existed: false };
  const raw = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  if (raw.trim() === "")
    return { value: {}, indent: "  ", newline: true, existed: true };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ConfigError(
      `${file} is not plain JSON (comments or a syntax error?), so it was not changed`,
    );
  }
  if (!isObject(value))
    throw new ConfigError(
      `${file} does not hold a JSON object, so it was not changed`,
    );
  const indent = /^([ \t]+)"/m.exec(raw)?.[1] ?? "  ";
  return { value, indent, newline: raw.endsWith("\n"), existed: true };
}

function serversOf(doc: JsonDoc, key: string, file: string) {
  const v = doc.value[key];
  if (v === undefined) return undefined;
  if (!isObject(v))
    throw new ConfigError(
      `"${key}" in ${file} is not an object, so it was not changed`,
    );
  return v;
}

/** The `splitsession` entry of a JSON config, or undefined. */
export function readJsonEntry(
  file: string,
  key: string,
): Record<string, unknown> | undefined {
  const entry = serversOf(readJsonDoc(file), key, file)?.[MCP_NAME];
  return isObject(entry) ? entry : undefined;
}

const stamp = (d: Date) =>
  d.toISOString().replace(/[-:]/g, "").replace(".", "");

/** Backs up the current file (if any) and replaces it atomically with `text`. Returns the backup path. */
function writeAtomic(
  file: string,
  text: string,
  ctx: ClientCtx,
): string | undefined {
  const target = existsSync(file) ? realpathSync(file) : file; // a symlinked dotfile stays a symlink
  let backup: string | undefined;
  let mode = 0o600;
  if (existsSync(target)) {
    mode = statSync(target).mode & 0o777;
    backup = `${target}.bak-${stamp(ctx.now())}`;
    copyFileSync(target, backup);
  } else {
    mkdirSync(path.dirname(target), { recursive: true });
  }
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, { mode });
    renameSync(tmp, target);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  return backup;
}

export interface Outcome {
  status: "added" | "updated" | "unchanged" | "removed" | "absent";
  file: string;
  backup?: string;
}

function writeJson(file: string, doc: JsonDoc, ctx: ClientCtx) {
  const text =
    JSON.stringify(doc.value, null, doc.indent) + (doc.newline ? "\n" : "");
  return writeAtomic(file, text, ctx);
}

export function registerJson(
  file: string,
  key: string,
  entry: Record<string, unknown>,
  ctx: ClientCtx,
): Outcome {
  const doc = readJsonDoc(file);
  const servers = serversOf(doc, key, file) ?? {};
  const current = servers[MCP_NAME];
  if (deepEqual(current, entry)) return { status: "unchanged", file };
  servers[MCP_NAME] = entry;
  doc.value[key] = servers;
  const backup = writeJson(file, doc, ctx);
  return {
    status: current === undefined ? "added" : "updated",
    file,
    backup,
  };
}

export function unregisterJson(
  file: string,
  key: string,
  ctx: ClientCtx,
): Outcome {
  if (!existsSync(file)) return { status: "absent", file };
  const doc = readJsonDoc(file);
  const servers = serversOf(doc, key, file);
  if (!servers || !(MCP_NAME in servers)) return { status: "absent", file };
  delete servers[MCP_NAME];
  return { status: "removed", file, backup: writeJson(file, doc, ctx) };
}

// ----- TOML (Codex) ------------------------------------------------------------------------------------------------

interface Header {
  path: string[];
  array: boolean;
}

/** Parses `[a.b."c d"]` / `[[a.b]]` (with an optional comment); null when the line is not a table header. */
function parseHeader(line: string): Header | null {
  let i = 0;
  const ws = () => {
    while (i < line.length && (line[i] === " " || line[i] === "\t")) i += 1;
  };
  ws();
  if (line[i] !== "[") return null;
  i += 1;
  const array = line[i] === "[";
  if (array) i += 1;
  const keys: string[] = [];
  for (;;) {
    ws();
    const c = line[i];
    if (c === '"' || c === "'") {
      const end =
        c === '"' ? findBasicEnd(line, i + 1) : line.indexOf("'", i + 1);
      if (end === -1) return null;
      const raw = line.slice(i + 1, end);
      if (c === "'") keys.push(raw);
      else {
        try {
          keys.push(JSON.parse(`"${raw}"`) as string);
        } catch {
          return null;
        }
      }
      i = end + 1;
    } else {
      const m = /^[A-Za-z0-9_-]+/.exec(line.slice(i));
      if (!m) return null;
      keys.push(m[0]);
      i += m[0].length;
    }
    ws();
    if (line[i] === ".") {
      i += 1;
      continue;
    }
    break;
  }
  if (line[i] !== "]") return null;
  i += 1;
  if (array) {
    if (line[i] !== "]") return null;
    i += 1;
  }
  ws();
  if (i < line.length && line[i] !== "#") return null;
  return { path: keys, array };
}

function findBasicEnd(line: string, from: number): number {
  for (let i = from; i < line.length; i += 1) {
    if (line[i] === "\\") i += 1;
    else if (line[i] === '"') return i;
  }
  return -1;
}

interface LineInfo {
  header: Header | null;
  /** The table in effect on this line (a header line belongs to its own table). */
  table: string[];
  /** A key/value line (not blank, not a comment, not a header). */
  keyLine: boolean;
}

/** Classifies lines, ignoring header-looking text inside multi-line strings and multi-line arrays/inline tables. */
function scanToml(lines: string[]): LineInfo[] {
  const infos: LineInfo[] = [];
  let table: string[] = [];
  let multi: '"""' | "'''" | null = null;
  let depth = 0;
  for (const line of lines) {
    const startsClean = multi === null && depth === 0;
    const header = startsClean ? parseHeader(line) : null;
    if (header) {
      table = header.path;
      infos.push({ header, table, keyLine: false });
      continue;
    }
    const t = line.trim();
    infos.push({
      header: null,
      table,
      keyLine: startsClean && t !== "" && !t.startsWith("#"),
    });
    // Advance the string/bracket state over this line.
    let i = 0;
    while (i < line.length) {
      if (multi) {
        const end = line.indexOf(multi, i);
        if (end === -1) break;
        i = end + 3;
        multi = null;
        continue;
      }
      const c = line[i];
      if (c === "#") break;
      if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
        multi = line.slice(i, i + 3) as '"""' | "'''";
        i += 3;
      } else if (c === '"') {
        const end = findBasicEnd(line, i + 1);
        i = end === -1 ? line.length : end + 1;
      } else if (c === "'") {
        const end = line.indexOf("'", i + 1);
        i = end === -1 ? line.length : end + 1;
      } else {
        if (c === "[" || c === "{") depth += 1;
        else if ((c === "]" || c === "}") && depth > 0) depth -= 1;
        i += 1;
      }
    }
  }
  return infos;
}

const isOurs = (p: string[]) =>
  p.length >= 2 && p[0] === "mcp_servers" && p[1] === MCP_NAME;

interface TomlParts {
  eol: string;
  lines: string[];
  infos: LineInfo[];
  hadNewline: boolean;
}

function splitToml(text: string): TomlParts {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const hadNewline = lines.length > 1 && lines[lines.length - 1] === "";
  if (hadNewline || text === "") lines.pop();
  return { eol, lines, infos: scanToml(lines), hadNewline };
}

function joinToml(p: TomlParts, lines: string[]): string {
  return lines.length === 0 ? "" : lines.join(p.eol) + p.eol;
}

/** [start, end) of each table named mcp_servers.splitsession (index 0 = the table itself) and its sub-tables. */
function ourRanges(p: TomlParts) {
  const headers = p.infos
    .map((info, index) => ({ info, index }))
    .filter((h) => h.info.header);
  const rangeOf = (index: number) => {
    const next = headers.find((h) => h.index > index);
    let end = next ? next.index : p.lines.length;
    // Blank lines, and comment lines right before the next header (they describe that header), are not ours.
    while (end - 1 > index) {
      const t = (p.lines[end - 1] ?? "").trim();
      if (t === "" || (next && t.startsWith("#"))) end -= 1;
      else break;
    }
    return [index, end] as const;
  };
  const main = headers.find(
    (h) =>
      !h.info.header?.array &&
      h.info.header?.path.length === 2 &&
      isOurs(h.info.header.path),
  );
  const subs = headers.filter(
    (h) => isOurs(h.info.header?.path ?? []) && h !== main,
  );
  return {
    main: main ? rangeOf(main.index) : undefined,
    subs: subs.map((h) => rangeOf(h.index)),
  };
}

/** True when `splitsession` is defined some way this editor does not handle (inline table, dotted keys). */
function hasForeignDefinition(p: TomlParts): boolean {
  return p.infos.some((info, i) => {
    if (!info.keyLine) return false;
    const line = p.lines[i] ?? "";
    if (info.table.length === 1 && info.table[0] === "mcp_servers")
      return /^\s*("splitsession"|'splitsession'|splitsession)\s*[=.]/.test(
        line,
      );
    if (info.table.length === 0)
      return /^\s*mcp_servers\s*\.\s*("splitsession"|'splitsession'|splitsession)\b/.test(
        line,
      );
    return false;
  });
}

/** Adds or replaces `[mcp_servers.splitsession]` (sub-tables the user added stay). */
export function upsertCodexToml(text: string, table: string[]): string {
  const p = splitToml(text);
  if (hasForeignDefinition(p))
    throw new ConfigError(
      `${MCP_NAME} is defined in config.toml in a form this installer does not edit (inline table or dotted keys), so it was not changed`,
    );
  const { main } = ourRanges(p);
  const out = [...p.lines];
  if (main) {
    out.splice(main[0], main[1] - main[0], ...table);
  } else {
    if (out.length > 0 && (out[out.length - 1] ?? "").trim() !== "")
      out.push("");
    out.push(...table);
  }
  return joinToml(p, out);
}

/** Removes the table and its sub-tables. Returns the text unchanged when there is none. */
export function removeCodexToml(text: string): string {
  const p = splitToml(text);
  const { main, subs } = ourRanges(p);
  const ranges = [...(main ? [main] : []), ...subs].sort((a, b) => b[0] - a[0]);
  if (ranges.length === 0) return text;
  const out = [...p.lines];
  for (const [start, end] of ranges) {
    let from = start;
    // Take one blank separator line with it when that leaves no double gap.
    if (
      from > 0 &&
      (out[from - 1] ?? "").trim() === "" &&
      (end >= out.length || (out[end] ?? "").trim() === "")
    )
      from -= 1;
    out.splice(from, end - from);
  }
  return joinToml(p, out);
}

/** command/args of the splitsession table, when present. */
export function readCodexEntry(
  text: string,
): { command?: string; args?: string[] } | undefined {
  const p = splitToml(text);
  const { main } = ourRanges(p);
  if (!main) return undefined;
  const body = p.lines.slice(main[0] + 1, main[1]);
  const result: { command?: string; args?: string[] } = {};
  const cmd = body.find((l) => /^\s*command\s*=/.test(l));
  if (cmd) {
    try {
      const v: unknown = JSON.parse(cmd.replace(/^\s*command\s*=\s*/, ""));
      if (typeof v === "string") result.command = v;
    } catch {
      /* a literal string or odd quoting: reported as present without details */
    }
  }
  const at = body.findIndex((l) => /^\s*args\s*=/.test(l));
  if (at !== -1) {
    let joined = (body[at] ?? "").replace(/^\s*args\s*=\s*/, "");
    for (
      let i = at + 1;
      i < body.length && !/\]\s*(#.*)?$/.test(joined);
      i += 1
    )
      joined += (body[i] ?? "").replace(/#.*$/, "");
    try {
      const v: unknown = JSON.parse(joined.replace(/,\s*\]/, "]"));
      if (Array.isArray(v) && v.every((x) => typeof x === "string"))
        result.args = v as string[];
    } catch {
      /* ignore */
    }
  }
  return result;
}

function registerCodexFile(file: string, ctx: ClientCtx): Outcome {
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const table = codexTable(ctx.node, ctx.entry);
  const current = readCodexEntry(text);
  if (
    current?.command === ctx.node &&
    deepEqual(current.args, [ctx.entry, "mcp"])
  )
    return { status: "unchanged", file };
  const next = upsertCodexToml(text, table);
  const backup = writeAtomic(file, next, ctx);
  return { status: current ? "updated" : "added", file, backup };
}

function unregisterCodexFile(file: string, ctx: ClientCtx): Outcome {
  if (!existsSync(file)) return { status: "absent", file };
  const text = readFileSync(file, "utf8");
  const next = removeCodexToml(text);
  if (next === text) return { status: "absent", file };
  return { status: "removed", file, backup: writeAtomic(file, next, ctx) };
}

// ----- per client --------------------------------------------------------------------------------------------------

export type RegistrationState =
  "registered" | "stale" | "absent" | "unreadable";

export interface ClientStatus {
  state: RegistrationState;
  /** Where it was looked for / what it points at. */
  detail: string;
}

const ok = (r: RunResult) => r.status === 0;

function describeEntry(command: unknown, args: unknown): string {
  const a = Array.isArray(args) ? args.map(String) : [];
  return [command, ...a].filter((x) => typeof x === "string").join(" ");
}

/** Whether the client is installed here (a cheap check; used for the interactive default only). */
export function detectClient(client: ClientKey, ctx: ClientCtx): boolean {
  const paths = clientPaths(ctx.home, ctx.platform, ctx.penv);
  switch (client) {
    case "claude":
      return ok(ctx.run("claude", ["--version"]));
    case "codex":
      return (
        ok(ctx.run("codex", ["--version"])) ||
        existsSync(path.dirname(paths.codex))
      );
    case "cursor":
      return existsSync(path.dirname(paths.cursor));
    case "claude-desktop":
      return (
        paths.claudeDesktop !== null &&
        existsSync(path.dirname(paths.claudeDesktop))
      );
    case "gemini":
      return existsSync(path.dirname(paths.gemini));
    case "vscode":
      return paths.vscode !== null && existsSync(path.dirname(paths.vscode));
  }
}

/** Read-only: is `splitsession` registered with this client, and does it point at the current host copy? */
export function clientStatus(client: ClientKey, ctx: ClientCtx): ClientStatus {
  const paths = clientPaths(ctx.home, ctx.platform, ctx.penv);
  const judge = (
    file: string,
    command: unknown,
    args: unknown,
  ): ClientStatus => ({
    state:
      Array.isArray(args) && args[0] === ctx.entry && args[1] === "mcp"
        ? "registered"
        : "stale",
    detail: `${describeEntry(command, args)} (${file})`,
  });
  try {
    if (client === "codex") {
      if (!existsSync(paths.codex))
        return { state: "absent", detail: paths.codex };
      const entry = readCodexEntry(readFileSync(paths.codex, "utf8"));
      return entry
        ? judge(paths.codex, entry.command, entry.args)
        : { state: "absent", detail: paths.codex };
    }
    const file =
      client === "claude"
        ? paths.claudeJson
        : client === "cursor"
          ? paths.cursor
          : client === "claude-desktop"
            ? paths.claudeDesktop
            : client === "gemini"
              ? paths.gemini
              : paths.vscode;
    if (!file)
      return { state: "absent", detail: "not available on this system" };
    if (!existsSync(file)) return { state: "absent", detail: file };
    const key = client === "vscode" ? "servers" : "mcpServers";
    const entry = readJsonEntry(file, key);
    return entry
      ? judge(file, entry.command, entry.args)
      : { state: "absent", detail: file };
  } catch (error) {
    return {
      state: "unreadable",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface RegisterResult {
  ok: boolean;
  /** A one-line message for the log. */
  message: string;
  outcome?: Outcome;
}

const done = (label: string, o: Outcome): string => {
  const what =
    o.status === "unchanged"
      ? "already registered, unchanged"
      : o.status === "added"
        ? "registered"
        : "updated";
  return `${label}: ${what} in ${o.file}${o.backup ? ` (backup: ${o.backup})` : ""}`;
};

function viaCli(
  ctx: ClientCtx,
  command: string,
  remove: string[],
  add: string[],
): RunResult {
  // Idempotent: an older registration (another node, another path) is replaced. Removing a missing one fails; that is fine.
  ctx.run(command, remove);
  return ctx.run(command, add);
}

export function registerClient(
  client: ClientKey,
  ctx: ClientCtx,
): RegisterResult {
  const label = CLIENT_LABEL[client];
  const paths = clientPaths(ctx.home, ctx.platform, ctx.penv);
  const fail = (message: string): RegisterResult => ({
    ok: false,
    message: `${label}: ${message}`,
  });
  try {
    if (client === "claude") {
      if (!ok(ctx.run("claude", ["--version"])))
        return fail(
          "the claude command was not found on PATH, so it was not registered.",
        );
      const current = existsSync(paths.claudeJson)
        ? safeEntry(paths.claudeJson, "mcpServers")
        : undefined;
      if (
        current?.command === ctx.node &&
        deepEqual(current.args, [ctx.entry, "mcp"])
      )
        return {
          ok: true,
          message: `${label}: already registered (user scope), unchanged.`,
        };
      const added = viaCli(
        ctx,
        "claude",
        ["mcp", "remove", "--scope", "user", MCP_NAME],
        [
          "mcp",
          "add",
          "--scope",
          "user",
          MCP_NAME,
          "--",
          ctx.node,
          ctx.entry,
          "mcp",
        ],
      );
      return added.status === 0
        ? {
            ok: true,
            message: `${label}: registered the "${MCP_NAME}" MCP server (user scope).`,
          }
        : fail(
            `\`claude mcp add\` failed${added.stderr ? `: ${added.stderr.trim()}` : ""}.`,
          );
    }

    if (client === "codex") {
      const file = paths.codex;
      const text = existsSync(file) ? readFileSync(file, "utf8") : "";
      const current = readCodexEntry(text);
      if (
        current?.command === ctx.node &&
        deepEqual(current.args, [ctx.entry, "mcp"])
      )
        return {
          ok: true,
          message: `${label}: already registered in ${file}, unchanged.`,
        };
      if (ok(ctx.run("codex", ["mcp", "add", "--help"]))) {
        const added = viaCli(
          ctx,
          "codex",
          ["mcp", "remove", MCP_NAME],
          ["mcp", "add", MCP_NAME, "--", ctx.node, ctx.entry, "mcp"],
        );
        if (added.status === 0)
          return {
            ok: true,
            message: `${label}: registered the "${MCP_NAME}" MCP server (codex mcp add).`,
          };
        ctx.log(
          `${label}: \`codex mcp add\` failed${added.stderr ? `: ${added.stderr.trim()}` : ""}; editing ${file} instead.`,
        );
      }
      const outcome = registerCodexFile(file, ctx);
      return { ok: true, message: done(label, outcome), outcome };
    }

    const file =
      client === "cursor"
        ? paths.cursor
        : client === "claude-desktop"
          ? paths.claudeDesktop
          : client === "gemini"
            ? paths.gemini
            : paths.vscode;
    if (!file) return fail("not available on this system.");
    const outcome = registerJson(
      file,
      serversKey(client),
      jsonEntry(client, ctx.node, ctx.entry),
      ctx,
    );
    return { ok: true, message: done(label, outcome), outcome };
  } catch (error) {
    return fail(`${error instanceof Error ? error.message : String(error)}.`);
  }
}

/** The `splitsession` entry of a JSON file, ignoring unreadable files (the CLI path then decides). */
function safeEntry(file: string, key: string) {
  try {
    return readJsonEntry(file, key);
  } catch {
    return undefined;
  }
}

export function unregisterClient(client: ClientKey, ctx: ClientCtx): string {
  const label = CLIENT_LABEL[client];
  const paths = clientPaths(ctx.home, ctx.platform, ctx.penv);
  try {
    if (client === "claude") {
      if (!safeEntry(paths.claudeJson, "mcpServers"))
        return `${label}: not registered.`;
      if (!ok(ctx.run("claude", ["--version"])))
        return `${label}: registered, but the claude command was not found; run: claude mcp remove --scope user ${MCP_NAME}`;
      const r = ctx.run("claude", [
        "mcp",
        "remove",
        "--scope",
        "user",
        MCP_NAME,
      ]);
      return r.status === 0
        ? `${label}: removed the "${MCP_NAME}" MCP server.`
        : `${label}: \`claude mcp remove\` failed${r.stderr ? `: ${r.stderr.trim()}` : ""}.`;
    }
    if (client === "codex") {
      const file = paths.codex;
      const text = existsSync(file) ? readFileSync(file, "utf8") : "";
      if (!readCodexEntry(text)) return `${label}: not registered.`;
      if (ok(ctx.run("codex", ["mcp", "add", "--help"]))) {
        const r = ctx.run("codex", ["mcp", "remove", MCP_NAME]);
        if (r.status === 0)
          return `${label}: removed the "${MCP_NAME}" MCP server.`;
      }
      return removedText(label, unregisterCodexFile(file, ctx));
    }
    const file =
      client === "cursor"
        ? paths.cursor
        : client === "claude-desktop"
          ? paths.claudeDesktop
          : client === "gemini"
            ? paths.gemini
            : paths.vscode;
    if (!file) return `${label}: not available on this system.`;
    return removedText(label, unregisterJson(file, serversKey(client), ctx));
  } catch (error) {
    return `${label}: ${error instanceof Error ? error.message : String(error)}.`;
  }
}

const removedText = (label: string, o: Outcome): string =>
  o.status === "removed"
    ? `${label}: removed "${MCP_NAME}" from ${o.file}${o.backup ? ` (backup: ${o.backup})` : ""}.`
    : `${label}: not registered.`;
