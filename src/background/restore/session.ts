import type { StorageAreaLike } from "../../engine/storage/storage-area";
import type { HeldEntry } from "./types";

/** `chrome.storage.session`: which tabs are known, held, and the recently-closed entries last seen. */
export const RESTORE_SESSION_KEY = "restoreSession";
/** Session writes are batched this long. */
const SESSION_WRITE_DELAY_MS = 50;

/** What survives a stop of the service worker (not a browser restart). */
export interface SessionState {
  cleared: number[];
  held: HeldEntry[];
  present: string[];
  startupUntil: number;
}

export function parseSession(raw: unknown): SessionState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const s = raw as Record<string, unknown>;
  const nums = (x: unknown) =>
    Array.isArray(x)
      ? x.filter((n): n is number => Number.isInteger(n) && (n as number) >= 0)
      : [];
  return {
    cleared: nums(s.cleared),
    held: Array.isArray(s.held)
      ? (s.held as HeldEntry[]).filter(
          (h) =>
            h &&
            Number.isInteger(h.tabId) &&
            typeof h.url === "string" &&
            Array.isArray(h.candidates),
        )
      : [],
    present: Array.isArray(s.present)
      ? s.present.filter((x): x is string => typeof x === "string")
      : [],
    startupUntil: typeof s.startupUntil === "number" ? s.startupUntil : 0,
  };
}

/** Writes the session state a moment after the first change of a burst (`current` is read when it is written). */
export class SessionWriter {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly area: StorageAreaLike,
    private readonly current: () => SessionState,
  ) {}

  schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.area
        .set({ [RESTORE_SESSION_KEY]: this.current() })
        .catch(() => {});
    }, SESSION_WRITE_DELAY_MS);
  }
}
