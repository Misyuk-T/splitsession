import { browser } from "wxt/browser";

import { titlePrefixFor } from "../core/indicators";
import { normalizeSettings, SETTINGS_KEY } from "../core/settings";
import { titleLayers } from "./title-layers";

/** Same literal as `RENAMED_MESSAGE` in the background (kept apart so this bundle stays small). */
const RENAMED = "facet/renamed";

/**
 * ISOLATED world, top frame of a container tab, only when the user lets pages see the container name (the beacon
 * carries it only then): `data-ctr="<name>"` on `<html>` and `[name] ` in front of the page's title, so the tab
 * strip, tab lists (Claude in Chrome's `tabs_context`) and agents reading the page tell the accounts apart. The
 * prefix survives titles that change under it and is never doubled (`title-layers.ts`, which also puts the outside-group
 * mark in front of it: "⧉ [name] Title"). Controlled by the `titlePrefix` and `showNameToPages` settings in `storage.local`, read here directly and followed
 * live (switching `showNameToPages` off removes both marks from open pages at once).
 */
export function startPageName(root: HTMLElement, initialName: string): void {
  let name = initialName;
  let shown = true;
  root.dataset.ctr = name;
  let enabled = false;
  const layers = titleLayers();

  const apply = (): void =>
    layers.set("name", enabled ? titlePrefixFor(name) : "");

  const setEnabled = (value: boolean): void => {
    enabled = value;
    apply();
  };

  const applySettings = (raw: unknown): void => {
    const settings = normalizeSettings(raw);
    shown = settings.showNameToPages;
    if (shown) root.dataset.ctr = name;
    else delete root.dataset.ctr;
    setEnabled(shown && settings.titlePrefix);
  };
  void browser.storage.local.get(SETTINGS_KEY).then(
    (stored) => applySettings(stored[SETTINGS_KEY]),
    () => setEnabled(true),
  );
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[SETTINGS_KEY])
      applySettings(changes[SETTINGS_KEY].newValue);
  });
  browser.runtime.onMessage.addListener((message: unknown) => {
    const m = message as { type?: string; name?: unknown };
    if (m?.type === RENAMED && typeof m.name === "string") {
      name = m.name;
      if (shown) root.dataset.ctr = name;
      apply();
    }
    return undefined;
  });
}
