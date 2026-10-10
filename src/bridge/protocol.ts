/** Messages of the Facet agent bridge. Shared by the extension, the native host and the MCP server. */

export const HOST_NAME = 'com.facet.bridge';
/** Fixed by the manifest key (docs/development.md); pinned in the host manifest's `allowed_origins`. */
export const EXTENSION_ID = 'hapfikidacgfgnnajkgnaednpgnhmffk';
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}/`;
export const PROTOCOL_VERSION = 1;

/** Per-tool deadline inside the extension. */
export const TOOL_TIMEOUT_MS = 15_000;
/** The host gives up a little later, so the extension's own timeout error normally wins. */
export const HOST_TIMEOUT_MS = TOOL_TIMEOUT_MS + 5_000;

/** The error a tool gets when the switch was turned off (or the connection dropped) while it was still running. */
export const SWITCHED_OFF = 'the Facet agent bridge was switched off; the action was not performed';

/** What a tool returns: MCP content blocks, built by the extension. */
export type ContentBlock = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
export interface ToolResult {
  content: ContentBlock[];
}

/** host -> extension (stdout of the host). Chrome limits one such message to 1 MiB. */
export type HostToExtension =
  | { type: 'ready'; version: number; socket: string }
  /** The host could not start (e.g. the socket directory is not writable) and is about to exit. */
  | { type: 'fatal'; message: string }
  /** A live host (of another Chrome profile) already holds the socket: this one does not take it over and exits. */
  | { type: 'busy'; reason: string }
  /** How many MCP clients are connected to the host now (sent whenever it changes); 0: the agent is gone. */
  | { type: 'clients'; count: number }
  | { type: 'request'; id: number; tool: string; args: unknown };

/** extension -> host (stdin of the host). */
export type ExtensionToHost =
  | { type: 'response'; id: number; ok: true; result: ToolResult }
  | { type: 'response'; id: number; ok: false; error: string };

/** MCP server -> host over the Unix socket (newline-delimited JSON). */
export interface ClientRequest {
  id: number;
  tool: string;
  args?: unknown;
}

/** host -> MCP server. `bridge` replies to `{id, tool: '__ping'}`. */
export type ClientResponse = { id: number; ok: true; result: ToolResult } | { id: number; ok: false; error: string };

export const PING_TOOL = '__ping';
/** Sent once by an MCP server over a connection it keeps open for as long as it runs: the host counts these as "agents present". */
export const SESSION_TOOL = '__session';

/** Sent by a host that found the socket held by a live host; shown in the popup next to the explanation. */
export const BUSY_REASON = 'another Chrome profile is connected';
