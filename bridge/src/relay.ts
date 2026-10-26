import {
  type ClientResponse,
  type HostToExtension,
  PING_TOOL,
  SESSION_TOOL,
  type ToolResult,
} from "../../src/bridge/protocol";
import { HOST_MARGIN_MS, toolTimeoutMs } from "../../src/bridge/spec";
import {
  cleanSessionName,
  LEASE_MUTATING,
  LEASE_OPENING,
  Leases,
} from "./leases";

interface Pending {
  clientId: number;
  clientRequestId: number;
  timer: ReturnType<typeof setTimeout>;
  /** Set for requests that carry a session name: what to do with the answer (leases). */
  lease?: { session: string; tool: string; tabId: number | null };
}

export interface RelayOptions {
  /** Writes one message to the extension; throws (FrameError) when it cannot be sent, e.g. it is over Chrome's 1 MiB cap. */
  sendToExtension(message: HostToExtension): void;
  /** Fixed deadline for every request (tests); by default each tool's own deadline plus a margin. */
  timeoutMs?: number;
  /** Tab leases; by default a fresh set with the real clock. */
  leases?: Leases;
}

/**
 * The host's brain, independent of sockets and stdio: takes requests from any number of socket clients, numbers them
 * globally, sends them to the extension, and routes the extension's answers back. Every request has a deadline, and
 * when the extension goes away everything still waiting is answered with an error.
 */
export class Relay {
  private readonly clients = new Map<
    number,
    (response: ClientResponse) => void
  >();

  private readonly pending = new Map<number, Pending>();
  /** Clients that registered with `__session`: an MCP server that is running (its connection stays open). */
  private readonly sessions = new Set<number>();
  /** The session name each presence connection (`__session`) announced: when the last one of a name goes, its leases go. */
  private readonly names = new Map<number, string>();
  private readonly leases: Leases;
  private nextClient = 1;
  private nextRequest = 1;
  private readonly timeoutMs: number | undefined;
  private closed: string | null = null;

  constructor(private readonly options: RelayOptions) {
    this.timeoutMs = options.timeoutMs;
    this.leases = options.leases ?? new Leases();
  }

