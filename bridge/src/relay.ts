import {
  cleanAgentName,
  type ClientResponse,
  type HostToExtension,
  PING_TOOL,
  SESSION_TOOL,
  SITE_WAIT_CAP_MS,
  TAB_URL_TOOL,
  type ToolResult,
} from "../../src/bridge/protocol";
import { HOST_MARGIN_MS, toolTimeoutMs } from "../../src/bridge/spec";
import {
  cleanSessionName,
  LEASE_MUTATING,
  LEASE_OPENING,
  Leases,
} from "./leases";
import { paceTarget, siteKey, SitePacer } from "./pacing";

/** A request held back to keep its site's pace. */
interface Waiting {
  clientId: number;
  clientRequestId: number;
  timer: ReturnType<typeof setTimeout>;
}

/** How long the host waits for the extension to say which address a tab shows. */
const TAB_URL_WAIT_MS = 3_000;

interface Pending {
  /** The host's own question to the extension (not a client's request): gets the answer's text, or null on any failure. */
  internal?: (text: string | null) => void;
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
  /** Minimum gap between actions that reach the same site (ms); 0 or absent: no pacing. The host passes 1500 unless the env says otherwise. */
  siteGapMs?: number;
  /** Longest a request waits for its site's turn before it is answered "site busy"; default 30 s. */
  siteWaitCapMs?: number;
  /** The clock of the pacing (tests). */
  now?: () => number;
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
  private readonly pacer: SitePacer | null;
  private readonly waiting = new Map<number, Waiting>();
  private nextWait = 1;
  private nextClient = 1;
  private nextRequest = 1;
  private readonly timeoutMs: number | undefined;
  private closed: string | null = null;

  constructor(private readonly options: RelayOptions) {
    this.timeoutMs = options.timeoutMs;
    this.leases = options.leases ?? new Leases();
    this.pacer =
      options.siteGapMs && options.siteGapMs > 0
        ? new SitePacer(
            options.siteGapMs,
            options.siteWaitCapMs ?? SITE_WAIT_CAP_MS,
            options.now,
          )
        : null;
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
    for (const [id, w] of this.waiting) {
      if (w.clientId !== clientId) continue;
      clearTimeout(w.timer);
      this.waiting.delete(id);
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

    const tool = msg.tool;
    const forward = () =>
      this.forward(clientId, requestId, tool, msg.args, session, lease);
    const target = this.pacer ? paceTarget(tool, msg.args) : null;
    if (!target) return forward();
    // An action that reaches a site's server: it waits for the site's turn (every session of this profile shares the queue).
    const turn = (site: string | null) => {
      if (site === null || !this.pacer) return forward();
      const delay = this.pacer.reserve(site);
      if (delay === null) {
        const cap = Math.round(
          (this.options.siteWaitCapMs ?? SITE_WAIT_CAP_MS) / 1000,
        );
        return reply({
          id: requestId,
          ok: false,
          error: `site busy: ${site} already has more than ${cap} seconds of agent actions queued (the host spaces them ${this.pacer.gapMs} ms apart); try again later or work on another site meanwhile`,
        });
      }
      if (delay <= 0) return forward();
      const waitId = this.nextWait++;
      const timer = setTimeout(() => {
        this.waiting.delete(waitId);
        if (this.closed)
          return reply({ id: requestId, ok: false, error: this.closed });
        forward();
      }, delay);
      this.waiting.set(waitId, { clientId, clientRequestId: requestId, timer });
    };
    if (target.kind === "url") return turn(siteKey(target.url));
    void this.tabSite(target.tabId).then((site) => {
      if (!this.clients.has(clientId)) return; // the client left while the extension was asked
      if (this.closed)
        return reply({ id: requestId, ok: false, error: this.closed });
      turn(site);
    });
  }

  /** Sends one request to the extension and remembers who waits for the answer. */
  private forward(
    clientId: number,
    requestId: number,
    tool: string,
    args: unknown,
    session: string | null,
    lease: Pending["lease"],
  ): void {
    const reply = (response: ClientResponse) =>
      this.clients.get(clientId)?.(response);
    const agent = cleanAgentName(session);
    const id = this.nextRequest++;
    try {
      this.options.sendToExtension({
        type: "request",
        id,
        tool,
        args,
        ...(agent ? { session: agent } : {}),
      });
    } catch (error) {
      return reply({
        id: requestId,
        ok: false,
        error: `could not send the request to Chrome: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    const timeoutMs = this.timeoutMs ?? toolTimeoutMs(tool) + HOST_MARGIN_MS;
    const timer = setTimeout(() => {
      this.pending.delete(id);
      reply({
        id: requestId,
        ok: false,
        error: `Chrome did not answer ${tool} within ${Math.round(timeoutMs / 1000)} seconds`,
      });
    }, timeoutMs);
    this.pending.set(id, {
      clientId,
      clientRequestId: requestId,
      timer,
      ...(lease ? { lease } : {}),
    });
  }

  /** The site a tab shows now, asked of the extension; null when it cannot say (an older extension, a tab without a site, a timeout). */
  private tabSite(tabId: number): Promise<string | null> {
    return new Promise((resolve) => {
      const id = this.nextRequest++;
      const done = (text: string | null) => {
        let url: unknown = null;
        try {
          if (text !== null) url = (JSON.parse(text) as { url?: unknown }).url;
        } catch {
          /* "pong" from an extension that does not know the question */
        }
        resolve(typeof url === "string" ? siteKey(url) : null);
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        done(null);
      }, TAB_URL_WAIT_MS);
      this.pending.set(id, {
        clientId: 0,
        clientRequestId: 0,
        timer,
        internal: done,
      });
      try {
        this.options.sendToExtension({
          type: "request",
          id,
          tool: TAB_URL_TOOL,
          args: { tabId },
        });
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        done(null);
      }
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
    if (p.internal) {
      const block = (msg.result as ToolResult | undefined)?.content?.find(
        (c) => c.type === "text",
      ) as { text?: unknown } | undefined;
      p.internal(
        msg.ok === true && typeof block?.text === "string" ? block.text : null,
      );
      return;
    }
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
    for (const [id, w] of this.waiting) {
      clearTimeout(w.timer);
      this.waiting.delete(id);
      this.clients.get(w.clientId)?.({
        id: w.clientRequestId,
        ok: false,
        error: reason,
      });
    }
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      if (p.internal) {
        p.internal(null);
        continue;
      }
      this.clients.get(p.clientId)?.({
        id: p.clientRequestId,
        ok: false,
        error: reason,
      });
    }
  }
}
