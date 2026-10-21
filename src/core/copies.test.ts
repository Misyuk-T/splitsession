import { describe, expect, it, vi } from "vitest";

import {
  answerPing,
  CopyDetector,
  findOtherCopies,
  FULL_ID,
  KNOWN_COPY_IDS,
  parsePong,
  STORE_LITE_ID,
} from "./copies";

const self = { edition: "full", version: "0.1.4" } as const;
const ping = { type: "splitsession.ping" };

describe("answerPing", () => {
  it("answers the exact ping from each known ID", () => {
    for (const id of KNOWN_COPY_IDS)
      expect(answerPing(ping, id, KNOWN_COPY_IDS, self)).toEqual({
        type: "splitsession.pong",
        edition: "full",
        version: "0.1.4",
      });
  });

  it("stays silent for an unknown or missing sender", () => {
    expect(answerPing(ping, "x".repeat(32), KNOWN_COPY_IDS, self)).toBeNull();
    expect(answerPing(ping, undefined, KNOWN_COPY_IDS, self)).toBeNull();
    expect(answerPing(ping, "", KNOWN_COPY_IDS, self)).toBeNull();
  });

  it("stays silent for anything but the exact ping shape", () => {
    const messages: unknown[] = [
      undefined,
      null,
      "splitsession.ping",
      42,
      [],
      [ping],
      {},
      { type: "splitsession.pong" },
      { type: "splitsession.ping", extra: 1 },
      { type: "splitsession.PING" },
      { type: ["splitsession.ping"] },
      { type: "facet/api", method: "listContainers", args: [] },
    ];
    for (const m of messages)
      expect(answerPing(m, FULL_ID, KNOWN_COPY_IDS, self)).toBeNull();
  });

  it("names the edition and version of the answering copy", () => {
    expect(
      answerPing(ping, STORE_LITE_ID, KNOWN_COPY_IDS, {
        edition: "lite",
        version: "0.2.0",
      }),
    ).toMatchObject({ edition: "lite", version: "0.2.0" });
  });
});

describe("parsePong", () => {
  it("accepts a well-formed pong only", () => {
    expect(
      parsePong({
        type: "splitsession.pong",
        edition: "lite",
        version: "0.1.4",
      }),
    ).toEqual({ edition: "lite", version: "0.1.4" });
    expect(parsePong(undefined)).toBeNull();
    expect(
      parsePong({ type: "splitsession.pong", edition: "pro", version: "1" }),
    ).toBeNull();
    expect(
      parsePong({ type: "splitsession.pong", edition: "full", version: 1 }),
    ).toBeNull();
    expect(
      parsePong({
        type: "splitsession.pong",
        edition: "full",
        version: "<b>x</b>",
      }),
    ).toBeNull();
    expect(
      parsePong({ type: "other", edition: "full", version: "1" }),
    ).toBeNull();
  });
});

describe("findOtherCopies", () => {
  it("finds nothing when no copy is there or answers (not installed, disabled)", async () => {
    const send = vi.fn(async () => {
      throw new Error(
        "Could not establish connection. Receiving end does not exist.",
      );
    });
    expect(await findOtherCopies(send, FULL_ID, KNOWN_COPY_IDS)).toEqual([]);
    expect(
      await findOtherCopies(async () => undefined, FULL_ID, KNOWN_COPY_IDS),
    ).toEqual([]);
  });

  it("never pings its own ID", async () => {
    const calls: Array<[string, unknown]> = [];
    await findOtherCopies(
      async (id, message) => {
        calls.push([id, message]);
        return undefined;
      },
      FULL_ID,
      KNOWN_COPY_IDS,
    );
    expect(calls).toEqual([[STORE_LITE_ID, ping]]);
  });

  it("lists a copy that answers with a pong", async () => {
    const send = async (id: string) =>
      id === FULL_ID
        ? { type: "splitsession.pong", edition: "full", version: "0.1.4" }
        : Promise.reject(new Error("Receiving end does not exist"));
    expect(await findOtherCopies(send, STORE_LITE_ID, KNOWN_COPY_IDS)).toEqual([
      { id: FULL_ID, edition: "full", version: "0.1.4" },
    ]);
  });

  it("ignores a junk reply", async () => {
    expect(
      await findOtherCopies(
        async () => ({ hello: 1 }),
        FULL_ID,
        KNOWN_COPY_IDS,
      ),
    ).toEqual([]);
  });
});

describe("CopyDetector", () => {
  const found = [{ id: FULL_ID, edition: "full" as const, version: "0.1.4" }];

  it("caches a found copy for the ttl, refreshes after it, and shares a call under way", async () => {
    let t = 0;
    const find = vi.fn(async () => found);
    const d = new CopyDetector(find, 60_000, () => t);
    await Promise.all([d.get(), d.get()]);
    expect(find).toHaveBeenCalledTimes(1);
    t = 59_000;
    expect(await d.get()).toEqual(found);
    expect(find).toHaveBeenCalledTimes(1);
    t = 61_000;
    await d.get();
    expect(find).toHaveBeenCalledTimes(2);
    await d.get({ fresh: true });
    expect(find).toHaveBeenCalledTimes(3);
  });

  it("looks again soon when it found none", async () => {
    let t = 0;
    const find = vi.fn(async () => []);
    const d = new CopyDetector(find, 60_000, () => t, 10_000);
    await d.get();
    t = 9_000;
    await d.get();
    expect(find).toHaveBeenCalledTimes(1);
    t = 11_000;
    await d.get();
    expect(find).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failure", async () => {
    const find = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue([]);
    const d = new CopyDetector(find);
    await expect(d.get()).rejects.toThrow("boom");
    await expect(d.get()).resolves.toEqual([]);
  });
});
