import { existsSync, statSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { encodeLine, LineReader } from '../../src/bridge/framing';
import { HOST_TIMEOUT_MS, SESSION_TOOL, type ClientResponse, type ToolResult } from '../../src/bridge/protocol';
import { HOST_MARGIN_MS, TOOLS, toolByName, toolTimeoutMs } from '../../src/bridge/spec';
import { validateArgs } from '../../src/bridge/validate';
import { HOST_MANIFEST_FILE, manifestSearchDirs, socketPath } from './paths';

declare const __VERSION__: string;

const INSTRUCTIONS =
  'Tools to see and operate the user\'s Chrome tabs across all windows, with Facet containers (several logged-in accounts of one site side by side). ' +
  'Start with list_tabs (bridge_info says which Chrome profile you are connected to). A tab\'s "container" says which account it is. ' +
  'To work with a page: snapshot (accessibility tree with refs), then click / type / press_key / select_option by ref; snapshot again after the page changes. Screenshots for what the tree cannot tell. ' +
  'These tools act inside the user\'s real, logged-in browser: do only what the user asked for.';

/** Why the socket could not be reached, in words the user can act on. */
export function unreachableMessage(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string {
  const installed = manifestSearchDirs(env).some((dir) => exists(path.join(dir, HOST_MANIFEST_FILE)));
  return installed
    ? 'Facet agent bridge is off — turn it on in the Facet popup (the "Agent bridge" switch).'
    : 'Facet agent bridge host is not installed — run `pnpm bridge:install` in the Facet repository, then turn on the "Agent bridge" switch in the Facet popup.';
}

class Unreachable extends Error {}

const isFile = (p: string): boolean => {
  try {
    return path.isAbsolute(p) && statSync(p).isFile();
  } catch {
    return false;
  }
};

/** One request over the socket: connect, send, wait for the answer, close. A connection per call survives the bridge being switched off and on. */
export function callHost(tool: string, args: unknown, timeoutMs: number = HOST_TIMEOUT_MS + 2_000, sock: string = socketPath()): Promise<ClientResponse> {
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
    const timer = setTimeout(() => done(() => reject(new Error(`the Facet bridge did not answer ${tool} within ${Math.round(timeoutMs / 1000)} seconds`))), timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(encodeLine({ id: 1, tool, args })));
    socket.on('data', (chunk: string) => {
      try {
        for (const message of lines.push(chunk)) {
          const response = message as ClientResponse;
          if (response && typeof response === 'object' && response.id === 1) return done(() => resolve(response));
        }
      } catch (error) {
        done(() => reject(error));
      }
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED' || error.code === 'ENOTSOCK') return done(() => reject(new Unreachable(error.code)));
      done(() => reject(error));
    });
    socket.on('close', () => done(() => reject(new Error('the Facet bridge closed the connection (it was probably switched off)'))));
  });
}

/**
 * While this MCP server runs it keeps one connection to the host open ("an agent is present"). Tool calls use their own
 * short connections. When this process exits the host sees the connection close and tells the extension, which, after a
 * short grace, takes back what the agent left behind (a viewport override, debugger sessions). Best effort: no host, no
 * presence; it is tried again on every call and every few seconds.
 */
export function keepPresence(sock: string = socketPath()): { ensure(): void; stop(): void } {
  let socket: net.Socket | null = null;
  const connect = () => {
    if (socket && !socket.destroyed) return;
    const s = net.createConnection(sock);
    socket = s;
    s.unref();
    s.setEncoding('utf8');
    s.on('connect', () => s.write(encodeLine({ id: 1, tool: SESSION_TOOL })));
    s.on('data', () => {}); // the pong; nothing else is ever sent
    s.on('error', () => {});
    s.on('close', () => {
      if (socket === s) socket = null;
    });
  };
  const timer = setInterval(connect, 5_000);
  timer.unref();
  connect();
  return {
    ensure: connect,
    stop() {
      clearInterval(timer);
      socket?.destroy();
    },
  };
}

const failure = (text: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text }] });

export async function runMcp(): Promise<void> {
  const presence = keepPresence();
  const server = new Server({ name: 'facet', version: __VERSION__ }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema as never,
      annotations: { title: tool.title, readOnlyHint: tool.readOnly, destructiveHint: !tool.readOnly && ['close_tab'].includes(tool.name), openWorldHint: true },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: rawArgs } = request.params;
    presence.ensure();
    const spec = toolByName(name);
    if (!spec) return failure(`unknown tool "${name}"`);
    const checked = validateArgs(spec.inputSchema, rawArgs);
    if (!checked.ok) return failure(`${name}: ${checked.error}`);
    try {
      if (name === 'upload_file') {
        const missing = (checked.value.paths as string[]).find((p) => !isFile(p));
        if (missing) return failure(`upload_file: ${missing} is not a file on this computer`);
      }
      const response = await callHost(name, checked.value, toolTimeoutMs(name) + HOST_MARGIN_MS + 2_000);
      if (!response.ok) return failure(response.error);
      return response.result as ToolResult as CallToolResult;
    } catch (error) {
      if (error instanceof Unreachable) return failure(unreachableMessage());
      return failure(error instanceof Error ? error.message : String(error));
    }
  });

  await server.connect(new StdioServerTransport());
}
