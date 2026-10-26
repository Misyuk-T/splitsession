import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { encodeLine, LineReader } from "../../src/bridge/framing";
import {
  type ClientResponse,
  HOST_TIMEOUT_MS,
  SESSION_TOOL,
} from "../../src/bridge/protocol";
import { HOST_MARGIN_MS, TOOLS, toolTimeoutMs } from "../../src/bridge/spec";
import { type Schema, validateArgs } from "../../src/bridge/validate";
import { type CallContext, Dispatcher, Unreachable } from "./dispatch";
import { LEASE_MUTATING } from "./leases";
import {
  bridgesDir,
  HOST_MANIFEST_FILE,
  manifestSearchDirs,
  socketPath,
} from "./paths";
import { discoverEndpoints, type Endpoint, removeIfStale } from "./profiles";

declare const __VERSION__: string;

const INSTRUCTIONS =
  "Tools to see and operate the user's Chrome tabs across all windows, with SplitSession containers (several logged-in accounts of one site side by side). " +
  'Start with list_tabs. A tab\'s "container" says which account it is, its "profile" which Chrome profile (several can be connected at once; bridge_info lists them). ' +
  "Tools on a tab find the tab's profile by its tabId; to open a new tab while several profiles are connected, pass profile (its name or key). " +
  "To work with a page: snapshot (accessibility tree with refs), then click / type / press_key / select_option by ref; snapshot again after the page changes. Screenshots for what the tree cannot tell. " +
  "These tools act inside the user's real, logged-in browser: do only what the user asked for.";

/** Why the socket could not be reached, in words the user can act on. */
export function unreachableMessage(
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync,
): string {
  const installed = manifestSearchDirs(env).some((dir) =>
    exists(path.join(dir, HOST_MANIFEST_FILE)),
  );
  return installed
    ? 'SplitSession agent bridge is off — turn it on in SplitSession Settings → For AI agents (the "Agent bridge" switch).'
    : 'SplitSession agent bridge host is not installed — run `npx splitsession-bridge install` (from a source checkout: `pnpm bridge:install`), then turn on the "Agent bridge" switch in SplitSession Settings → For AI agents.';
}

export { Unreachable };

const isFile = (p: string): boolean => {
  try {
    return path.isAbsolute(p) && statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * The name this MCP server goes by in the host's tab leases and in "in use by" messages: `CLAUDE_SESSION_NAME`, else the
 * MCP client's own name (known after `initialize`), else "agent", plus a random suffix so two sessions never share one.
 */
export function sessionName(
  base: string | undefined,
  suffix: string = randomBytes(2).toString("hex"),
): string {
  const clean = (base ?? "")
    .replace(/[^A-Za-z0-9 ._-]/g, "")
    .trim()
    .slice(0, 40);
  return `${clean === "" ? "agent" : clean}-${suffix}`;
}

/** The session name of this process; it may be refined once, when the MCP client says who it is. */
export interface Identity {
  name: string;
}

/** One request over the socket: connect, send, wait for the answer, close. A connection per call survives the bridge being switched off and on. */
export function callHost(
  tool: string,
  args: unknown,
  timeoutMs: number = HOST_TIMEOUT_MS + 2_000,
  sock: string = socketPath(),
  ctx?: CallContext,
): Promise<ClientResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(sock);
    const lines = new LineReader();
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };
    const timer = setTimeout(
      () =>
        done(() =>
          reject(
            new Error(
              `the SplitSession bridge did not answer ${tool} within ${Math.round(timeoutMs / 1000)} seconds`,
            ),
          ),
        ),
      timeoutMs,
    );
    socket.setEncoding("utf8");
    socket.on("connect", () =>
      socket.write(
        encodeLine({
          id: 1,
          tool,
          args,
          ...(ctx?.session ? { session: ctx.session } : {}),
          ...(ctx?.takeOver ? { takeOver: true } : {}),
        }),
      ),
    );
    socket.on("data", (chunk: string) => {
      try {
        for (const message of lines.push(chunk)) {
          const response = message as ClientResponse;
          if (response && typeof response === "object" && response.id === 1)
            return done(() => resolve(response));
        }
      } catch (error) {
        done(() => reject(error));
      }
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (
        error.code === "ENOENT" ||
        error.code === "ECONNREFUSED" ||
        error.code === "ENOTSOCK"
      )
        return done(() => reject(new Unreachable(error.code)));
      done(() => reject(error));
    });
    socket.on("close", () =>
      done(() =>
        reject(
          new Error(
            "the SplitSession bridge closed the connection (it was probably switched off)",
          ),
        ),
      ),
    );
  });
}

/**
 * While this MCP server runs it keeps one connection to the host open ("an agent is present"). Tool calls use their own
 * short connections. When this process exits the host sees the connection close and tells the extension, which, after a
 * short grace, takes back what the agent left behind (a viewport override, debugger sessions). Best effort: no host, no
 * presence; it is tried again on every call and every few seconds.
 */
export function keepPresence(
  sock: string = socketPath(),
  identity: Identity = { name: "" },
): {
  ensure(): void;
  announce(): void;
  stop(): void;
} {
  let socket: net.Socket | null = null;
  const hello = () =>
    encodeLine({
      id: 1,
      tool: SESSION_TOOL,
      ...(identity.name ? { session: identity.name } : {}),
    });
  const connect = () => {
    if (socket && !socket.destroyed) return;
    const s = net.createConnection(sock);
    socket = s;
    s.unref();
    s.setEncoding("utf8");
    s.on("connect", () => s.write(hello()));
    s.on("data", () => {}); // the pong; nothing else is ever sent
    s.on("error", () => {});
    s.on("close", () => {
      if (socket === s) socket = null;
    });
  };
  const timer = setInterval(connect, 5_000);
  timer.unref();
  connect();
  return {
    ensure: connect,
    /** The name changed: tell the host over the open connection (it re-registers the name). */
    announce() {
      if (socket && !socket.destroyed && !socket.connecting)
        socket.write(hello());
    },
    stop() {
      clearInterval(timer);
      socket?.destroy();
    },
  };
}

