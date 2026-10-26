/**
 * Tab leases: when several agent sessions work through one host (one Chrome profile), a tab belongs to the session that
 * opened it or last acted on it, so another session does not interleave its actions with a running job. Host-side and in
 * memory only; read-only tools never take or need a lease.
 */

/** Tools that change a tab (or what it shows): they take the lease and are refused on a tab another session holds. */
export const LEASE_MUTATING = new Set([
  "navigate",
  "navigate_back",
  "navigate_forward",
  "reload",
  "close_tab",
  "activate_tab",
  "assign_tab",
  "click",
  "drag",
  "type",
  "press_key",
  "select_option",
  "upload_file",
  "run_js",
  "handle_dialog",
  "resize_viewport",
]);
/** Tools whose answer is a new tab: the opener holds it. */
export const LEASE_OPENING = new Set(["open_tab", "open_in_container"]);

/** A lease nobody renewed for this long is free again. */
export const LEASE_IDLE_MS = 120_000;

/** A session name as the host keeps it: printable, short; null when absent or not a string. */
export function cleanSessionName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value
    .replace(/[^\x20-\x7e]/g, "")
    .trim()
    .slice(0, 64);
  return name === "" ? null : name;
}

interface Lease {
  holder: string;
  last: number;
}

export class Leases {
  private readonly byTab = new Map<number, Lease>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly idleMs: number = LEASE_IDLE_MS,
  ) {}

  /** Who holds the tab now (idle leases are dropped on the way). */
  holder(tabId: number): { name: string; idleMs: number } | null {
    const lease = this.byTab.get(tabId);
    if (!lease) return null;
    const idle = this.now() - lease.last;
    if (idle >= this.idleMs) {
      this.byTab.delete(tabId);
      return null;
    }
    return { name: lease.holder, idleMs: idle };
  }

  /** The refusal for `session` acting on `tabId`, or null when it may. */
  refusal(session: string, tabId: number, takeOver: boolean): string | null {
    const held = this.holder(tabId);
    if (!held || held.name === session || takeOver) return null;
    return `tab ${tabId} is in use by another agent session (${held.name}, last action ${Math.round(held.idleMs / 1000)}s ago); open your own tab (open_tab / open_in_container) or pass takeOver: true if the user asked you to work in it`;
  }

  /** `session` holds the tab from now on (a new lease, a renewed one, or a take-over). */
  grant(session: string, tabId: number): void {
    this.byTab.set(tabId, { holder: session, last: this.now() });
  }

  release(tabId: number): void {
    this.byTab.delete(tabId);
  }

  /** Everything `session` holds (it disconnected). */
  releaseAll(session: string): void {
    for (const [tabId, lease] of this.byTab)
      if (lease.holder === session) this.byTab.delete(tabId);
  }

  clear(): void {
    this.byTab.clear();
  }

  /** `list_tabs` items with `inUseBy` (held by another session) or `yours: true` (held by the caller). */
  annotate(items: unknown[], session: string): unknown[] {
    return items.map((item) => {
      const tabId = (item as { tabId?: unknown } | null)?.tabId;
      if (typeof tabId !== "number") return item;
      const held = this.holder(tabId);
      if (!held) return item;
      return held.name === session
        ? { ...(item as object), yours: true }
        : { ...(item as object), inUseBy: held.name };
    });
  }
}
