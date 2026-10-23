/** Messages of the SplitSession agent bridge. Shared by the extension, the native host and the MCP server. */

export const HOST_NAME = "com.splitsession.bridge";
/** Fixed by the manifest key (docs/development.md); pinned in the host manifest's `allowed_origins`. */
export const EXTENSION_ID = "hapfikidacgfgnnajkgnaednpgnhmffk";
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}/`;
/**
 * 2: several Chrome profiles at once. The extension opens with `hello` (its profile key); the host listens on a socket of
 * its own per profile. 1: one socket for everybody (0.1.x). A host that gets no `hello` speaks 1 (an older extension).
 */
export const PROTOCOL_VERSION = 2;
/** The first protocol in which the extension says `hello` and every profile has a socket of its own. */
export const MULTI_PROFILE_PROTOCOL = 2;

/**
 * A profile key: generated once per Chrome profile by the extension (`chrome.storage.local`), the name of that profile's
 * socket file. Short on purpose: a Unix socket path is at most 104 bytes on macOS.
 */
export const PROFILE_KEY_RE = /^[a-z0-9]{6,16}$/;
export const PROFILE_KEY_LENGTH = 10;

/** Per-tool deadline inside the extension. */
export const TOOL_TIMEOUT_MS = 15_000;
/** The host gives up a little later, so the extension's own timeout error normally wins. */
export const HOST_TIMEOUT_MS = TOOL_TIMEOUT_MS + 5_000;

/** The error a tool gets when the switch was turned off (or the connection dropped) while it was still running. */
export const SWITCHED_OFF =
  "the SplitSession agent bridge was switched off; the action was not performed";

/** What a tool returns: MCP content blocks, built by the extension. */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };
export interface ToolResult {
  content: ContentBlock[];
}

/** host -> extension (stdout of the host). Chrome limits one such message to 1 MiB. */
export type HostToExtension =
  | {
      type: "ready";
      version: number;
      socket: string;
      /** The key the host serves (protocol 2+): it is the name of its socket file. */
      profileKey?: string;
      /** The host process's session ID (protocol 2+), also stamped on every answer to the MCP server. */
      session?: string;
    }
  /** The host could not start (e.g. the socket directory is not writable) and is about to exit. */
  | { type: "fatal"; message: string }
  /**
   * A live host already holds the socket this one wanted, so it does not take it over and exits. Protocol 1: another Chrome
   * profile has the one shared socket. Protocol 2 (`code: "same-profile"`): a host for this very profile key is still running
   * (a quick off and on), or another profile carries the same key (a copied profile directory).
   */
  | { type: "busy"; reason: string; code?: "same-profile" }
  /** How many Chrome profiles have the bridge on now (sockets in the directory, this one included); sent when it changes. */
  | { type: "profiles"; count: number }
  /** How many MCP clients are connected to the host now (sent whenever it changes); 0: the agent is gone. */
  | { type: "clients"; count: number }
  | { type: "request"; id: number; tool: string; args: unknown };

/** extension -> host (stdin of the host). */
export type ExtensionToHost =
  /** The first message, posted right after `connectNative` (protocol 2+). A 0.1.x host ignores it. */
  | { type: "hello"; version: number; profileKey: string }
  | { type: "response"; id: number; ok: true; result: ToolResult }
  | { type: "response"; id: number; ok: false; error: string };

/** MCP server -> host over the Unix socket (newline-delimited JSON). */
export interface ClientRequest {
  id: number;
  tool: string;
  args?: unknown;
}

/**
 * host -> MCP server. `bridge` replies to `{id, tool: '__ping'}`. `session` (bridge 0.2+): a random ID of the host process
 * that answered, the same on every answer it gives; a new host (switch off and on, Chrome restarted) has a new one.
 */
export type ClientResponse = (
  | { id: number; ok: true; result: ToolResult }
  | { id: number; ok: false; error: string }
) & { session?: string };

export const PING_TOOL = "__ping";
/** Sent once by an MCP server over a connection it keeps open for as long as it runs: the host counts these as "agents present". */
export const SESSION_TOOL = "__session";
/**
 * Asked by the MCP server, answered by the extension itself (protocol 2): never an agent action, so never counted or listed.
 * `__profile`: `{profileKey, profileLabel}`. `__tabs`: `[{tabId, windowId}]` of every tab, to find which profile has a tab.
 * An extension of 0.1.x answers "pong" to both (it treats every `__` tool as internal).
 */
export const PROFILE_TOOL = "__profile";
export const TABS_TOOL = "__tabs";

/** Sent by a host that found the socket held by a live host; shown in the popup next to the explanation. */
export const BUSY_REASON = "another Chrome profile is connected";
/** Protocol 2: the per-profile socket is held by a live host with the same key. */
export const SAME_PROFILE_REASON =
  "a bridge host for this Chrome profile is already running";

/** What the user runs to get a host that speaks the current protocol. */
export const UPDATE_COMMAND = "npx splitsession-bridge@latest install";
