import { prefixedTitle } from "../core/indicators";

/** If the page keeps undoing our prefix, give up for this document instead of fighting it forever. */
const MAX_WRITES = 25;
const WRITE_WINDOW_MS = 3_000;

/** The pieces that may stand in front of the page's own title, in this order: mark, then name. */
export type TitleLayer = "mark" | "name";

export interface TitleLayers {
  /** Sets the text of one layer ("" takes it off); the title follows at once and keeps following the page. */
  set(layer: TitleLayer, text: string): void;
}

/**
 * The one writer of `document.title` in this document (ISOLATED world, top frame): the layers in front of the page's own
 * title, "⧉ " (container tab outside its group) and "[name] " (container name, Full), written together as
 * "⧉ [name] Title" so the two never stack or fight over the front of the title. The prefix survives titles that change
 * under it: a MutationObserver on `<title>` (and on `<head>`, for pages that create the element late) re-applies it, and
 * a title that already carries it is left alone, so it is never doubled. Nothing is observed until a layer has text. A
 * page that keeps undoing the prefix is given up on (see MAX_WRITES), the prefix stays off for this document.
 */
export function createTitleLayers(): TitleLayers {
  const layers: Record<TitleLayer, string> = { mark: "", name: "" };
  let gaveUp = false;
  let applied: string | null = null; // the prefix we last put in front of the title
  let titleElement: Element | null = null;
  let observedHead: Element | null = null;
  let watching = false;
  const writes: number[] = [];

  const titleObserver = new MutationObserver(() => sync());
  const headObserver = new MutationObserver(() => attach());

  const budgetLeft = (): boolean => {
    const now = Date.now();
    while (writes.length > 0 && now - writes[0]! > WRITE_WINDOW_MS)
      writes.shift();
    if (writes.length >= MAX_WRITES) return false;
    writes.push(now);
    return true;
  };

  function sync(): void {
    if (gaveUp) return;
    const prefix = layers.mark + layers.name;
    const current = document.title;
    if (prefix === "") {
      if (applied !== null && current.startsWith(applied))
        document.title = current.slice(applied.length);
      applied = null;
      return;
    }
    const wanted = prefixedTitle(current, prefix, applied ?? undefined);
    if (wanted !== current) {
      if (!budgetLeft()) {
        gaveUp = true; // the page is fighting us
        // eslint-disable-next-line no-console -- a debug line in the page's console is the only way to say why the prefix went away
        console.debug(
          "[splitsession] title prefix disabled on this page: the page keeps rewriting its title",
        );
        return;
      }
      document.title = wanted;
    }
    applied = prefix;
  }

  /** Finds `<title>` (and `<head>`) as the parser creates them and watches what changes. */
  function attach(): void {
    const head = document.head;
    if (head && head !== observedHead) {
      headObserver.observe(head, { childList: true });
      observedHead = head;
    }
    const element = document.querySelector("title");
    if (element !== titleElement) {
      titleObserver.disconnect();
      titleElement = element;
      if (element)
        titleObserver.observe(element, {
          childList: true,
          characterData: true,
          subtree: true,
        });
    }
    sync();
  }

  function watch(): void {
    if (watching) return;
    watching = true;
    // <head> does not exist yet at document_start: watch the root until it does.
    if (document.documentElement)
      headObserver.observe(document.documentElement, { childList: true });
  }

  return {
    set(layer, text) {
      if (layers[layer] === text) return;
      layers[layer] = text;
      if (text !== "") watch();
      if (watching) attach();
    },
  };
}

let shared: TitleLayers | undefined;

/** The document's layers (one writer: both marks go through it). */
export const titleLayers = (): TitleLayers => (shared ??= createTitleLayers());
