import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
  type ClientResponse,
  PROFILE_TOOL,
  TABS_TOOL,
} from "../../src/bridge/protocol";
import { type Endpoint, LEGACY_KEY } from "./profiles";

/**
 * The MCP server's view of several Chrome profiles at once. Each profile whose bridge is on has a socket of its own
 * (`discover`); this class decides which profile a tool call goes to, and puts the answers of the list tools together.
 *
 * - `bridge_info`, `list_tabs`, `list_containers`: every profile (or the one `profile` names); every item carries
 *   `profile: {key, label}`.
 * - Tools on a tab (`tabId`): the profile that has that tab. Chrome numbers tabs once per browser process, so the profiles
 *   of one Chrome never share a tab ID; profiles of separate Chrome processes can, and then `profile` must say which.
 * - Tools that open a tab (`open_tab`, `open_in_container`): `profile`, or the profile of `windowId`, or the only profile;
 *   never a guess when several are connected.
 * - One profile connected: every call goes to it, exactly as before there were several.
 */

/** Thrown by `Caller` when nothing listens on the socket (switched off, or a leftover file). */
export class Unreachable extends Error {}

export type Caller = (
  ep: Endpoint,
  tool: string,
  args: Record<string, unknown>,
) => Promise<ClientResponse>;

export interface DispatchDeps {
  discover(): Endpoint[];
  call: Caller;
  /** What to say when no profile is reachable at all (off, or not installed). */
  unreachable(): string;
  /** A socket that refused: remove it if it is a leftover. */
  gone?(ep: Endpoint): void;
}

export interface ProfileInfo {
  profileKey: string;
  /** The name the user gave the profile in SplitSession (null: none). */
  label: string | null;
  windows?: number;
  tabs?: number;
  containers?: number;
  extensionVersion?: string;
  /** On the shared protocol-1 socket: an extension (or a host) older than 0.2. */
  legacy?: true;
  /** The profile did not answer `bridge_info`. */
  error?: string;
}

type Outcome =
  | { ok: true; ep: Endpoint; result: CallToolResult }
  | { ok: false; ep: Endpoint; error: string };

/** The tools that list or describe: asked of every profile. */
const AGGREGATE = new Set(["bridge_info", "list_tabs", "list_containers"]);
/** The tools that open a tab: one profile, said or unambiguous. */
const CREATE = new Set(["open_tab", "open_in_container"]);

const failure = (text: string): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text }],
});
const jsonResult = (value: unknown, notes: string[] = []): CallToolResult => ({
  content: [
    { type: "text", text: JSON.stringify(value) },
    ...notes.map((text) => ({ type: "text" as const, text })),
  ],
});

/** The first text block parsed as JSON, or undefined. */
function firstJson(result: CallToolResult): unknown {
  const block = result.content?.find((c) => c.type === "text") as
    { text: string } | undefined;
  if (!block) return undefined;
  try {
    return JSON.parse(block.text);
  } catch {
    return undefined;
  }
}

const NO_TAB = /^no tab with id \d+/;

/** `"Work" (key k1abc23def)`, or `unnamed (key …)`. */
const describe = (p: ProfileInfo) =>
  `${p.label === null ? "unnamed" : JSON.stringify(p.label)} (key ${p.profileKey})`;

export class Dispatcher {
  /** Which profile (and which host of it: the socket's inode) a tab ID was last seen in; `null`: in more than one. */
  private readonly tabs = new Map<
    number,
    { key: string; ino: number } | null
  >();

  constructor(private readonly d: DispatchDeps) {}

