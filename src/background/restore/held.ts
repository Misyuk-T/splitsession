import {
  gateKey,
  heldPageTarget,
  oneClickPlan,
  type RestoreRecord,
} from "../../core";
import type { HeldEntry, RestoreBrowser, RestoreStatus } from "./types";
import { urlOf } from "./types";

/** `container address` of every candidate of every waiting tab. */
export function heldKeys(held: Iterable<HeldEntry>): Set<string> {
  const keys = new Set<string>();
  for (const h of held)
    for (const c of h.candidates) keys.add(`${c} ${gateKey(h.url)}`);
  return keys;
}

/** The popup's banner: the waiting tabs that still exist, with their titles, and what one click restores. */
export async function heldStatus(
  b: RestoreBrowser,
  heldPage: string,
  enabled: boolean,
  held: HeldEntry[],
  records: RestoreRecord[],
): Promise<RestoreStatus> {
  // The title of SplitSession's own page says nothing about the address.
  const titles = await Promise.all(
    held.map((h) =>
      b.tabs.get(h.tabId).then(
        (t) =>
          heldPageTarget(urlOf(t), heldPage) !== null ? "" : (t.title ?? ""),
        () => null,
      ),
    ),
  );
  const live = held.filter((_, i) => titles[i] !== null);
  return {
    enabled,
    held: live.map((h) => ({
      tabId: h.tabId,
      url: h.url,
      title: titles[held.indexOf(h)] ?? "",
      candidates: [...h.candidates],
    })),
    oneClick: oneClickPlan(live, records).size,
  };
}
