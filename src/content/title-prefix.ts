import { browser } from 'wxt/browser';
import { prefixedTitle, titlePrefixFor } from '../core/indicators';
import { normalizeSettings, SETTINGS_KEY } from '../core/settings';

/** Same literal as `RENAMED_MESSAGE` in the background (kept apart so this bundle stays small). */
const RENAMED = 'facet/renamed';
/** If the page keeps undoing our prefix, give up for this document instead of fighting it forever. */
const MAX_WRITES = 25;
const WRITE_WINDOW_MS = 3_000;

/**
 * ISOLATED world, top frame of a container tab, only when the user lets pages see the container name (the beacon
 * carries it only then): `data-ctr="<name>"` on `<html>` and `[name] ` in front of the page's title, so the tab
 * strip, tab lists (Claude in Chrome's `tabs_context`) and agents reading the page tell the accounts apart. The
 * prefix survives titles that change under it: a MutationObserver on `<title>` (and on `<head>`, for pages that
 * create the element late) re-applies it, and a title that already carries it is left alone, so it is never doubled.
 * Controlled by the `titlePrefix` and `showNameToPages` settings in `storage.local`, read here directly and followed
 * live (switching `showNameToPages` off removes both marks from open pages at once).
 */
export function startPageName(root: HTMLElement, initialName: string): void {
  let name = initialName;
  let shown = true;
  root.dataset.ctr = name;
  let enabled = false;
  let applied: string | null = null; // the prefix we last put in front of the title
  let titleElement: Element | null = null;
  let observedHead: Element | null = null;
  const writes: number[] = [];

  const titleObserver = new MutationObserver(() => sync());
  const headObserver = new MutationObserver(() => attach());

  const budgetLeft = (): boolean => {
    const now = Date.now();
    while (writes.length > 0 && now - writes[0]! > WRITE_WINDOW_MS) writes.shift();
    if (writes.length >= MAX_WRITES) return false;
    writes.push(now);
    return true;
  };

  function sync(): void {
    if (!enabled) return;
    const current = document.title;
    const prefix = titlePrefixFor(name);
    const wanted = prefixedTitle(current, prefix, applied ?? undefined);
    if (wanted !== current) {
      if (!budgetLeft()) {
        enabled = false; // the page is fighting us
        console.debug('[facet] title prefix disabled on this page: the page keeps rewriting its title');
        return;
      }
      document.title = wanted;
    }
    applied = prefix;
  }

  function strip(): void {
    if (applied !== null && document.title.startsWith(applied)) document.title = document.title.slice(applied.length);
    applied = null;
  }

  /** Finds `<title>` (and `<head>`) as the parser creates them and watches what changes. */
  function attach(): void {
    const head = document.head;
    if (head && head !== observedHead) {
      headObserver.observe(head, { childList: true });
      observedHead = head;
    }
    const element = document.querySelector('title');
    if (element !== titleElement) {
      titleObserver.disconnect();
      titleElement = element;
      if (element) titleObserver.observe(element, { childList: true, characterData: true, subtree: true });
    }
    sync();
  }

  const setEnabled = (value: boolean): void => {
    if (value === enabled) return;
    enabled = value;
    if (enabled) attach();
    else strip();
  };

  // <head> does not exist yet at document_start: watch the root until it does.
  if (document.documentElement) headObserver.observe(document.documentElement, { childList: true });
  attach();

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
    if (area === 'local' && changes[SETTINGS_KEY]) applySettings(changes[SETTINGS_KEY].newValue);
  });
  browser.runtime.onMessage.addListener((message: unknown) => {
    const m = message as { type?: string; name?: unknown };
    if (m?.type === RENAMED && typeof m.name === 'string') {
      name = m.name;
      if (shown) root.dataset.ctr = name;
      if (enabled) sync();
    }
    return undefined;
  });
}
