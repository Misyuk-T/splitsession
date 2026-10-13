/**
 * Chrome's native-messaging framing: each message is a 4-byte length (native byte order; every platform Chrome runs on
 * is little-endian) followed by that many bytes of UTF-8 JSON. Pure, no Node or DOM APIs: used by the bridge host and
 * by tests.
 *
 * Limits (Chrome): a message FROM the host TO the extension may be at most 1 MiB; one from the extension to the host
 * at most 4 GiB. Requests (host -> extension) are small by design; results (extension -> host) may be large and are
 * limited by the tools themselves (`maxChars`, screenshot size), not chunked.
 */

/** Largest message the host may send to the extension. */
export const MAX_HOST_TO_EXTENSION_BYTES = 1024 * 1024;
/** Generous bound on what the host accepts from the extension (a base64 screenshot is a few MiB). */
export const MAX_EXTENSION_TO_HOST_BYTES = 256 * 1024 * 1024;

export class FrameError extends Error {}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Length prefix + JSON body. Throws FrameError when the body is larger than `maxBytes`. */
export function encodeFrame(
  message: unknown,
  maxBytes: number = MAX_HOST_TO_EXTENSION_BYTES,
): Uint8Array {
  const json = JSON.stringify(message);
  if (json === undefined)
    throw new FrameError("message is not JSON-serializable");
  const body = encoder.encode(json);
  if (body.length > maxBytes)
    throw new FrameError(
      `message is ${body.length} bytes; the limit is ${maxBytes}`,
    );
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length, true);
  out.set(body, 4);
  return out;
}

/**
 * Incremental decoder. `push` accepts chunks of any size (a frame may arrive in pieces, or several frames in one
 * chunk) and returns the messages completed by that chunk. Throws FrameError on an oversize or undecodable frame; the
 * reader must not be used afterwards.
 */
export class FrameReader {
  private chunks: Uint8Array[] = [];
  private buffered = 0;
  private need: number | null = null; // body length once the header is known

  constructor(
    private readonly maxBytes: number = MAX_EXTENSION_TO_HOST_BYTES,
  ) {}

  push(chunk: Uint8Array): unknown[] {
    const out: unknown[] = [];
    if (chunk.length > 0) {
      this.chunks.push(chunk);
      this.buffered += chunk.length;
    }
    for (;;) {
      if (this.need === null) {
        if (this.buffered < 4) break;
        const header = this.take(4);
        const length = new DataView(
          header.buffer,
          header.byteOffset,
          4,
        ).getUint32(0, true);
        if (length > this.maxBytes)
          throw new FrameError(
            `frame of ${length} bytes exceeds the limit of ${this.maxBytes}`,
          );
        this.need = length;
      }
      if (this.buffered < this.need) break;
      const body = this.take(this.need);
      this.need = null;
      let text: string;
      try {
        text = decoder.decode(body);
        out.push(JSON.parse(text));
      } catch (error) {
        throw new FrameError(
          `undecodable frame: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return out;
  }

  /** Bytes of an incomplete frame still waiting for more data. */
  get pending(): number {
    return this.buffered;
  }

  private take(n: number): Uint8Array {
    this.buffered -= n;
    if (n === 0) return new Uint8Array(0);
    const first = this.chunks[0]!;
    if (first.length >= n) {
      const piece = first.subarray(0, n);
      if (first.length === n) this.chunks.shift();
      else this.chunks[0] = first.subarray(n);
      return piece;
    }
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const c = this.chunks[0]!;
      const want = Math.min(c.length, n - filled);
      out.set(c.subarray(0, want), filled);
      filled += want;
      if (want === c.length) this.chunks.shift();
      else this.chunks[0] = c.subarray(want);
    }
    return out;
  }
}

/**
 * Newline-delimited JSON, used on the Unix socket between the MCP server and the host. `push` takes text and returns
 * the parsed lines it completed; a line that is not JSON throws FrameError.
 */
export class LineReader {
  private rest = "";

  constructor(
    private readonly maxChars: number = MAX_EXTENSION_TO_HOST_BYTES,
  ) {}

  push(text: string): unknown[] {
    const out: unknown[] = [];
    this.rest += text;
    let at = this.rest.indexOf("\n");
    while (at !== -1) {
      const line = this.rest.slice(0, at);
      this.rest = this.rest.slice(at + 1);
      if (line.trim() !== "") {
        try {
          out.push(JSON.parse(line));
        } catch (error) {
          throw new FrameError(
            `undecodable line: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      at = this.rest.indexOf("\n");
    }
    if (this.rest.length > this.maxChars) throw new FrameError("line too long");
    return out;
  }
}

export const encodeLine = (message: unknown): string =>
  `${JSON.stringify(message)}\n`;