  get clientCount(): number {
    return this.clients.size;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  addClient(write: (response: ClientResponse) => void): number {
    const id = this.nextClient++;
    this.clients.set(id, write);
    return id;
  }

  /** The client went away: its requests are forgotten (the extension still finishes them, the answers are dropped). */
  removeClient(clientId: number): void {
    this.clients.delete(clientId);
    if (this.sessions.delete(clientId)) this.announceSessions();
    this.forgetName(clientId);
    for (const [id, p] of this.pending) {
      if (p.clientId !== clientId) continue;
      clearTimeout(p.timer);
      this.pending.delete(id);
    }
  }

  /** One request line from a client. Malformed input is answered with an error when it has an id, else ignored. */
  handleClient(clientId: number, raw: unknown): void {
    const msg = raw as {
      id?: unknown;
      tool?: unknown;
      args?: unknown;
      session?: unknown;
      takeOver?: unknown;
    } | null;
    if (!msg || typeof msg !== "object" || typeof msg.id !== "number") return;
    const reply = (response: ClientResponse) =>
      this.clients.get(clientId)?.(response);
    const requestId = msg.id;
    if (typeof msg.tool !== "string" || msg.tool === "")
      return reply({
        id: requestId,
        ok: false,
        error: "request has no tool name",
      });
    if (this.closed)
      return reply({ id: requestId, ok: false, error: this.closed });
    // Bridge 0.3+ MCP servers name their session in the envelope (not in `args`: the extension never sees it).
    const session = cleanSessionName(msg.session);
    if (msg.tool === SESSION_TOOL) {
      if (session !== null && this.names.get(clientId) !== session) {
        this.forgetName(clientId);
        this.names.set(clientId, session);
      }
      if (!this.sessions.has(clientId)) {
        this.sessions.add(clientId);
        this.announceSessions();
      }
      return reply({
        id: requestId,
        ok: true,
        result: { content: [{ type: "text", text: "pong" }] },
      });
    }
    if (msg.tool === PING_TOOL)
      return reply({
        id: requestId,
        ok: true,
        result: { content: [{ type: "text", text: "pong" }] },
      });

    let lease: Pending["lease"];
    if (session !== null) {
      const tabId = (msg.args as { tabId?: unknown } | null | undefined)?.tabId;
      const onTab = typeof tabId === "number" ? tabId : null;
      if (LEASE_MUTATING.has(msg.tool) && onTab !== null) {
        const refused = this.leases.refusal(
          session,
          onTab,
          msg.takeOver === true,
        );
        if (refused) return reply({ id: requestId, ok: false, error: refused });
        this.leases.grant(session, onTab);
      }
      if (
        LEASE_MUTATING.has(msg.tool) ||
        LEASE_OPENING.has(msg.tool) ||
        msg.tool === "list_tabs"
      )
        lease = { session, tool: msg.tool, tabId: onTab };
    }

    const id = this.nextRequest++;
    try {
      this.options.sendToExtension({
        type: "request",
        id,
        tool: msg.tool,
        args: msg.args,
      });
    } catch (error) {
      return reply({
        id: requestId,
        ok: false,
        error: `could not send the request to Chrome: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    const timeoutMs =
      this.timeoutMs ?? toolTimeoutMs(msg.tool) + HOST_MARGIN_MS;
    const timer = setTimeout(() => {
      this.pending.delete(id);
      reply({
        id: requestId,
        ok: false,
        error: `Chrome did not answer ${msg.tool} within ${Math.round(timeoutMs / 1000)} seconds`,
      });
    }, timeoutMs);
    this.pending.set(id, {
      clientId,
      clientRequestId: requestId,
      timer,
      ...(lease ? { lease } : {}),
    });
  }

  /** The presence connection of a name is gone (or renamed): with no other left under that name, its leases are free. */
  private forgetName(clientId: number): void {
    const name = this.names.get(clientId);
    if (name === undefined) return;
    this.names.delete(clientId);
    if (![...this.names.values()].includes(name)) this.leases.releaseAll(name);
  }

  /** Tells the extension how many agents are present now, so it can let go of what a vanished one left behind. */
  private announceSessions(): void {
    try {
      this.options.sendToExtension({
        type: "clients",
        count: this.sessions.size,
      });
    } catch {
      /* the extension is gone or the pipe is full: it will find out by itself */
    }
  }

  /** A message from the extension. Only answers to requests are meaningful here. */
  handleExtension(raw: unknown): void {
    const msg = raw as {
      type?: unknown;
      id?: unknown;
      ok?: unknown;
      result?: unknown;
      error?: unknown;
    } | null;
    if (
      !msg ||
      typeof msg !== "object" ||
      msg.type !== "response" ||
      typeof msg.id !== "number"
    )
      return;
    const p = this.pending.get(msg.id);
    if (!p) return; // late answer to a request that timed out or whose client left
    clearTimeout(p.timer);
    this.pending.delete(msg.id);
    const write = this.clients.get(p.clientId);
    const result =
      p.lease && msg.ok === true
        ? this.afterAnswer(p.lease, msg.result as ToolResult)
        : (msg.result as ToolResult);
    if (!write) return;
    if (msg.ok === true)
      write({
        id: p.clientRequestId,
        ok: true,
        result,
      });
    else
      write({
        id: p.clientRequestId,
        ok: false,
        error:
          typeof msg.error === "string"
            ? msg.error
            : "the extension reported an error",
      });
  }

  /**
   * A successful answer to a leased tool: a tab that was opened (or replaced by a domain rule) is held by the caller, a
   * closed one is free, and `list_tabs` shows who holds what. Returns the (possibly annotated) result.
   */
  private afterAnswer(
    lease: NonNullable<Pending["lease"]>,
    result: ToolResult,
  ): ToolResult {
    const block = result?.content?.find((c) => c.type === "text") as
      { type: "text"; text: string } | undefined;
    let value: unknown;
    try {
      value = block ? JSON.parse(block.text) : undefined;
    } catch {
      value = undefined;
    }
    if (lease.tool === "close_tab") {
      if (lease.tabId !== null) this.leases.release(lease.tabId);
    } else if (lease.tool === "list_tabs") {
      if (Array.isArray(value) && block)
        return {
          ...result,
          content: result.content.map((c) =>
            c === block
              ? {
                  type: "text" as const,
                  text: JSON.stringify(
                    this.leases.annotate(value as unknown[], lease.session),
                  ),
                }
              : c,
          ),
        };
    } else {
      const newId = (value as { tabId?: unknown } | null | undefined)?.tabId;
      if (typeof newId === "number") {
        // A tab the caller opened, or the one that replaced its tab.
        if (lease.tabId !== null && lease.tabId !== newId)
          this.leases.release(lease.tabId);
        this.leases.grant(lease.session, newId);
      }
    }
    return result;
  }

  /** The extension disconnected (switched off, or Chrome quit): answer everything waiting, refuse the rest. */
  extensionGone(reason: string): void {
    this.closed = reason;
    this.leases.clear();
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      this.clients.get(p.clientId)?.({
        id: p.clientRequestId,
        ok: false,
        error: reason,
      });
    }
  }
}
