/* eslint-disable @typescript-eslint/no-explicit-any -- tool arguments are validated by zod at the MCP boundary; the helpers here pass them through untyped */
import { SWITCHED_OFF, type ToolResult } from "../../bridge/protocol";
import { withoutAgentMark } from "../../core/indicators";
import { ToolError } from "./errors";

/** What a tool run reports about itself for the action log (never page content). */
export interface ActionMeta {
  tabId?: number;
  host?: string;
  /** The tool being run, and the title of the tab it works on (without our own marks): for the popup's recent actions. */
  tool?: string;
  title?: string;
  /** The agent session that asked (sanitised by `cleanAgentName`), when the host named it: shown on the page label, kept in the action log. */
  session?: string;
  /**
   * Aborted when the bridge is switched off (or its connection drops) while the tool runs. Every step that changes
   * something checks it first, and every wait ends on it: a tool that was already received must not act after "off".
   * (A script already running inside a page cannot be recalled.)
   */
  signal?: AbortSignal;
}

/** A tool's arguments, as validated against its input schema. */
export type Args = Record<string, any>;

/** Throws the "switched off" error when the run was aborted. */
export function live(meta?: ActionMeta): void {
  if (meta?.signal?.aborted) throw new ToolError(SWITCHED_OFF);
}

export const text = (value: string): ToolResult => ({
  content: [{ type: "text", text: value }],
});
export const json = (value: unknown): ToolResult => text(JSON.stringify(value));

export const hostOf = (url: string | undefined): string | undefined => {
  try {
    return url ? new URL(url).host || undefined : undefined;
  } catch {
    return undefined;
  }
};

/** A tab title for the action log: without our own marks, at most 80 characters. */
export const hostTitle = (title: string | undefined): string | undefined =>
  title ? withoutAgentMark(title).slice(0, 80) : undefined;

/** The message of any thrown value. */
export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Only these schemes are opened for the agent; `javascript:`, `file:`, `data:` and the like are refused. */
export function checkUrl(url: string, allowed: readonly string[]): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ToolError(
      `"${url.slice(0, 80)}" is not a valid address (include https://)`,
    );
  }
  if (!allowed.includes(parsed.protocol))
    throw new ToolError(
      `addresses of type ${parsed.protocol} are not allowed here; use ${allowed.join(", ")}`,
    );
  return parsed;
}

/** Schemes `open_tab` and `navigate` accept. */
export const OPEN_SCHEMES = [
  "http:",
  "https:",
  "about:",
  "chrome:",
  "chrome-extension:",
];

/** `http:` or `https:`: an address a container's rules (and its service-worker preparation) apply to. */
export const isWebUrl = (url: string): boolean => /^https?:/.test(url);

export function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  what: string,
  signal?: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new ToolError(
            `${what} timed out after ${Math.round(ms / 1000)} seconds`,
          ),
        ),
      ms,
    );
    if (signal) {
      onAbort = () => reject(new ToolError(SWITCHED_OFF));
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  return Promise.race([work, deadline]).finally(() => {
    clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  });
}
