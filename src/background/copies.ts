import { browser } from "wxt/browser";

import {
  answerPing,
  CopyDetector,
  findOtherCopies,
  KNOWN_COPY_IDS,
  type OtherCopy,
} from "../core/copies";
import type { Logger } from "./log";
import { on } from "./on-event";

/** The IDs this copy answers and pings: the known copies, plus the build-time extras of the e2e spec (empty in a release). */
const COPY_IDS: readonly string[] = [...KNOWN_COPY_IDS, ...__EXTRA_COPY_IDS__];

/** Other enabled SplitSession copies in this profile (cached for a minute), pinged from here. */
export function createCopyDetector(b: typeof browser = browser): CopyDetector {
  return new CopyDetector(() =>
    findOtherCopies(
      (id, message) => b.runtime.sendMessage(id, message) as Promise<unknown>,
      b.runtime.id,
      COPY_IDS,
    ),
  );
}

/**
 * Top-level, synchronous registration. `onMessageExternal` answers one thing: the exact ping from another SplitSession ID
 * (src/core/copies.ts). On install and browser start the detector looks once, so the first popup already has the answer
 * and the diagnostics log shows it.
 */
export function registerCopyListeners(
  detector: CopyDetector,
  log: Logger,
  b: typeof browser = browser,
): void {
  const self = () => ({
    edition: __FULL__ ? ("full" as const) : ("lite" as const),
    version: b.runtime.getManifest().version,
  });
  on(
    b.runtime.onMessageExternal,
    (
      message: unknown,
      sender: { id?: string },
      sendResponse: (response: unknown) => void,
    ) => {
      const pong = answerPing(message, sender.id, COPY_IDS, self());
      if (!pong) return false;
      sendResponse(pong);
      return false;
    },
  );
  const look = () =>
    void detector
      .get({ fresh: true })
      .then((copies: OtherCopy[]) => {
        if (copies.length > 0)
          log(
            "warn",
            "another SplitSession copy is enabled in this profile",
            copies.map((c) => `${c.edition} ${c.version} (${c.id})`).join(", "),
          );
      })
      .catch(() => {});
  on(b.runtime.onStartup, look);
  on(b.runtime.onInstalled, look);
}
