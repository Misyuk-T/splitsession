import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import path from "node:path";

import { EXTENSION_ID } from "../../src/bridge/protocol";
import {
  CLIENT_KEYS,
  CLIENT_LABEL,
  type ClientCtx,
  type ClientKey,
  clientPaths,
  clientStatus,
  codexTable,
  defaultRunner,
  detectClient,
  jsonEntry,
  MCP_NAME,
  registerClient,
  type Runner,
  serversKey,
  unregisterClient,
} from "./clients";
import {
  type BrowserKey,
  BROWSERS,
  browsersFor,
  HOST_MANIFEST_FILE,
  hostDir as defaultHostDir,
  manifestDir,
  socketDir,
  socketPath,
} from "./paths";
import { probeSocket } from "./probe";

/** Name of the native messaging host and of the MCP server registration. */
export const HOST_NAME = "com.splitsession.bridge";
const OLD_HOST_MANIFEST_FILE = "com.facet.bridge.json"; // before the rename to SplitSession (2026-10-11)
const OLD_MCP_NAME = "facet";
export const HOST_ENTRY_FILE = "splitsession-bridge.mjs";
export const LAUNCHER_FILE = "splitsession-bridge-host";

export { MCP_NAME };
export type { ClientKey, Runner, RunResult } from "./clients";
export const CLIENTS = [...CLIENT_KEYS, "all", "none"] as const;

export const USAGE = `splitsession-bridge: the companion program of the SplitSession (Full) Chrome extension

usage:
  splitsession-bridge install [--browser chrome|chromium|brave|edge|arc|all] [--extension-id <id>] [--client <list>]
  splitsession-bridge uninstall [--browser <name>|all] [--client <list>]
  splitsession-bridge status [--browser <name>|all]
  splitsession-bridge host     (started by Chrome; do not run by hand)
  splitsession-bridge mcp      (started by your AI client; do not run by hand)

install  copies this program to a fixed per-user folder, registers it with the browser (Native Messaging) and with
         your AI clients. --browser may repeat or be comma separated (default: chrome). --extension-id adds an allowed
         extension (default: the SplitSession Full extension, ${EXTENSION_ID}).
         --client is a comma separated list of ${CLIENT_KEYS.join(", ")}, or all, or none. Each listed client gets
         the "${MCP_NAME}" MCP server registered (its own CLI or an edit of its config file; the old file is saved as
         <file>.bak-<time>); anything that cannot be done is printed for you to add by hand. Without --client:
         in a terminal it asks, for each AI client it finds, whether to register; otherwise (a script) it is "none"
         and only prints what to add.
uninstall  removes the host registration and the copied program (every browser unless --browser is given), and the
         "${MCP_NAME}" entry from every AI client (or those in --client). Other entries are not touched.
status   reports the host registration, the copied program, which AI clients have it registered and whether a host
         is running (read-only).
`;

// Chrome extension IDs are 32 letters a-p.
const EXTENSION_ID_RE = /^[a-p]{32}$/;

export interface CliOptions {
  command: "install" | "uninstall" | "status";
  browsers: BrowserKey[];
  /** True when `--browser` was given (uninstall and status default to every browser). */
  browserGiven: boolean;
  extensionIds: string[];
  /** The AI clients to register with / unregister from; undefined when `--client` was not given. */
  clients: ClientKey[] | undefined;
  /** Explicit NativeMessagingHosts directory (tests, unusual browsers). Replaces `browsers`. */
  dir?: string;
  /** Where the host program is copied (default: the per-user SplitSession folder). */
  hostDir?: string;
}

export class UsageError extends Error {}

