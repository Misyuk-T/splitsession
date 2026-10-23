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
 * - Tools on a tab (`tabId`): checked live every time (`__tabs`, which the extension answers without counting it): exactly
 *   one profile (or the one `profile` names) must have the tab, and it must be where the agent saw it (same profile, same
 *   host session), else the ID is stale and nothing is done. Chrome numbers tabs once per browser process, so the profiles
 *   of one Chrome never share a tab ID; profiles of separate Chrome processes can, and then `profile` must say which.
 * - Tools that open a tab (`open_tab`, `open_in_container`): `profile`, or the profile of `windowId`, or the only profile;
 *   never a guess when several are connected.
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
  | { ok: true; ep: Endpoint; session: string; result: CallToolResult }
  | { ok: false; ep: Endpoint; session: string; error: string };

/** Where the agent saw a tab ID: a profile and the host process (session) that served it then. */
interface Sighting {
  key: string;
  session: string;
}

/**
 * The host's session: a random ID per host process (bridge 0.2+ stamps it on every answer). A host of 0.1.x has none:
 * then the socket file's inode stands for it (a new host makes a new socket file).
 */
const sessionOf = (ep: Endpoint, response: ClientResponse): string =>
  typeof response.session === "string" && response.session !== ""
    ? response.session
    : `ino:${ep.ino}`;

type TabList = {
  ep: Endpoint;
  session: string;
  list: Array<{ tabId?: unknown; windowId?: unknown }>;
};

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

/** `"Work" (key k1abc23def)`, or `unnamed (key …)`. */
const describe = (p: ProfileInfo) =>
  `${p.label === null ? "unnamed" : JSON.stringify(p.label)} (key ${p.profileKey})`;

export class Dispatcher {
  /**
   * Where the agent last saw each tab ID (lists and tool answers): the affinity that keeps a stale ID from reaching a
   * different tab. Never used to pick a profile on its own: every tab tool first checks, live, which profile has the tab.
   */
  private readonly seen = new Map<number, Sighting[]>();
  /**
   * Tab IDs the agent has seen in more than one profile since the last complete `list_tabs` (every connected profile,
   * unfiltered, every one answering). Such an ID is never acted on without `profile`, even when one profile alone has it
   * now: a sighting in one of them cannot tell which tab the agent meant. Only a complete list that shows one owner clears
   * it; a list of one profile does not.
   */
  private readonly colliding = new Set<number>();

  constructor(private readonly d: DispatchDeps) {}