/** One presence connection per connected profile, following the profiles as they are switched on and off. */
export function presenceFor(
  discover: () => Endpoint[],
  identity: Identity = { name: "" },
): {
  sync(): void;
  announce(): void;
  stop(): void;
} {
  const live = new Map<string, ReturnType<typeof keepPresence>>();
  const sync = () => {
    const now = new Set<string>();
    for (const ep of discover()) {
      now.add(ep.socket);
      const known = live.get(ep.socket);
      if (known) known.ensure();
      else live.set(ep.socket, keepPresence(ep.socket, identity));
    }
    for (const [sock, p] of live) {
      if (now.has(sock)) continue;
      p.stop();
      live.delete(sock);
    }
  };
  const timer = setInterval(sync, 5_000);
  timer.unref();
  sync();
  return {
    sync,
    announce() {
      for (const p of live.values()) p.announce();
    },
    stop() {
      clearInterval(timer);
      for (const p of live.values()) p.stop();
      live.clear();
    },
  };
}

const PROFILE_PARAM: Record<"list" | "open" | "tab", Schema> = {
  list: {
    type: "string",
    minLength: 1,
    maxLength: 64,
    description:
      "Only this Chrome profile: its name or key, from bridge_info. Default: every connected profile.",
  },
  open: {
    type: "string",
    minLength: 1,
    maxLength: 64,
    description:
      "The Chrome profile to open it in: its name or key, from bridge_info. Needed when several profiles are connected (unless windowId says it).",
  },
  tab: {
    type: "string",
    minLength: 1,
    maxLength: 64,
    description:
      "The Chrome profile of the tab (name or key). Normally not needed: the tabId finds its profile.",
  },
};

const TAKE_OVER_PARAM: Schema = {
  type: "boolean",
  description:
    "Another agent session is working in this tab (list_tabs shows inUseBy) and such an action is refused. Pass true only when the user asked you to work in that very tab; otherwise open your own tab (open_tab / open_in_container).",
};

/** The tools as the MCP server offers them: the extension's tools plus `profile` (and `takeOver`), which only the MCP server and the host read. */
export const MCP_TOOLS = TOOLS.map((tool) => {
  const kind = ["bridge_info", "list_tabs", "list_containers"].includes(
    tool.name,
  )
    ? "list"
    : ["open_tab", "open_in_container"].includes(tool.name)
      ? "open"
      : "tab";
  return {
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      properties: {
        ...tool.inputSchema.properties,
        profile: PROFILE_PARAM[kind],
        ...(LEASE_MUTATING.has(tool.name) ? { takeOver: TAKE_OVER_PARAM } : {}),
      },
    },
  };
});
const mcpToolByName = (name: string) => MCP_TOOLS.find((t) => t.name === name);

/** The dispatcher of the real server: sockets on disk, one connection per call. */
export function liveDispatcher(
  env: NodeJS.ProcessEnv = process.env,
  identity: Identity = { name: "" },
): Dispatcher {
  return new Dispatcher({
    discover: () => discoverEndpoints(bridgesDir(env), socketPath(env)),
    session: () => identity.name || undefined,
    call: (ep, tool, args, ctx) =>
      callHost(
        tool,
        args,
        toolTimeoutMs(tool) + HOST_MARGIN_MS + 2_000,
        ep.socket,
        ctx,
      ),
    unreachable: () => unreachableMessage(env),
    gone: (ep) => void removeIfStale(ep),
  });
}

const failure = (text: string): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text }],
});

export async function runMcp(): Promise<void> {
  const fromEnv = process.env.CLAUDE_SESSION_NAME;
  const identity: Identity = { name: sessionName(fromEnv) };
  const presence = presenceFor(() => discoverEndpoints(), identity);
  const dispatcher = liveDispatcher(process.env, identity);
  const server = new Server(
    { name: "splitsession", version: __VERSION__ },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  // Without CLAUDE_SESSION_NAME the MCP client's own name (e.g. "claude-code") says better who this session is.
  server.oninitialized = () => {
    const client = server.getClientVersion()?.name;
    if (!fromEnv && client) {
      identity.name = sessionName(client, identity.name.split("-").pop());
      presence.announce();
    }
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: MCP_TOOLS.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema as never,
      annotations: {
        title: tool.title,
        readOnlyHint: tool.readOnly,
        destructiveHint: !tool.readOnly && ["close_tab"].includes(tool.name),
        openWorldHint: true,
      },
    })),
  }));

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request): Promise<CallToolResult> => {
      const { name, arguments: rawArgs } = request.params;
      presence.sync();
      const spec = mcpToolByName(name);
      if (!spec) return failure(`unknown tool "${name}"`);
      const checked = validateArgs(spec.inputSchema, rawArgs);
      if (!checked.ok) return failure(`${name}: ${checked.error}`);
      try {
        if (name === "upload_file") {
          const missing = (checked.value.paths as string[]).find(
            (p) => !isFile(p),
          );
          if (missing)
            return failure(
              `upload_file: ${missing} is not a file on this computer`,
            );
        }
        return await dispatcher.run(name, checked.value);
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
    },
  );

  await server.connect(new StdioServerTransport());
}