function splitValues(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** `install | uninstall | status` plus flags (`--flag value` or `--flag=value`). Throws UsageError. */
export function parseArgs(
  argv: string[],
  plat: string = platform(),
): CliOptions {
  const [command, ...rest] = argv;
  if (command !== "install" && command !== "uninstall" && command !== "status")
    throw new UsageError(`unknown command "${command ?? ""}"`);

  const browsers: string[] = [];
  const extensionIds: string[] = [];
  const clientArgs: string[] = [];
  let clientGiven = false;
  let dir: string | undefined;
  let hostDir: string | undefined;
  const known = browsersFor(plat);

  for (let i = 0; i < rest.length; i += 1) {
    let flag = rest[i] ?? "";
    let value: string | undefined;
    const eq = flag.indexOf("=");
    if (flag.startsWith("--") && eq !== -1) {
      value = flag.slice(eq + 1);
      flag = flag.slice(0, eq);
    }
    const take = () => {
      if (value !== undefined) return value;
      i += 1;
      const next = rest[i];
      if (next === undefined || next.startsWith("--"))
        throw new UsageError(`${flag} needs a value`);
      return next;
    };
    switch (flag) {
      case "--browser":
        browsers.push(...splitValues(take()).map((b) => b.toLowerCase()));
        break;
      case "--extension-id":
        extensionIds.push(...splitValues(take()));
        break;
      case "--client":
        clientGiven = true;
        clientArgs.push(...splitValues(take()).map((c) => c.toLowerCase()));
        break;
      case "--dir":
        dir = path.resolve(take());
        break;
      case "--host-dir":
        hostDir = path.resolve(take());
        break;
      default:
        throw new UsageError(`unknown option "${flag}"`);
    }
  }

  let chosen: BrowserKey[];
  if (browsers.includes("all")) {
    chosen = known;
  } else {
    for (const b of browsers) {
      if (!(BROWSERS as readonly string[]).includes(b))
        throw new UsageError(
          `unknown browser "${b}"; use ${BROWSERS.join(", ")} or all`,
        );
      if (!known.includes(b as BrowserKey))
        throw new UsageError(`${b} is not available on this system`);
    }
    chosen = [...new Set(browsers)] as BrowserKey[];
  }
  const browserGiven = browsers.length > 0;
  if (!browserGiven) chosen = command === "install" ? ["chrome"] : known;

  for (const id of extensionIds) {
    if (!EXTENSION_ID_RE.test(id))
      throw new UsageError(
        `"${id}" is not an extension ID (32 letters, a to p; see chrome://extensions)`,
      );
  }
  for (const c of clientArgs) {
    if (!(CLIENTS as readonly string[]).includes(c))
      throw new UsageError(`unknown client "${c}"; use ${CLIENTS.join(", ")}`);
  }
  if (clientGiven && clientArgs.length === 0)
    throw new UsageError("--client needs a value");
  if (clientArgs.includes("none") && clientArgs.length > 1)
    throw new UsageError("--client none cannot be combined with other clients");
  let clients: ClientKey[] | undefined;
  if (clientGiven) {
    clients = clientArgs.includes("all")
      ? [...CLIENT_KEYS]
      : clientArgs.includes("none")
        ? []
        : ([...new Set(clientArgs)] as ClientKey[]);
  }

  return {
    command,
    browsers: chosen,
    browserGiven,
    extensionIds: [
      ...new Set(extensionIds.length ? extensionIds : [EXTENSION_ID]),
    ],
    clients,
    dir,
    hostDir,
  };
}

// ----- pure pieces ------------------------------------------------------------------------------------------------

/** Single-quote for sh. */
export const shQuote = (s: string): string =>
  /^[A-Za-z0-9_/.:=@%+,-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;

export const originOf = (extensionId: string): string =>
  `chrome-extension://${extensionId}/`;

/** The native messaging host manifest: Chrome starts `launcher` for `allowed_origins` only. */
export function buildHostManifest(launcher: string, extensionIds: string[]) {
  return {
    name: HOST_NAME,
    description:
      "SplitSession agent bridge: lets your own AI agent see and operate your Chrome tabs (only while the switch in SplitSession is on).",
    path: launcher,
    type: "stdio",
    allowed_origins: extensionIds.map(originOf),
  };
}

/** The launcher Chrome starts: it pins the node that installed the host (Chrome has a minimal PATH). */
export function buildLauncher(
  node: string,
  hostEntry: string,
  extensionIds: string[],
): string {
  const allow = extensionIds
    .map((id) => shQuote(`--allow-origin=${originOf(id)}`))
    .join(" ");
  return `#!/bin/sh\n# Generated by "splitsession-bridge install". Chrome starts this; it starts the host with the node it was installed with.\nexec ${shQuote(node)} ${shQuote(hostEntry)} host ${allow} "$@"\n`;
}

export type ClientSnippets = Record<ClientKey, string>;

/** How each AI client is told to start the MCP server (`<node> <host copy> mcp`). */
export function clientSnippets(
  node: string,
  hostEntry: string,
): ClientSnippets {
  const json = (client: ClientKey) =>
    JSON.stringify(
      {
        [serversKey(client)]: {
          [MCP_NAME]: jsonEntry(client, node, hostEntry),
        },
      },
      null,
      2,
    );
  return {
    claude: `claude mcp add --scope user ${MCP_NAME} -- ${shQuote(node)} ${shQuote(hostEntry)} mcp`,
    codex: codexTable(node, hostEntry).join("\n"),
    cursor: json("cursor"),
    "claude-desktop": json("claude-desktop"),
    gemini: json("gemini"),
    vscode: json("vscode"),
  };
}

// ----- effects ----------------------------------------------------------------------------------------------------

export interface Env {
  /** Where output goes. */
  log: (line: string) => void;
  /** Runs an external command (`claude`, `codex`). */
  run?: Runner;
  /** True when a person can answer questions (stdin and stdout are terminals). */
  interactive?: boolean;
  /** Asks one question and returns the answer line. */
  ask?: (question: string) => Promise<string>;
  now?: () => Date;
  home?: string;
  platform?: string;
  node?: string;
  /** The running bundle: what `install` copies. */
  sourceEntry?: string;
  version?: string;
  process?: NodeJS.ProcessEnv;
}

interface Target {
  name: string;
  dir: string;
}

function targetsOf(options: CliOptions, env: Env): Target[] {
  if (options.dir) return [{ name: "custom", dir: options.dir }];
  return options.browsers.map((name) => ({
    name,
    dir: manifestDir(
      name,
      env.home ?? homedir(),
      env.platform ?? platform(),
      env.process ?? process.env,
    ),
  }));
}

function hostPaths(options: CliOptions, env: Env) {
  const dir =
    options.hostDir ??
    defaultHostDir(
      env.home ?? homedir(),
      env.platform ?? platform(),
      env.process ?? process.env,
    );
  return {
    dir,
    entry: path.join(dir, HOST_ENTRY_FILE),
    launcher: path.join(dir, LAUNCHER_FILE),
  };
}

const supported = (plat: string) => plat === "darwin" || plat === "linux";
const UNSUPPORTED =
  "splitsession-bridge: this system is not supported yet (macOS and Linux only). Windows support is planned.";

/** Leftovers of the product's old name (Facet): manifest in the browsers' folders, host copy, stale socket. */
function removeOld(
  targets: Target[],
  host: { dir: string },
  options: CliOptions,
  env: Env,
): void {
  const plat = env.platform ?? platform();
  const home = env.home ?? homedir();
  for (const { dir } of targets) {
    const file = path.join(dir, OLD_HOST_MANIFEST_FILE);
    if (existsSync(file)) {
      rmSync(file);
      env.log(`removed old ${file}`);
    }
  }
  // With an explicit --host-dir (tests) only that directory's old-named files are looked at.
  const oldHostDir = options.hostDir
    ? host.dir
    : path.join(
        path.dirname(socketDir(home, plat, env.process ?? process.env)),
        "Facet",
        "host",
      );
  const gone = [
    path.join(oldHostDir, "facet-bridge-host"),
    path.join(oldHostDir, "facet-bridge.mjs"),
  ].filter((f) => existsSync(f));
  for (const f of gone) rmSync(f, { force: true });
  if (gone.length > 0) env.log(`removed old host copy in ${oldHostDir}`);
  if (oldHostDir !== host.dir) {
    rmSync(path.join(path.dirname(oldHostDir), "bridge.sock"), { force: true });
    for (const d of [oldHostDir, path.dirname(oldHostDir)]) {
      try {
        rmdirSync(d); // only when empty
      } catch {
        /* not empty, or already gone */
      }
    }
  }
}

function clientCtx(env: Env, node: string, entry: string): ClientCtx {
  return {
    home: env.home ?? homedir(),
    platform: env.platform ?? platform(),
    penv: env.process ?? process.env,
    node,
    entry,
    run: env.run ?? defaultRunner,
    log: env.log,
    now: env.now ?? (() => new Date()),
  };
}

/** What to add by hand for one client, with the file it goes in. */
function printClientHelp(
  client: ClientKey,
  snippets: ClientSnippets,
  ctx: ClientCtx,
  env: Env,
): void {
  const { log } = env;
  const paths = clientPaths(ctx.home, ctx.platform, ctx.penv);
  const label = CLIENT_LABEL[client];
  if (client === "claude") {
    log(`${label}: run this once:\n`);
    log(`  ${snippets.claude}\n`);
    return;
  }
  const file = {
    codex: "~/.codex/config.toml",
    cursor: "~/.cursor/mcp.json",
    "claude-desktop": paths.claudeDesktop ?? "claude_desktop_config.json",
    gemini: "~/.gemini/settings.json",
    vscode: paths.vscode ?? "mcp.json",
  }[client];
  const merge =
    client === "codex"
      ? ""
      : ` (merge into an existing "${serversKey(client)}")`;
  log(`${label}: add this to ${file}${merge}:\n`);
  log(`${snippets[client].replace(/^/gm, "  ")}\n`);
}

/**
 * Without `--client`: in a terminal, asks for each AI client found on this computer whether to register it; otherwise
 * registers nothing (`none`: the snippets are printed). With `--client`, the list as given.
 */
export async function resolveClients(
  options: CliOptions,
  env: Env,
): Promise<ClientKey[]> {
  if (options.clients) return options.clients;
  if (!env.interactive || !env.ask) return [];
  const node = env.node ?? process.execPath;
  const ctx = clientCtx(env, node, hostPaths(options, env).entry);
  const found = CLIENT_KEYS.filter((c) => detectClient(c, ctx));
  if (found.length === 0) {
    env.log(
      `No supported AI client found on this computer (checked: ${CLIENT_KEYS.map((c) => CLIENT_LABEL[c]).join(", ")}). Pass --client <list> to register one anyway.`,
    );
    return [];
  }
  env.log(
    `Register SplitSession with: ${found.map((c) => `[x] ${CLIENT_LABEL[c]}`).join(" ")}`,
  );
  const chosen: ClientKey[] = [];
  for (const c of found) {
    const answer = (await env.ask(`  ${CLIENT_LABEL[c]}? [Y/n] `))
      .trim()
      .toLowerCase();
    if (answer === "" || answer === "y" || answer === "yes") chosen.push(c);
  }
  return chosen;
}

export function install(options: CliOptions, env: Env): number {
  const clients = options.clients ?? [];
  const plat = env.platform ?? platform();
  if (!supported(plat)) {
    env.log(UNSUPPORTED);
    return 1;
  }
  const node = env.node ?? process.execPath;
  const source = env.sourceEntry;
  if (!source || !existsSync(source)) {
    env.log(
      "splitsession-bridge: cannot find the program to install (run it from the built bundle).",
    );
    return 1;
  }
  const targets = targetsOf(options, env);
  const host = hostPaths(options, env);

  mkdirSync(host.dir, { recursive: true, mode: 0o700 });
  if (path.resolve(source) !== path.resolve(host.entry))
    copyFileSync(source, host.entry);
  writeFileSync(
    host.launcher,
    buildLauncher(node, host.entry, options.extensionIds),
  );
  chmodSync(host.launcher, 0o755);
  env.log(`host: ${host.launcher}`);

  const manifest = buildHostManifest(host.launcher, options.extensionIds);
  for (const { name, dir } of targets) {
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, HOST_MANIFEST_FILE);
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
    env.log(`${name}: wrote ${file}`);
  }
  removeOld(targets, host, options, env);

  env.log("");
  const snippets = clientSnippets(node, host.entry);
  const ctx = clientCtx(env, node, host.entry);
  let allRegistered = clients.length > 0;
  if (clients.length === 0) {
    env.log("No AI client was registered. To do it by hand:\n");
    for (const c of CLIENT_KEYS) printClientHelp(c, snippets, ctx, env);
    env.log(
      `Or let this program do it: splitsession-bridge install --client ${CLIENT_KEYS.join(",")}`,
    );
  }
  for (const client of clients) {
    const result = registerClient(client, ctx);
    env.log(result.message);
    if (!result.ok) {
      allRegistered = false;
      env.log("");
      printClientHelp(client, snippets, ctx, env);
    }
  }
  const registered = allRegistered;

  env.log(`Host installed. Next:
${registered ? "" : "\n  1. Register the MCP server with your AI client (above).\n"}
  ${registered ? "1" : "2"}. In Chrome, open SplitSession Settings > "For AI agents" and switch on "Agent bridge" (this needs the SplitSession Full extension).
     Chrome starts the host the moment you do. Turning the switch off closes the connection; nothing is reachable while it is off.

Check it any time with: splitsession-bridge status
Remove everything later with: splitsession-bridge uninstall
(If you used this agent under its old name "Facet", also run: claude mcp remove --scope user ${OLD_MCP_NAME})
`);
  return 0;
}

export function uninstall(options: CliOptions, env: Env): number {
  const plat = env.platform ?? platform();
  if (!supported(plat)) {
    env.log(UNSUPPORTED);
    return 1;
  }
  const targets = targetsOf(options, env);
  const host = hostPaths(options, env);
  for (const { name, dir } of targets) {
    const file = path.join(dir, HOST_MANIFEST_FILE);
    if (existsSync(file)) {
      rmSync(file);
      env.log(`removed ${file}`);
    } else {
      env.log(`${name}: nothing to remove in ${dir}`);
    }
  }
  rmSync(host.launcher, { force: true });
  rmSync(host.entry, { force: true });
  try {
    rmdirSync(host.dir); // only when empty
  } catch {
    /* not empty, or already gone */
  }
  removeOld(targets, host, options, env);
  // With an explicit --dir / --host-dir (tests, a scratch install) the AI clients are left alone unless --client says so.
  const scratch = Boolean(options.dir || options.hostDir);
  const clients = options.clients ?? (scratch ? [] : [...CLIENT_KEYS]);
  if (clients.length > 0) {
    env.log("");
    const ctx = clientCtx(env, env.node ?? process.execPath, host.entry);
    for (const client of clients) env.log(unregisterClient(client, ctx));
  }
  env.log(
    `\n(Registered under the old name "Facet"? claude mcp remove --scope user ${OLD_MCP_NAME})\n`,
  );
  return 0;
}

const SOCKET_TEXT = {
  live: "live: a host is running, so the extension has the bridge switched on",
  stale: "a stale file (no host is running); the next host removes it",
  absent:
    "not there (the bridge is switched off in the extension, or Chrome is closed)",
  unknown: "cannot tell (permissions, or the host did not answer)",
} as const;

/** Read-only report. Exit code 0 when the host program and at least one manifest are in place. */
export async function status(options: CliOptions, env: Env): Promise<number> {
  const plat = env.platform ?? platform();
  const { log } = env;
  log(
    `splitsession-bridge ${env.version ?? "(dev)"} on ${plat}, node ${process.versions.node}`,
  );
  if (!supported(plat)) {
    log(UNSUPPORTED);
    return 1;
  }
  const host = hostPaths(options, env);
  const entryOk = existsSync(host.entry);
  const launcherOk = existsSync(host.launcher);
  log(
    `\nhost program:  ${entryOk && launcherOk ? "installed" : "not installed"} (${host.dir})`,
  );

  let manifests = 0;
  log("host manifests:");
  for (const { name, dir } of targetsOf(options, env)) {
    const file = path.join(dir, HOST_MANIFEST_FILE);
    if (!existsSync(file)) {
      log(`  ${name.padEnd(9)} not installed`);
      continue;
    }
    try {
      const m = JSON.parse(readFileSync(file, "utf8")) as {
        path?: string;
        allowed_origins?: string[];
      };
      const launcherExists = typeof m.path === "string" && existsSync(m.path);
      manifests += 1;
      log(
        `  ${name.padEnd(9)} installed${launcherExists ? "" : " (but its launcher is missing: run install again)"}`,
      );
      log(
        `            allows ${(m.allowed_origins ?? []).join(", ") || "(nothing)"}`,
      );
    } catch {
      log(`  ${name.padEnd(9)} unreadable manifest ${file}`);
    }
  }

  const sock = socketPath(env.process ?? process.env, env.home ?? homedir());
  const state = await probeSocket(sock);
  log(`\nsocket:        ${sock}\n               ${SOCKET_TEXT[state]}`);
  log("\nAI clients (is the MCP server registered?):");
  const ctx = clientCtx(env, env.node ?? process.execPath, host.entry);
  for (const client of options.clients ?? CLIENT_KEYS) {
    const st = clientStatus(client, ctx);
    const text =
      st.state === "registered"
        ? `registered: ${st.detail}`
        : st.state === "stale"
          ? `registered, but not to this host copy: ${st.detail} (run install again)`
          : st.state === "absent"
            ? "not registered"
            : `unreadable: ${st.detail}`;
    log(`  ${CLIENT_LABEL[client].padEnd(15)} ${text}`);
  }
  return entryOk && launcherOk && manifests > 0 ? 0 : 1;
}
