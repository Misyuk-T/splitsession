import { HOST_TIMEOUT_MS, PING_TOOL, type ClientResponse, type HostToExtension, type ToolResult } from '../../src/bridge/protocol';

interface Pending {
  clientId: number;
  clientRequestId: number;
  timer: ReturnType<typeof setTimeout>;
}

export interface RelayOptions {
  /** Writes one message to the extension; throws (FrameError) when it cannot be sent, e.g. it is over Chrome's 1 MiB cap. */
  sendToExtension(message: HostToExtension): void;
  timeoutMs?: number;
}

/**
 * The host's brain, independent of sockets and stdio: takes requests from any number of socket clients, numbers them
 * globally, sends them to the extension, and routes the extension's answers back. Every request has a deadline, and
 * when the extension goes away everything still waiting is answered with an error.
 */
export class Relay {
  private readonly clients = new Map<number, (response: ClientResponse) => void>();
  private readonly pending = new Map<number, Pending>();
  private nextClient = 1;
  private nextRequest = 1;
  private readonly timeoutMs: number;
  private closed: string | null = null;

  constructor(private readonly options: RelayOptions) {
    this.timeoutMs = options.timeoutMs ?? HOST_TIMEOUT_MS;
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
    for (const [id, p] of this.pending) {
      if (p.clientId !== clientId) continue;
      clearTimeout(p.timer);
      this.pending.delete(id);
    }
  }

  /** One request line from a client. Malformed input is answered with an error when it has an id, else ignored. */
  handleClient(clientId: number, raw: unknown): void {
    const msg = raw as { id?: unknown; tool?: unknown; args?: unknown } | null;
    if (!msg || typeof msg !== 'object' || typeof msg.id !== 'number') return;
    const reply = (response: ClientResponse) => this.clients.get(clientId)?.(response);
    const requestId = msg.id;
    if (typeof msg.tool !== 'string' || msg.tool === '') return reply({ id: requestId, ok: false, error: 'request has no tool name' });
    if (this.closed) return reply({ id: requestId, ok: false, error: this.closed });
    if (msg.tool === PING_TOOL) return reply({ id: requestId, ok: true, result: { content: [{ type: 'text', text: 'pong' }] } });

    const id = this.nextRequest++;
    try {
      this.options.sendToExtension({ type: 'request', id, tool: msg.tool, args: msg.args });
    } catch (error) {
      return reply({ id: requestId, ok: false, error: `could not send the request to Chrome: ${error instanceof Error ? error.message : String(error)}` });
    }
    const timer = setTimeout(() => {
      this.pending.delete(id);
      reply({ id: requestId, ok: false, error: `Chrome did not answer ${msg.tool} within ${Math.round(this.timeoutMs / 1000)} seconds` });
    }, this.timeoutMs);
    this.pending.set(id, { clientId, clientRequestId: requestId, timer });
  }

  /** A message from the extension. Only answers to requests are meaningful here. */
  handleExtension(raw: unknown): void {
    const msg = raw as { type?: unknown; id?: unknown; ok?: unknown; result?: unknown; error?: unknown } | null;
    if (!msg || typeof msg !== 'object' || msg.type !== 'response' || typeof msg.id !== 'number') return;
    const p = this.pending.get(msg.id);
    if (!p) return; // late answer to a request that timed out or whose client left
    clearTimeout(p.timer);
    this.pending.delete(msg.id);
    const write = this.clients.get(p.clientId);
    if (!write) return;
    if (msg.ok === true) write({ id: p.clientRequestId, ok: true, result: msg.result as ToolResult });
    else write({ id: p.clientRequestId, ok: false, error: typeof msg.error === 'string' ? msg.error : 'the extension reported an error' });
  }

  /** The extension disconnected (switched off, or Chrome quit): answer everything waiting, refuse the rest. */
  extensionGone(reason: string): void {
    this.closed = reason;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      this.clients.get(p.clientId)?.({ id: p.clientRequestId, ok: false, error: reason });
    }
  }
}
