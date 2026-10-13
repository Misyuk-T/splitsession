import { sleep } from "../../core";
import { type TabLike, urlOf } from "./types";

/** Browser start: the tab set must stay unchanged this long before the restored session is matched (at most MAX). */
const STARTUP_STABLE_MS = 400;
const STARTUP_MAX_WAIT_MS = 3_000;
const POLL_MS = 100;

/** Resolves once Chrome has stopped adding, moving and loading tabs for a moment (bounded): restoring windows is done. */
export async function waitForStableTabs(
  query: () => Promise<TabLike[]>,
): Promise<void> {
  const deadline = Date.now() + STARTUP_MAX_WAIT_MS;
  let last = "";
  let since = Date.now();
  while (Date.now() < deadline) {
    const tabs = await query();
    const sig = tabs
      .map((t) => `${t.id}:${t.windowId}:${t.index}:${urlOf(t)}:${t.groupId}`)
      .sort()
      .join("|");
    if (sig !== last) {
      last = sig;
      since = Date.now();
    } else if (Date.now() - since >= STARTUP_STABLE_MS) {
      return;
    }
    await sleep(POLL_MS);
  }
}
