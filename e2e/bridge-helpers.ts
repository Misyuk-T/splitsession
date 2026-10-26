import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { type BrowserContext, chromium, type Page } from "@playwright/test";

import { EXTENSION_ID } from "./env";
import { apiOf, extensionArgs, isOurWorker, popupPage } from "./extension";
import { expect, type Facet } from "./fixtures";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridgeEntry = path.join(
  root,
  "bridge",
  "dist",
  "splitsession-bridge.mjs",
);
export const MANIFEST = "com.splitsession.bridge.json";

/** Builds the bridge and registers the native host with THIS run's browser profile only (no system directory is touched). */
let built = false;
export function installHost(facet: Facet): void {
  const args = [
    path.join(root, "scripts", "bridge-install.mjs"),
    "--dir",
    facet.profile.nativeHostsDir,
    "--host-dir",
    facet.profile.hostDir,
  ];
  execFileSync(process.execPath, built ? [...args, "--no-build"] : args, {
    stdio: "pipe",
  });
  built = true;
}

export function uninstallHost(facet: Facet): void {
  rmSync(path.join(facet.profile.nativeHostsDir, MANIFEST), { force: true });
}

export interface ToolResponse {
  isError: boolean;
  /** Text blocks joined. */
  text: string;
  /** The text blocks one by one. */
  texts: string[];
  images: Array<{ data: string; mimeType: string }>;
}

export interface Mcp {
  client: Client;
  call(name: string, args?: Record<string, unknown>): Promise<ToolResponse>;
  json<T = any>(name: string, args?: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
}

/** An MCP client that launches the bridge's stdio MCP server the way Claude Code would. */
export async function startMcp(
  facet: Facet,
  manifestDirs: string = facet.profile.nativeHostsDir,
  extraEnv: Record<string, string> = {},
): Promise<Mcp> {
  expect(existsSync(bridgeEntry), "run `node bridge/build.mjs` first").toBe(
    true,
  );
  const client = new Client({ name: "facet-e2e", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bridgeEntry, "mcp"],
    env: {
      ...(process.env as Record<string, string>),
      FACET_BRIDGE_SOCKET: facet.profile.socketPath,
      FACET_BRIDGE_MANIFEST_DIRS: manifestDirs,
      ...extraEnv,
    },
    stderr: "pipe",
  });
  await client.connect(transport);
  const call = async (
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<ToolResponse> => {
    const result = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: Array<{
        type: string;
        text?: string;
        data?: string;
        mimeType?: string;
      }>;
    };
    const texts = result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "");
    return {
      isError: result.isError === true,
      text: texts.join("\n"),
      texts,
      images: result.content
        .filter((c) => c.type === "image")
        .map((c) => ({ data: c.data ?? "", mimeType: c.mimeType ?? "" })),
    };
  };
  return {
    client,
    call,
    async json(name, args) {
      const r = await call(name, args);
      expect(r.isError, `${name} failed: ${r.text}`).toBe(false);
      return JSON.parse(r.texts[0]!);
    },
    close: () => client.close(),
  };
}

/** Opens the popup as a page and returns it with its agent bridge switch (the switch exists only while the bridge is on). */
export async function openPopup(
  facet: Facet,
): Promise<{ page: Page; toggle: ReturnType<Page["getByRole"]> }> {
  const page = await popupPage(facet.ctx);
  return { page, toggle: page.getByRole("switch", { name: /Agent bridge/ }) };
}

/** The bridge sockets of this run: the shared one (protocol 1) and one per Chrome profile (`bridges/<key>.sock`, protocol 2). */
export function bridgeSockets(facet: Facet): string[] {
  const dir = path.join(path.dirname(facet.profile.socketPath), "bridges");
  const found = existsSync(dir)
    ? readdirSync(dir)
        .filter((n) => n.endsWith(".sock"))
        .map((n) => path.join(dir, n))
    : [];
  if (existsSync(facet.profile.socketPath))
    found.push(facet.profile.socketPath);
  return found;
}

/** PIDs of the processes that have a bridge socket of this run open (the hosts; clients only while connected). */
export function hostPids(facet: Facet): number[] {
  const sockets = bridgeSockets(facet);
  if (sockets.length === 0) return [];
  try {
    return [
      ...new Set(
        execFileSync("lsof", ["-t", ...sockets], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        })
          .split("\n")
          .filter(Boolean)
          .map(Number),
      ),
    ];
  } catch (error) {
    // lsof exits 1 when one of the files is not open by anybody, but still prints the others.
    const out = (error as { stdout?: string }).stdout ?? "";
    return [...new Set(out.split("\n").filter(Boolean).map(Number))];
  }
}

/** A second Chrome profile with SplitSession loaded, its own host manifest, and the SAME bridge socket directory as `facet`'s profile. */
export interface SecondProfile {
  ctx: BrowserContext;
  api<T = unknown>(method: string, ...args: unknown[]): Promise<T>;
  popup(): Promise<Page>;
  close(): Promise<void>;
}

export async function startSecondProfile(facet: Facet): Promise<SecondProfile> {
  const userDataDir = mkdtempSync(path.join(tmpdir(), "facet-e2e2-"));
  const nativeHostsDir = path.join(userDataDir, "NativeMessagingHosts");
  mkdirSync(nativeHostsDir);
  execFileSync(
    process.execPath,
    [
      path.join(root, "scripts", "bridge-install.mjs"),
      "--dir",
      nativeHostsDir,
      "--host-dir",
      path.join(userDataDir, "facet-host"),
      "--no-build",
    ],
    { stdio: "pipe" },
  );
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: !process.env.HEADED,
    args: extensionArgs(),
    env: {
      ...(process.env as Record<string, string>),
      FACET_BRIDGE_SOCKET: facet.profile.socketPath,
    },
  });
  const worker = async () =>
    ctx.serviceWorkers().filter(isOurWorker).at(-1) ??
    (await ctx.waitForEvent("serviceworker", {
      predicate: isOurWorker,
      timeout: 15_000,
    }));
  const api = async <T>(method: string, ...args: unknown[]): Promise<T> =>
    apiOf(await worker())<T>(method, ...args);
  await api("listContainers"); // waits for the worker to be ready
  return {
    ctx,
    api,
    popup: () => popupPage(ctx),
    async close() {
      await api("updateSettings", { agentBridge: false }).catch(() => {});
      await ctx.close().catch(() => {});
      rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

/**
 * Registers a stand-in for the bridge program of 0.1.x (protocol 1) with this run's browser profile: it ignores the
 * extension's `hello`, says `ready` with version 1, and stays until Chrome closes its stdin. Enough to see how a newer
 * extension treats an older host.
 */
export function installOldHost(facet: Facet): void {
  const script = path.join(facet.profile.userDataDir, "old-host.mjs");
  writeFileSync(
    script,
    `#!${process.execPath}
const frame = (m) => { const b = Buffer.from(JSON.stringify(m)); const h = Buffer.alloc(4); h.writeUInt32LE(b.length); process.stdout.write(Buffer.concat([h, b])); };
frame({ type: "ready", version: 1, socket: "/nowhere/bridge.sock" });
process.stdin.on("data", () => {});
process.stdin.on("end", () => process.exit(0));
`,
    { mode: 0o755 },
  );
  writeFileSync(
    path.join(facet.profile.nativeHostsDir, MANIFEST),
    JSON.stringify({
      name: "com.splitsession.bridge",
      description: "old SplitSession bridge (test stand-in)",
      path: script,
      type: "stdio",
      allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
    }),
  );
}