  /** `args` are already validated; `profile` is ours and never reaches the extension. */
  async run(
    name: string,
    allArgs: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const { profile, ...args } = allArgs;
    let endpoints = this.d.discover();
    if (endpoints.length === 0) return failure(this.d.unreachable());

    let targets = endpoints;
    if (typeof profile === "string") {
      const chosen = await this.resolve(profile, endpoints);
      if ("error" in chosen) return failure(chosen.error);
      targets = [chosen.ep];
    }

    if (AGGREGATE.has(name)) return this.aggregate(name, args, targets);

    let target: Endpoint | undefined =
      targets.length === 1 ? targets[0] : undefined;
    if (!target && typeof args.tabId === "number") {
      const found = await this.findTab(args.tabId, endpoints);
      if ("error" in found) return failure(found.error);
      target = found.ep;
    }
    if (!target && CREATE.has(name) && typeof args.windowId === "number") {
      const found = await this.findWindow(args.windowId, endpoints);
      if ("error" in found) return failure(found.error);
      target = found.ep;
    }
    if (!target) {
      endpoints = this.d.discover();
      const infos = await this.labels(endpoints);
      return failure(
        `Several Chrome profiles have the SplitSession agent bridge on: ${infos.map(describe).join(", ")}. ` +
          `Say which one with profile: "<name or key>" (bridge_info lists them); a tool on a tab finds the tab's profile by itself.`,
      );
    }

    let outcome = await this.callOne(target, name, args);
    // The tab was in the cache but is not in that profile any more (closed, or Chrome restarted and reused the number):
    // look for it once in every profile. Nothing was done: the tool stopped at "no tab".
    if (
      !outcome.ok &&
      typeof profile !== "string" &&
      typeof args.tabId === "number" &&
      NO_TAB.test(outcome.error) &&
      endpoints.length > 1
    ) {
      this.tabs.delete(args.tabId);
      const found = await this.findTab(args.tabId, this.d.discover());
      if ("error" in found) return failure(found.error);
      if (found.ep.key !== target.key || found.ep.ino !== target.ino)
        outcome = await this.callOne(found.ep, name, args);
    }
    if (!outcome.ok) return failure(outcome.error);
    this.remember(outcome.ep, outcome.result);
    return outcome.result;
  }

