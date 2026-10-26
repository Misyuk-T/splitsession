import { hostnameOf, registrableDomain } from "../../src/core/site";

/**
 * Per-site pacing: actions that make a site's server receive a request are spaced out per registrable domain across every
 * agent session of the profile, so a loop of several agents cannot hammer one site (a burst of requests got both Reddit
 * accounts a 429 on 2026-10-22). The host waits, in a queue per site, instead of refusing; read-only tools never wait.
 */

/** Default minimum gap between two such actions on one site. */
export const SITE_GAP_MS = 1_500;

/** The gap from `SPLITSESSION_SITE_GAP_MS`: a number of milliseconds (0 switches pacing off); anything else: the default. */
export function siteGapFromEnv(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return SITE_GAP_MS;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : SITE_GAP_MS;
}

/** What an action is paced by: the address it goes to, or the address the tab shows now. */
export type PaceTarget =
  { kind: "url"; url: string } | { kind: "tab"; tabId: number };

const ENTER_KEYS = new Set(["enter", "return", "numpadenter"]);

/** `press_key` that submits a form: the last part of the combination is Enter. */
export const isEnterKey = (key: unknown): boolean =>
  typeof key === "string" &&
  ENTER_KEYS.has(key.split("+").at(-1)?.trim().toLowerCase() ?? "");

/**
 * Whether `tool` makes the site receive a request, and where to find the site. `run_js` and `type` are left out on purpose
 * (nobody can tell what they do to the network); read-only tools never wait.
 */
export function paceTarget(tool: string, args: unknown): PaceTarget | null {
  const a = (args && typeof args === "object" ? args : {}) as {
    url?: unknown;
    tabId?: unknown;
    key?: unknown;
  };
  switch (tool) {
    case "navigate":
    case "open_tab":
    case "open_in_container":
      return typeof a.url === "string" ? { kind: "url", url: a.url } : null;
    case "navigate_back":
    case "navigate_forward":
    case "reload":
    case "click":
    case "select_option":
    case "upload_file":
      return typeof a.tabId === "number"
        ? { kind: "tab", tabId: a.tabId }
        : null;
    case "press_key":
      return typeof a.tabId === "number" && isEnterKey(a.key)
        ? { kind: "tab", tabId: a.tabId }
        : null;
    default:
      return null;
  }
}

/** The site an address belongs to: its registrable domain, else its host (IP address, localhost); null for pages without a site. */
export function siteKey(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const host = hostnameOf(parsed.hostname);
  if (host === "") return null;
  return registrableDomain(host) ?? host;
}

/** Hands out start times: at least `gapMs` apart per site, in the order they were asked for. */
export class SitePacer {
  /** The earliest time the next action on a site may start. */
  private readonly free = new Map<string, number>();

  constructor(
    readonly gapMs: number,
    private readonly capMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Milliseconds to wait before acting on `site` (the slot is taken), or null when that would be longer than the cap. */
  reserve(site: string): number | null {
    const t = this.now();
    const slot = Math.max(t, this.free.get(site) ?? t);
    if (slot - t > this.capMs) return null;
    this.free.set(site, slot + this.gapMs);
    if (this.free.size > 256)
      for (const [key, at] of this.free) if (at <= t) this.free.delete(key);
    return slot - t;
  }
}
