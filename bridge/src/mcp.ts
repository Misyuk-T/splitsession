import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { encodeLine, LineReader } from '../../src/bridge/framing';
import { HOST_TIMEOUT_MS, type ClientResponse, type ToolResult } from '../../src/bridge/protocol';
import { TOOLS, toolByName } from '../../src/bridge/spec';
import { validateArgs } from '../../src/bridge/validate';
import { HOST_MANIFEST_FILE, manifestSearchDirs, socketPath } from './paths';

declare const __VERSION__: string;

const INSTRUCTIONS =
  'Tools to see and operate the user\'s Chrome tabs across all windows, with Facet containers (several logged-in accounts of one site side by side). ' +
  'Start with list_tabs (bridge_info says which Chrome profile you are connected to). A tab\'s "container" says which account it is. Prefer get_tab_text / get_tab_html over screenshots. ' +
  'These tools act inside the user\'s real, logged-in browser: do only what the user asked for.';

/** Why the socket could not be reached, in words the user can act on. */
export function unreachableMessage(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string {
  const installed = manifestSearchDirs(env).some((dir) => exists(path.join(dir, HOST_MANIFEST_FILE)));
  return installed
    ? 'Facet agent bridge is off — turn it on in the Facet popup (the "Agent bridge" switch).'
    : 'Facet agent bridge host is not installed — run `pnpm bridge:install` in the Facet repository, then turn on the "Agent bridge" switch in the Facet popup.';
}

class Unreachable extends Error {}

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

const failure = (text: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text }] });

export async function runMcp(): Promise<void> {
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
    const spec = toolByName(name);
    if (!spec) return failure(`unknown tool "${name}"`);
    const checked = validateArgs(spec.inputSchema, rawArgs);
    if (!checked.ok) return failure(`${name}: ${checked.error}`);
    try {
      const response = await callHost(name, checked.value);
      if (!response.ok) return failure(response.error);
      return response.result as ToolResult as CallToolResult;
    } catch (error) {
      if (error instanceof Unreachable) return failure(unreachableMessage());
      return failure(error instanceof Error ? error.message : String(error));
    }
  });

  await server.connect(new StdioServerTransport());
}