  /** One profile, one tool. A profile that has gone (unreachable) is an error the agent can act on. */
  private async callOne(
    ep: Endpoint,
    name: string,
    args: Record<string, unknown>,
  ): Promise<Outcome> {
    try {
      const response = await this.d.call(ep, name, args);
      if (!response.ok) return { ok: false, ep, error: response.error };
      return { ok: true, ep, result: response.result as CallToolResult };
    } catch (error) {
      if (error instanceof Unreachable) {
        this.d.gone?.(ep);
        const left = this.d.discover().filter((e) => e.socket !== ep.socket);
        return {
          ok: false,
          ep,
          error:
            left.length === 0
              ? this.d.unreachable()
              : `the Chrome profile ${ep.key === LEGACY_KEY ? "on the shared socket" : `with key ${ep.key}`} is not connected any more (its bridge was switched off); call list_tabs`,
        };
      }
      return {
        ok: false,
        ep,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** The same tool on several profiles at once; unreachable ones are left out (they were switched off meanwhile). */
  private async callAll(
    endpoints: Endpoint[],
    name: string,
    args: Record<string, unknown>,
  ): Promise<Outcome[]> {
    const outcomes = await Promise.all(
      endpoints.map(async (ep): Promise<Outcome | null> => {
        try {
          const response = await this.d.call(ep, name, args);
          return response.ok
            ? { ok: true, ep, result: response.result as CallToolResult }
            : { ok: false, ep, error: response.error };
        } catch (error) {
          if (error instanceof Unreachable) {
            this.d.gone?.(ep);
            return null;
          }
          return {
            ok: false,
            ep,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
    return outcomes.filter((o): o is Outcome => o !== null);
  }

  /** `bridge_info` of each profile, as `ProfileInfo`. */
  async infos(endpoints: Endpoint[]): Promise<ProfileInfo[]> {
    const outcomes = await this.callAll(endpoints, "bridge_info", {});
    return outcomes.map((o) => {
      const base: ProfileInfo = {
        profileKey: o.ep.key,
        label: null,
        ...(o.ep.legacy ? { legacy: true as const } : {}),
      };
      if (!o.ok) return { ...base, error: o.error };
      const v = firstJson(o.result) as {
        profileLabel?: unknown;
        windows?: unknown;
        tabs?: unknown;
        containers?: unknown;
        extensionVersion?: unknown;
      } | null;
      if (!v || typeof v !== "object")
        return { ...base, error: "bridge_info gave no JSON" };
      return {
        profileKey: o.ep.key,
        label:
          typeof v.profileLabel === "string" && v.profileLabel !== ""
            ? v.profileLabel
            : null,
        ...(typeof v.windows === "number" ? { windows: v.windows } : {}),
        ...(typeof v.tabs === "number" ? { tabs: v.tabs } : {}),
        ...(typeof v.containers === "number"
          ? { containers: v.containers }
          : {}),
        ...(typeof v.extensionVersion === "string"
          ? { extensionVersion: v.extensionVersion }
          : {}),
        ...(o.ep.legacy ? { legacy: true as const } : {}),
      };
    });
  }

  /**
   * Each profile's key and name, through the extension's `__profile`: answered by the extension itself, so it is not an
   * agent action (not counted, not in the popup's list). An extension of 0.1.x answers "pong" to it: `bridge_info` then.
   */
  async labels(endpoints: Endpoint[]): Promise<ProfileInfo[]> {
    const outcomes = await this.callAll(endpoints, PROFILE_TOOL, {});
    const found = new Map<string, ProfileInfo>();
    const old: Endpoint[] = [];
    for (const o of outcomes) {
      const v = o.ok
        ? (firstJson(o.result) as { profileLabel?: unknown } | undefined)
        : undefined;
      if (v && typeof v === "object" && "profileLabel" in v)
        found.set(o.ep.socket, {
          profileKey: o.ep.key,
          label:
            typeof v.profileLabel === "string" && v.profileLabel !== ""
              ? v.profileLabel
              : null,
          ...(o.ep.legacy ? { legacy: true as const } : {}),
        });
      else old.push(o.ep);
    }
    for (const info of await this.infos(old)) {
      const ep = old.find((e) => e.key === info.profileKey);
      if (ep) found.set(ep.socket, info);
    }
    return endpoints.flatMap((e) => found.get(e.socket) ?? []);
  }

  /**
   * Every profile's tab and window IDs, through the extension's own `__tabs` (not an agent action either); `list_tabs` for
   * an extension of 0.1.x.
   */
  private async tabIndex(endpoints: Endpoint[]): Promise<
    Array<{
      ep: Endpoint;
      list: Array<{ tabId?: unknown; windowId?: unknown }>;
    }>
  > {
    const outcomes = await this.callAll(endpoints, TABS_TOOL, {});
    const lists: Array<{
      ep: Endpoint;
      list: Array<{ tabId?: unknown; windowId?: unknown }>;
    }> = [];
    const old: Endpoint[] = [];
    for (const o of outcomes) {
      const v = o.ok ? firstJson(o.result) : undefined;
      if (Array.isArray(v)) lists.push({ ep: o.ep, list: v });
      else old.push(o.ep);
    }
    if (old.length > 0) {
      for (const o of await this.callAll(old, "list_tabs", {})) {
        const v = o.ok ? firstJson(o.result) : undefined;
        if (Array.isArray(v)) lists.push({ ep: o.ep, list: v });
      }
    }
    return lists;
  }

  /** `profile` is a key (exact) or a name (case-insensitive) of a connected profile. */
  private async resolve(
    profile: string,
    endpoints: Endpoint[],
  ): Promise<{ ep: Endpoint } | { error: string }> {
    const byKey = endpoints.find(
      (e) => e.key.toLowerCase() === profile.toLowerCase(),
    );
    if (byKey) return { ep: byKey };
    const infos = await this.labels(endpoints);
    const wanted = profile.trim().toLowerCase();
    const named = infos.filter((p) => p.label?.toLowerCase() === wanted);
    if (named.length === 1) {
      const ep = endpoints.find((e) => e.key === named[0]!.profileKey);
      if (ep) return { ep };
    }
    if (named.length > 1)
      return {
        error: `Several connected Chrome profiles are named ${JSON.stringify(profile)}: ${named.map(describe).join(", ")}. Use the key instead.`,
      };
    return {
      error: `No connected Chrome profile is named ${JSON.stringify(profile)}. Connected: ${infos.length ? infos.map(describe).join(", ") : "none"}.`,
    };
  }

  /** The profile that has `tabId`: the cache, else every profile's list_tabs. */
  private async findTab(
    tabId: number,
    endpoints: Endpoint[],
  ): Promise<{ ep: Endpoint } | { error: string }> {
    const cached = this.tabs.get(tabId);
    if (cached) {
      const ep = endpoints.find(
        (e) => e.key === cached.key && e.ino === cached.ino,
      );
      if (ep) return { ep };
    }
    const lists = await this.tabIndex(endpoints);
    const owners = lists
      .filter(({ list }) => list.some((t) => t?.tabId === tabId))
      .map(({ ep }) => ep);
    this.refresh(lists);
    if (owners.length === 1) return { ep: owners[0]! };
    if (owners.length === 0)
      return {
        error: `no tab with id ${tabId} in any connected Chrome profile (it may have been closed; call list_tabs)`,
      };
    const infos = await this.labels(owners);
    return {
      error: `tab id ${tabId} exists in several Chrome profiles (${infos.map(describe).join(", ")}): separate Chrome processes number their tabs independently. Pass profile: "<name or key>" with the tab ID.`,
    };
  }

  /** The profile that has window `windowId` (window IDs are numbered like tab IDs). */
  private async findWindow(
    windowId: number,
    endpoints: Endpoint[],
  ): Promise<{ ep: Endpoint } | { error: string }> {
    const owners = (await this.tabIndex(endpoints)).filter(({ list }) =>
      list.some((t) => t?.windowId === windowId),
    );
    if (owners.length === 1) return { ep: owners[0]!.ep };
    if (owners.length === 0)
      return {
        error: `no window with id ${windowId} in any connected Chrome profile (call list_tabs)`,
      };
    const infos = await this.labels(owners.map((o) => o.ep));
    return {
      error: `window id ${windowId} exists in several Chrome profiles (${infos.map(describe).join(", ")}). Pass profile: "<name or key>".`,
    };
  }

  private async aggregate(
    name: string,
    args: Record<string, unknown>,
    endpoints: Endpoint[],
  ): Promise<CallToolResult> {
    if (name === "bridge_info") {
      const profiles = await this.infos(endpoints);
      if (profiles.length === 0) return failure(this.d.unreachable());
      return jsonResult(bridgeInfo(profiles));
    }
    const [outcomes, infos] = await Promise.all([
      this.callAll(endpoints, name, args),
      this.labels(endpoints),
    ]);
    if (outcomes.length === 0) return failure(this.d.unreachable());
    const labels = new Map(infos.map((p) => [p.profileKey, p.label]));
    const items: unknown[] = [];
    const notes: string[] = [];
    let answered = 0;
    let firstError: string | null = null;
    const lists: Array<{ ep: Endpoint; list: unknown[] }> = [];
    for (const o of outcomes) {
      const tag = { key: o.ep.key, label: labels.get(o.ep.key) ?? null };
      if (!o.ok) {
        // A container filter that names a container of another profile is not an error of this one.
        if (
          name === "list_tabs" &&
          typeof args.containerId === "string" &&
          /^no container /.test(o.error)
        ) {
          firstError ??= o.error;
          continue;
        }
        firstError ??= o.error;
        notes.push(
          `note: the Chrome profile ${describe({ profileKey: tag.key, label: tag.label })} did not answer ${name}: ${o.error}`,
        );
        continue;
      }
      const list = firstJson(o.result);
      if (!Array.isArray(list)) {
        notes.push(
          `note: the Chrome profile ${describe({ profileKey: tag.key, label: tag.label })} gave an unexpected ${name} answer`,
        );
        continue;
      }
      answered += 1;
      // Filtered lists say nothing about the tabs that were left out.
      if (
        name === "list_tabs" &&
        args.windowId === undefined &&
        args.containerId === undefined
      )
        lists.push({ ep: o.ep, list });
      for (const item of list)
        items.push(
          item && typeof item === "object"
            ? { ...(item as object), profile: tag }
            : item,
        );
    }
    if (answered === 0) return failure(firstError ?? this.d.unreachable());
    if (lists.length > 0) this.refresh(lists);
    else if (name === "list_tabs") this.rememberFiltered(outcomes);
    return jsonResult(items, notes);
  }

  /**
   * What every listed profile has now. An ID that is in more than one list (separate Chrome processes) is kept as `null`:
   * it is routed only with `profile`. When every connected profile was listed, older entries go.
   */
  private refresh(lists: Array<{ ep: Endpoint; list: unknown[] }>): void {
    const listed = new Set(lists.map((l) => l.ep.socket));
    const all = this.d.discover().every((e) => listed.has(e.socket));
    if (all) this.tabs.clear();
    const where = new Map<number, Endpoint | null>();
    for (const { ep, list } of lists) {
      for (const t of list) {
        const id = (t as { tabId?: unknown })?.tabId;
        if (typeof id !== "number") continue;
        const seen = where.get(id);
        where.set(id, seen === undefined || seen === ep ? ep : null);
      }
    }
    for (const [id, ep] of where) {
      // Known to be in several profiles, and not every profile was asked this time: still ambiguous.
      if (!all && this.tabs.get(id) === null) continue;
      this.tabs.set(id, ep ? { key: ep.key, ino: ep.ino } : null);
    }
  }

  /** A filtered list_tabs: its tabs are where it says, unless an ID is already known to be in several profiles. */
  private rememberFiltered(outcomes: Outcome[]): void {
    for (const o of outcomes) if (o.ok) this.remember(o.ep, o.result);
  }

  /** A tab ID in the answer of a tool that ran in `ep` (a new tab, a tab a domain rule replaced) belongs to `ep`. */
  private remember(ep: Endpoint, result: CallToolResult): void {
    const v = firstJson(result);
    const ids: number[] = [];
    if (Array.isArray(v)) {
      for (const t of v) {
        const id = (t as { tabId?: unknown })?.tabId;
        if (typeof id === "number") ids.push(id);
      }
    } else if (v && typeof v === "object") {
      const id = (v as { tabId?: unknown }).tabId;
      if (typeof id === "number") ids.push(id);
    }
    for (const id of ids) {
      if (this.tabs.get(id) === null) continue; // known to be in several profiles
      this.tabs.set(id, { key: ep.key, ino: ep.ino });
    }
  }
}

/**
 * `bridge_info` across profiles: `profiles` always; with exactly one profile also its fields at the top level, the shape
 * the tool had before there could be several.
 */
export function bridgeInfo(profiles: ProfileInfo[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (profiles.length === 1) {
    const p = profiles[0]!;
    Object.assign(out, {
      profileKey: p.profileKey,
      profileLabel: p.label,
      ...(p.windows !== undefined ? { windows: p.windows } : {}),
      ...(p.tabs !== undefined ? { tabs: p.tabs } : {}),
      ...(p.containers !== undefined ? { containers: p.containers } : {}),
      ...(p.extensionVersion !== undefined
        ? { extensionVersion: p.extensionVersion }
        : {}),
    });
  }
  out.profiles = profiles;
  if (profiles.length > 1) {
    const unnamed = profiles.filter((p) => p.label === null).length;
    const names = profiles.map((p) => p.label?.toLowerCase()).filter(Boolean);
    const duplicate = new Set(names).size !== names.length;
    if (unnamed > 0 || duplicate)
      out.hint =
        "Some profiles have no name (or the same one): ask the user to name each in SplitSession Settings → For AI agents → Advanced → Profile name, or use the profile keys.";
  }
  if (profiles.some((p) => p.legacy))
    out.legacyNote =
      'The profile with key "legacy" uses the shared socket of SplitSession 0.1.x (an older extension or bridge host); only one such profile can be connected at a time.';
  return out;
}
