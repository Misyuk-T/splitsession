import {
  titlePrefixFor,
  unprefixedTitle,
  withoutAgentMark,
} from "./indicators";
import { isHttpUrl } from "./site";
import type { ContainerId } from "./types";

/**
 * Saved tabs: the addresses a container had open when its last tab closed, kept so that one click on the container
 * brings them back. Pure data and the batching rule; the store is `engine/storage/saved-tabs-store.ts`, the recorder
 * that watches tabs close is `background/saved-tabs-recorder.ts`.
 */

/** `chrome.storage.local` key: `{ [containerId]: SavedTab[] }`. */
export const SAVED_TABS_KEY = "savedTabs";
/** At most this many tabs are kept per container. */
export const MAX_SAVED_TABS = 50;
/** Tabs of one container closed less than this apart (each from the one before) are one batch. */
export const BATCH_GAP_MS = 1500;
const LOG_KEEP_MS = 10 * 60_000;
const LOG_KEEP_COUNT = 500;
const MAX_URL_LENGTH = 8192;
const MAX_TITLE_LENGTH = 300;

export interface SavedTab {
  url: string;
  title: string;
}

/** A tab that can be saved: an http(s) address (not an extension page, about:blank, chrome://). */
export const isSavableUrl = (url: string | null | undefined): url is string =>
  isHttpUrl(url) && url.length <= MAX_URL_LENGTH;

/** The page's own title: SplitSession's "⧉ " mark, an agent mark and the container's `[name] ` prefix taken off. */
export function cleanTabTitle(title: string | undefined, name: string): string {
  const own = unprefixedTitle(
    withoutAgentMark(title ?? ""),
    titlePrefixFor(name),
  );
  return Array.from(own).slice(0, MAX_TITLE_LENGTH).join("");
}

/** Keeps the savable entries of a list read from storage or a file (malformed ones dropped), at most `MAX_SAVED_TABS`. */
export function normalizeSavedTabs(raw: unknown): SavedTab[] {
  if (!Array.isArray(raw)) return [];
  const out: SavedTab[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const { url, title } = item as Record<string, unknown>;
    if (!isSavableUrl(typeof url === "string" ? url : undefined)) continue;
    out.push({
      url: url as string,
      title: Array.from(typeof title === "string" ? title : "")
        .slice(0, MAX_TITLE_LENGTH)
        .join(""),
    });
    if (out.length >= MAX_SAVED_TABS) break;
  }
  return out;
}

/** A tab as the recorder knew it when it closed: where it stood (window, position) is what orders a batch. */
export interface ClosedTab extends SavedTab {
  windowId: number;
  index: number;
}

export interface Closure {
  tab: ClosedTab | null;
  at: number;
  /** `tabs.onRemoved` said the whole window was closing (a window close, or the browser quitting). */
  windowClosing: boolean;
}

/**
 * Tabs of one container that closed lately. `last(id)` is the last batch: the newest closure and every earlier one that
 * is within `BATCH_GAP_MS` of the next (a group delete, a window close or a Cmd+W on a group close many tabs at once;
 * tabs closed one by one over time are separate batches, and only the last counts).
 */
export class ClosureLog {
  private readonly closures = new Map<ContainerId, Closure[]>();

  constructor(private readonly gapMs: number = BATCH_GAP_MS) {}

  add(containerId: ContainerId, closure: Closure): void {
    const list = this.closures.get(containerId) ?? [];
    // Bounded: a chain of closures that long (gaps under the limit for minutes) is not a closing of tabs but a stream.
    const kept = list.filter((c) => closure.at - c.at <= LOG_KEEP_MS);
    kept.push(closure);
    this.closures.set(containerId, kept.slice(-LOG_KEEP_COUNT));
  }

  /** The newest batch, oldest closure first; empty when there is none. */
  last(containerId: ContainerId): Closure[] {
    const list = [...(this.closures.get(containerId) ?? [])].sort(
      (a, b) => a.at - b.at,
    );
    const batch: Closure[] = [];
    for (let i = list.length - 1; i >= 0; i--) {
      const closure = list[i]!;
      if (batch.length > 0 && batch[0]!.at - closure.at > this.gapMs) break;
      batch.unshift(closure);
    }
    return batch;
  }

  forget(containerId: ContainerId): void {
    this.closures.delete(containerId);
  }
}

/** What a batch saves: savable tabs in the order they stood (window, then position), at most `MAX_SAVED_TABS`. */
export function savedTabsOf(batch: readonly Closure[]): SavedTab[] {
  const tabs = batch
    .map((c) => c.tab)
    .filter((t): t is ClosedTab => t !== null && isSavableUrl(t.url))
    .sort((a, b) => a.windowId - b.windowId || a.index - b.index);
  return tabs
    .slice(0, MAX_SAVED_TABS)
    .map((t) => ({ url: t.url, title: t.title }));
}

/** Open tabs first (in order), then saved ones whose address is not among them; at most `MAX_SAVED_TABS`. */
export function mergeTabLists(
  open: readonly SavedTab[],
  saved: readonly SavedTab[],
): SavedTab[] {
  const seen = new Set<string>();
  const out: SavedTab[] = [];
  for (const tab of [...open, ...saved]) {
    if (seen.has(tab.url)) continue;
    seen.add(tab.url);
    out.push({ url: tab.url, title: tab.title });
    if (out.length >= MAX_SAVED_TABS) break;
  }
  return out;
}