  /** `args` are already validated; `profile` is ours and never reaches the extension. */
  async run(
    name: string,
    allArgs: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const { profile, ...args } = allArgs;
    const endpoints = this.d.discover();
    if (endpoints.length === 0) return failure(this.d.unreachable());

    let chosen: Endpoint | undefined;
    if (typeof profile === "string") {
      const found = await this.resolve(profile, endpoints);
      if ("error" in found) return failure(found.error);
      chosen = found.ep;
    }

    if (AGGREGATE.has(name))
      return this.aggregate(name, args, chosen ? [chosen] : endpoints, !chosen);

    let target: Endpoint | undefined;
    if (typeof args.tabId === "number") {
      // Every tool on a tab, with one profile or many, with `profile` or without: who has this tab NOW, and is it the tab
      // the agent saw?
      const found = await this.ownerOf(args.tabId, endpoints, chosen);
      if ("error" in found) return failure(found.error);
      target = found.ep;
    } else if (chosen) {
      target = chosen;
    } else if (CREATE.has(name) && typeof args.windowId === "number") {
      const found = await this.findWindow(args.windowId, endpoints);
      if ("error" in found) return failure(found.error);
      target = found.ep;
    } else if (endpoints.length === 1) {
      target = endpoints[0];
    }
    if (!target) {
      const infos = await this.labels(this.d.discover());
      return failure(
        `Several Chrome profiles have the SplitSession agent bridge on: ${infos.map(describe).join(", ")}. ` +
          `Say which one with profile: "<name or key>" (bridge_info lists them); a tool on a tab finds the tab's profile by itself.`,
      );
    }

    const outcome = await this.callOne(target, name, args);
    if (!outcome.ok) return failure(outcome.error);
    // A new tab replaces whatever the agent saw under that number; any other answer adds to it.
    this.sawIn(outcome, firstJson(outcome.result), !CREATE.has(name));
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
      const session = sessionOf(ep, response);
      if (!response.ok)
        return { ok: false, ep, session, error: response.error };
      return {
        ok: true,
        ep,
        session,
        result: response.result as CallToolResult,
      };
    } catch (error) {
      const session = `ino:${ep.ino}`;
      if (error instanceof Unreachable) {
        this.d.gone?.(ep);
        const left = this.d.discover().filter((e) => e.socket !== ep.socket);
        return {
          ok: false,
          ep,
          session,
          error:
            left.length === 0
              ? this.d.unreachable()
              : `the Chrome profile ${ep.key === LEGACY_KEY ? "on the shared socket" : `with key ${ep.key}`} is not connected any more (its bridge was switched off); call list_tabs`,
        };
      }
      return {
        ok: false,
        ep,
        session,
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
          const session = sessionOf(ep, response);
          return response.ok
            ? {
                ok: true,
                ep,
                session,
                result: response.result as CallToolResult,
              }
            : { ok: false, ep, session, error: response.error };
        } catch (error) {
          if (error instanceof Unreachable) {
            this.d.gone?.(ep);
            return null;
          }
          return {
            ok: false,
            ep,
            session: `ino:${ep.ino}`,
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
   * Every profile's tab and window IDs, live, through the extension's own `__tabs` (not an agent action); `list_tabs` for
   * an extension of 0.1.x. Each list comes with the session of the host that answered.
   */
  private async tabIndex(endpoints: Endpoint[]): Promise<TabList[]> {
    const outcomes = await this.callAll(endpoints, TABS_TOOL, {});
    const lists: TabList[] = [];
    const old: Endpoint[] = [];
    for (const o of outcomes) {
      const v = o.ok ? firstJson(o.result) : undefined;
      if (Array.isArray(v))
        lists.push({ ep: o.ep, session: o.session, list: v });
      else old.push(o.ep);
    }
    if (old.length > 0) {
      for (const o of await this.callAll(old, "list_tabs", {})) {
        const v = o.ok ? firstJson(o.result) : undefined;
        if (Array.isArray(v))
          lists.push({ ep: o.ep, session: o.session, list: v });
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

  /**
   * The one profile that has `tabId` right now (or, with `profile`, that profile, which must have it), checked live. Then
   * the affinity: if the agent saw this ID in another profile, or in the same profile under an earlier host session (the
   * bridge restarted; Chrome may have restarted and numbered tabs again), the ID is stale and nothing is done.
   */
  private async ownerOf(
    tabId: number,
    endpoints: Endpoint[],
    chosen: Endpoint | undefined,
  ): Promise<{ ep: Endpoint } | { error: string }> {
    const lists = await this.tabIndex(chosen ? [chosen] : endpoints);
    const owners = lists.filter(({ list }) =>
      list.some((t) => t?.tabId === tabId),
    );
    if (owners.length === 0) {
      if (chosen) {
        const [info] = await this.labels([chosen]);
        return {
          error: `no tab with id ${tabId} in the Chrome profile ${info ? describe(info) : `with key ${chosen.key}`} (it may have been closed; call list_tabs)`,
        };
      }
      return {
        error: `no tab with id ${tabId} in any connected Chrome profile (it may have been closed; call list_tabs)`,
      };
    }
    if (owners.length > 1) {
      const infos = await this.labels(owners.map((o) => o.ep));
      return {
        error: `tab id ${tabId} exists in several Chrome profiles (${infos.map(describe).join(", ")}): separate Chrome processes number their tabs independently. Pass profile: "<name or key>" with the tab ID.`,
      };
    }
    const owner = owners[0]!;
    if (!chosen && this.colliding.has(tabId)) {
      const infos = await this.labels(endpoints);
      const where = [...new Set((this.seen.get(tabId) ?? []).map((s) => s.key))]
        .map((key) => {
          const info = infos.find((p) => p.profileKey === key);
          return info ? describe(info) : `key ${key} (not connected now)`;
        })
        .join(", ");
      return {
        error: `tab id ${tabId} exists in several Chrome profiles (you saw it in ${where || "more than one"}); nothing was done. Pass profile: "<name or key>" with the tab ID, or call list_tabs again.`,
      };
    }
    const seen = this.seen.get(tabId);
    if (
      seen &&
      !seen.some((s) => s.key === owner.ep.key && s.session === owner.session)
    ) {
      const infos = await this.labels(endpoints);
      const where = [...new Set(seen.map((s) => s.key))]
        .map((key) => {
          const info = infos.find((p) => p.profileKey === key);
          return info ? describe(info) : `key ${key} (not connected now)`;
        })
        .join(", ");
      const restarted = seen.some((s) => s.key === owner.ep.key);
      return {
        error: `stale tab id ${tabId}: the tab you saw in the Chrome profile ${where} is gone${restarted ? " (that profile's bridge has restarted since, and tab IDs may have been reused)" : ""}; nothing was done. Call list_tabs again.`,
      };
    }
    return { ep: owner.ep };
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
    everyProfile: boolean,
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
    const lists: Array<{ o: Outcome; list: unknown[] }> = [];
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
      if (name === "list_tabs") lists.push({ o, list });
      for (const item of list)
        items.push(
          item && typeof item === "object"
            ? { ...(item as object), profile: tag }
            : item,
        );
    }
    if (answered === 0) return failure(firstError ?? this.d.unreachable());
    if (name === "list_tabs") {
      // A full list is a fresh look: what the agent saw before is replaced (for every profile, or for the one it asked).
      // A list filtered by window or container says nothing about the tabs it left out: it only adds.
      const full =
        args.windowId === undefined && args.containerId === undefined;
      // Complete: every connected profile answered an unfiltered list. Only that resets the collision marks.
      const complete =
        full &&
        everyProfile &&
        this.d
          .discover()
          .every((e) => lists.some(({ o }) => o.ep.socket === e.socket));
      if (complete) {
        this.seen.clear();
        this.colliding.clear();
      } else if (full) for (const { o } of lists) this.forgetProfile(o.ep.key);
      for (const { o, list } of lists) this.sawIn(o, list, true);
    }
    return jsonResult(items, notes);
  }

  /** The agent's view of one profile is replaced by a new full list of it. */
  private forgetProfile(key: string): void {
    for (const [id, sightings] of this.seen) {
      const rest = sightings.filter((s) => s.key !== key);
      if (rest.length === 0) this.seen.delete(id);
      else this.seen.set(id, rest);
    }
  }

  /**
   * Tab IDs in an answer (a list, or one tab: a new tab, a tab a domain rule replaced) were seen in that profile under that
   * host session. `add`: on top of what else the agent saw under that number (two Chrome processes may both have it);
   * otherwise (a tab the agent just opened) instead of it.
   */
  private sawIn(o: Outcome, value: unknown, add: boolean): void {
    const ids: number[] = [];
    for (const t of Array.isArray(value) ? value : [value]) {
      const id = (t as { tabId?: unknown } | null)?.tabId;
      if (typeof id === "number") ids.push(id);
    }
    const here: Sighting = { key: o.ep.key, session: o.session };
    for (const id of ids) {
      const before = add ? (this.seen.get(id) ?? []) : [];
      const now = [
        ...before.filter(
          (s) => s.key !== here.key || s.session !== here.session,
        ),
        here,
      ];
      this.seen.set(id, now);
      if (new Set(now.map((s) => s.key)).size > 1) this.colliding.add(id);
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
