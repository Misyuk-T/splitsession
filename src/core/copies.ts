/**
 * Two enabled copies of SplitSession in one Chrome profile (docs/decisions.md, "Duplicate copies"). Both rewrite Cookie
 * headers and capture Set-Cookie into their own jars, so logins do not stick. Each copy answers a ping from the other known
 * copies (`externally_connectable` in the manifest names exactly these IDs; no permission is involved) and pings them
 * itself. Pure logic only; the browser side is src/background/copies.ts.
 */

/** The Lite build on the Chrome Web Store. */
export const STORE_LITE_ID = "hhodioekcdmhpocjbkjnblmbmchddphf";
/** The Full build (fixed key, wxt.config.ts), GitHub and unpacked. */
export const FULL_ID = "hapfikidacgfgnnajkgnaednpgnhmffk";
/**
 * Every ID a copy answers and pings. An unpacked Lite has a path-derived ID nobody can know in advance: it can find these
 * two but cannot be found.
 */
export const KNOWN_COPY_IDS: readonly string[] = [STORE_LITE_ID, FULL_ID];

export type CopyEdition = "lite" | "full";

export const PING_TYPE = "splitsession.ping";
export const PONG_TYPE = "splitsession.pong";

export interface CopyPong {
  type: typeof PONG_TYPE;
  edition: CopyEdition;
  version: string;
}

/** Another enabled copy, as the popup and the settings page show it. */
export interface OtherCopy {
  id: string;
  edition: CopyEdition;
  version: string;
}

/**
 * The answer to a message from another extension: a pong for exactly `{ type: "splitsession.ping" }` from a known ID,
 * `null` (no answer, nothing else is ever revealed or done) for anything else.
 */
export function answerPing(
  message: unknown,
  senderId: string | undefined,
  known: readonly string[],
  self: { edition: CopyEdition; version: string },
): CopyPong | null {
  if (senderId === undefined || !known.includes(senderId)) return null;
  if (typeof message !== "object" || message === null || Array.isArray(message))
    return null;
  const keys = Object.keys(message);
  if (keys.length !== 1 || keys[0] !== "type") return null;
  if ((message as { type: unknown }).type !== PING_TYPE) return null;
  return { type: PONG_TYPE, edition: self.edition, version: self.version };
}

/** A reply that is a well-formed pong; anything else (undefined, junk) is not a copy. */
export function parsePong(
  reply: unknown,
): { edition: CopyEdition; version: string } | null {
  if (typeof reply !== "object" || reply === null) return null;
  const r = reply as Record<string, unknown>;
  if (r.type !== PONG_TYPE) return null;
  if (r.edition !== "lite" && r.edition !== "full") return null;
  if (
    typeof r.version !== "string" ||
    !/^[0-9A-Za-z.+-]{1,32}$/.test(r.version)
  )
    return null;
  return { edition: r.edition, version: r.version };
}

/**
 * Pings every known ID except our own. Not installed, disabled, or too old to answer all reject with "Could not establish
 * connection. Receiving end does not exist" (or reply with nothing): that is "none", not an error.
 */
export async function findOtherCopies(
  send: (id: string, message: { type: typeof PING_TYPE }) => Promise<unknown>,
  selfId: string,
  known: readonly string[],
): Promise<OtherCopy[]> {
  const others = known.filter((id) => id !== selfId);
  const replies = await Promise.all(
    others.map(async (id): Promise<OtherCopy | null> => {
      try {
        const pong = parsePong(await send(id, { type: PING_TYPE }));
        return pong ? { id, ...pong } : null;
      } catch {
        return null;
      }
    }),
  );
  return replies.filter((c): c is OtherCopy => c !== null);
}

/**
 * Remembers the last result: `ttlMs` when another copy was found (the popup opens often, and a ping wakes the other copy's
 * worker), only `noneTtlMs` when none was (that ping fails at once and costs nothing, and a copy enabled a moment later,
 * or one that was still starting when the browser started, should show up soon).
 */
export class CopyDetector {
  private cached: { at: number; copies: OtherCopy[] } | null = null;
  private pending: Promise<OtherCopy[]> | null = null;

  constructor(
    private readonly find: () => Promise<OtherCopy[]>,
    private readonly ttlMs = 60_000,
    private readonly now: () => number = Date.now,
    private readonly noneTtlMs = 10_000,
  ) {}

  async get(options: { fresh?: boolean } = {}): Promise<OtherCopy[]> {
    if (
      !options.fresh &&
      this.cached &&
      this.now() - this.cached.at <
        (this.cached.copies.length > 0 ? this.ttlMs : this.noneTtlMs)
    )
      return this.cached.copies;
    this.pending ??= this.find()
      .then((copies) => {
        this.cached = { at: this.now(), copies };
        return copies;
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }
}
