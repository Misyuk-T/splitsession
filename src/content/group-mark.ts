import { browser } from "wxt/browser";

import { OUTSIDE_MARK } from "../core/indicators";
import { normalizeSettings, SETTINGS_KEY } from "../core/settings";
import { titleLayers } from "./title-layers";

/** Same literal as `OUTSIDE_GROUP_MESSAGE` in the background (kept apart so this bundle stays small). */
const OUTSIDE_GROUP = "facet/outside-group";

/**
 * ISOLATED world, top frame of a container tab, both editions: "⧉ " in front of the page's title while the tab is not
 * inside its container's tab group (dragged out, groups off), so it does not look like an ordinary tab. No container name:
 * the page can read its title and learns only that this is a container tab. The background knows the group (it asks
 * once on start, and pushes every change: joined, left, the container left); the `markOutsideGroup` setting is read
 * here from `storage.local` and followed live. The title itself is written by `title-layers.ts`.
 */
export function startGroupMark(): void {
  const layers = titleLayers();
  let setting = true;
  let outside = false;
  let heard = false; // a push already told the state: a late answer to the question is older

  const apply = (): void =>
    layers.set("mark", setting && outside ? OUTSIDE_MARK : "");

  const applySettings = (raw: unknown): void => {
    setting = normalizeSettings(raw).markOutsideGroup;
    apply();
  };
  void browser.storage.local.get(SETTINGS_KEY).then(
    (stored) => applySettings(stored[SETTINGS_KEY]),
    () => apply(),
  );
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[SETTINGS_KEY])
      applySettings(changes[SETTINGS_KEY].newValue);
  });
  browser.runtime.onMessage.addListener((message: unknown) => {
    const m = message as { type?: string; outside?: unknown };
    if (m?.type === OUTSIDE_GROUP && typeof m.outside === "boolean") {
      heard = true;
      outside = m.outside;
      apply();
    }
    return undefined;
  });
  void (
    browser.runtime.sendMessage({ type: OUTSIDE_GROUP }) as Promise<{
      ok?: boolean;
      outside?: unknown;
    }>
  ).then(
    (reply) => {
      if (heard || reply?.ok !== true) return;
      outside = reply.outside === true;
      apply();
    },
    () => undefined,
  );
}
