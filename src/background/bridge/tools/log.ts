import type { LogEntry } from "../../log";
import type { ToolHandler } from "../tool-context";
import { json } from "../tool-kit";

/** Longest text of one returned entry (message plus data), in characters. */
export const LOG_ENTRY_CHARS = 2000;

const stringify = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

/**
 * The newest `limit` entries (oldest first) whose message or data contains `contains` (case-insensitive) and whose level
 * is `level`, each cut to LOG_ENTRY_CHARS. Only what the Diagnostics page shows: nothing is added to the log.
 */
export function selectLog(
  entries: readonly LogEntry[],
  opts: { limit?: number; contains?: string; level?: string },
) {
  const limit = opts.limit ?? 200;
  const needle = opts.contains?.toLowerCase();
  const out = [];
  for (const e of entries) {
    if (opts.level && e.level !== opts.level) continue;
    const data = e.data === undefined ? undefined : stringify(e.data);
    if (needle && !`${e.message}\n${data ?? ""}`.toLowerCase().includes(needle))
      continue;
    const message = e.message.slice(0, LOG_ENTRY_CHARS);
    out.push({
      time: new Date(e.at).toISOString(),
      level: e.level,
      message,
      ...(data === undefined
        ? {}
        : { data: data.slice(0, LOG_ENTRY_CHARS - message.length) }),
    });
  }
  return out.slice(Math.max(0, out.length - limit));
}

/** Read-only: the extension's own diagnostics log, as the Diagnostics page shows it. */
export const LOG_TOOLS: Record<string, ToolHandler> = {
  extension_log: async (c, a) =>
    json(
      selectLog(c.d.facet.log.entries(), {
        limit: a.limit,
        contains: a.contains,
        level: a.level,
      }),
    ),
};
