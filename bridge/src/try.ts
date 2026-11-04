import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { UsageError } from "./cli";
import type { Dispatcher } from "./dispatch";

/**
 * `splitsession-bridge try`: a one-shot, read-only self-test for people without an MCP client (Chrome Web Store reviewers).
 * It asks the running extension the way the MCP server does (the same dispatcher and socket calls) and prints one
 * PASS/FAIL line per step. What it may show about the user's tabs: container names and colours (the user's own labels),
 * counts, and the tab IDs of tabs whose host is exactly example.com. Titles and URLs of tabs are never printed; text and
 * snapshot only of the one tab named with `--tab`. It clicks, types, navigates and opens nothing, and deletes nothing.
 */

export interface TryOptions {
  profile?: string;
  tab?: number;
}

export const TRY_USAGE = `usage: splitsession-bridge try [--profile <name or key>] [--tab <id>]

try      a read-only self-test of the running bridge, for people without an AI client. It needs the host installed
         ("install") and the "Agent bridge" switch on (SplitSession Settings > For AI agents). It runs bridge_info,
         list_containers and list_tabs and prints one PASS/FAIL line each: versions, mode, counts, container names and
         colours; never titles or URLs of your tabs. With --tab <id> it also reads that one tab (get_tab_text, snapshot).
         Open https://example.com (optionally in a container) first: try prints the tab IDs of tabs on example.com.
         --profile picks a Chrome profile when several have the bridge on. Exit code 0 when every step passed.
         It clicks, types and navigates nothing, opens no tab and writes nothing.
`;

/** `[--profile <p>] [--tab <id>]` (also `--flag=value`). Throws UsageError. */
export function parseTryArgs(argv: string[]): TryOptions {
  const out: TryOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    let flag = argv[i] ?? "";
    let value: string | undefined;
    const eq = flag.indexOf("=");
    if (flag.startsWith("--") && eq !== -1) {
      value = flag.slice(eq + 1);
      flag = flag.slice(0, eq);
    }
    const take = () => {
      if (value !== undefined) return value;
      i += 1;
      const next = argv[i];
      if (next === undefined || next.startsWith("--"))
        throw new UsageError(`${flag} needs a value`);
      return next;
    };
    if (flag === "--profile") {
      const v = take().trim();
      if (v === "") throw new UsageError("--profile needs a value");
      out.profile = v;
    } else if (flag === "--tab") {
      const v = take();
      if (!/^\d{1,15}$/.test(v))
        throw new UsageError(
          `--tab needs a tab ID (a whole number, from the example.com line of try or from list_tabs), not "${v}"`,
        );
      out.tab = Number(v);
    } else {
      throw new UsageError(`unknown option "${flag}"`);
    }
  }
  return out;
}

export interface TryEnv {
  log: (line: string) => void;
  version?: string;
}

type Runner = Pick<Dispatcher, "run">;

const textBlocks = (r: CallToolResult): string[] =>
  (r.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => (c as { text: string }).text);

const jsonOf = (r: CallToolResult): unknown => {
  try {
    return JSON.parse(textBlocks(r)[0] ?? "");
  } catch {
    return undefined;
  }
};

const oneLine = (s: string, max: number): string => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/** Host of a tab URL when it is exactly example.com (and nothing else about the URL). */
export const isExampleCom = (url: unknown): boolean => {
  if (typeof url !== "string") return false;
  try {
    const u = new URL(url);
    return (
      (u.protocol === "https:" || u.protocol === "http:") &&
      u.hostname === "example.com"
    );
  } catch {
    return false;
  }
};

interface ProfileRow {
  profileKey?: unknown;
  label?: unknown;
  extensionVersion?: unknown;
  mode?: unknown;
  windows?: unknown;
  tabs?: unknown;
  containers?: unknown;
  error?: unknown;
}

const profileName = (p: ProfileRow): string =>
  `${typeof p.label === "string" && p.label !== "" ? JSON.stringify(p.label) : "unnamed"} (key ${String(p.profileKey)})`;

/** Runs the steps; returns the exit code (0: every step passed). `unreachable` is the message for "nothing is connected". */
export async function runTry(
  options: TryOptions,
  dispatcher: Runner,
  env: TryEnv,
): Promise<number> {
  const { log } = env;
  let failed = false;
  const pass = (step: string, text: string) => log(`PASS  ${step}: ${text}`);
  const fail = (step: string, text: string) => {
    failed = true;
    log(`FAIL  ${step}: ${text}`);
  };
  const profileArg = options.profile ? { profile: options.profile } : {};
  log(`splitsession-bridge try (bridge ${env.version ?? "dev"}), read-only`);

  // 1. bridge_info
  const info = await dispatcher.run("bridge_info", { ...profileArg });
  if (info.isError) {
    fail("bridge_info", oneLine(textBlocks(info).join(" "), 600));
    return 1;
  }
  const body = jsonOf(info) as { profiles?: ProfileRow[] } | undefined;
  const profiles = body?.profiles ?? [];
  if (profiles.length === 0) {
    fail("bridge_info", "no profile answered");
    return 1;
  }
  let answered = 0;
  for (const p of profiles) {
    if (typeof p.error === "string") {
      fail(
        "bridge_info",
        `profile ${profileName(p)} did not answer: ${oneLine(p.error, 300)}`,
      );
      continue;
    }
    answered += 1;
    const bits = [
      `extension ${typeof p.extensionVersion === "string" ? p.extensionVersion : "version unknown"}`,
      `mode ${typeof p.mode === "string" ? p.mode : "unknown (older extension: full)"}`,
      ...(typeof p.windows === "number" ? [plural(p.windows, "window")] : []),
      ...(typeof p.tabs === "number" ? [plural(p.tabs, "tab")] : []),
      ...(typeof p.containers === "number"
        ? [plural(p.containers, "container")]
        : []),
    ];
    pass("bridge_info", `profile ${profileName(p)}: ${bits.join(", ")}`);
  }
  if (answered === 0) return 1;
  if (profiles.length > 1 && !options.profile) {
    fail(
      "profile",
      `${profiles.length} Chrome profiles have the bridge on; pick one with --profile "<name or key>" (names and keys above)`,
    );
    return 1;
  }

  // 2. list_containers
  const containers = await dispatcher.run("list_containers", {
    ...profileArg,
  });
  const containerList = jsonOf(containers);
  if (containers.isError || !Array.isArray(containerList)) {
    fail(
      "list_containers",
      containers.isError
        ? oneLine(textBlocks(containers).join(" "), 600)
        : "unexpected answer",
    );
  } else if (containerList.length === 0) {
    pass(
      "list_containers",
      "no containers yet (create one in SplitSession to see it here)",
    );
  } else {
    const names = containerList.map((c: { name?: unknown; color?: unknown }) =>
      typeof c.color === "string"
        ? `${String(c.name)} (${c.color})`
        : String(c.name),
    );
    pass(
      "list_containers",
      `${plural(containerList.length, "container")}: ${names.join(", ")}`,
    );
  }

  // 3. list_tabs: counts only, plus the IDs of tabs on example.com
  const tabs = await dispatcher.run("list_tabs", { ...profileArg });
  const tabList = jsonOf(tabs);
  const examples: Array<{ tabId: number; container: string | null }> = [];
  if (tabs.isError || !Array.isArray(tabList)) {
    fail(
      "list_tabs",
      tabs.isError
        ? oneLine(textBlocks(tabs).join(" "), 600)
        : "unexpected answer",
    );
  } else {
    const perContainer = new Map<string, number>();
    let plain = 0;
    for (const t of tabList as Array<{
      tabId?: unknown;
      url?: unknown;
      container?: { name?: unknown } | null;
    }>) {
      const name =
        t.container && typeof t.container.name === "string"
          ? t.container.name
          : null;
      if (name === null) plain += 1;
      else perContainer.set(name, (perContainer.get(name) ?? 0) + 1);
      if (typeof t.tabId === "number" && isExampleCom(t.url))
        examples.push({ tabId: t.tabId, container: name });
    }
    const parts = [
      ...[...perContainer].map(([n, c]) => `${c} in ${n}`),
      ...(plain > 0 || perContainer.size === 0
        ? [`${plain} outside containers`]
        : []),
    ];
    pass("list_tabs", `${plural(tabList.length, "tab")} (${parts.join(", ")})`);
  }

  // 4. one tab, only when asked
  if (options.tab === undefined) {
    log(
      examples.length > 0
        ? `hint: tabs on example.com: ${examples
            .map(
              (e) =>
                `tab ${e.tabId}${e.container ? ` (container ${e.container})` : ""}`,
            )
            .join(", ")}. Run again with --tab <id> to read one of them.`
        : "hint: to try reading a page, open https://example.com (optionally in a container), then run again with --tab <id> (try prints the ID of tabs on example.com).",
    );
  } else {
    const tabArg = { tabId: options.tab, ...profileArg };
    const text = await dispatcher.run("get_tab_text", {
      ...tabArg,
      maxChars: 200,
    });
    if (text.isError)
      fail("get_tab_text", oneLine(textBlocks(text).join(" "), 600));
    else {
      const blocks = textBlocks(text);
      const page = blocks.length > 1 ? blocks[blocks.length - 1]! : "";
      pass(
        "get_tab_text",
        `tab ${options.tab}: ${page.trim() === "" ? "(no visible text)" : `"${oneLine(page, 200)}"`}`,
      );
    }
    const snap = await dispatcher.run("snapshot", { ...tabArg });
    if (snap.isError)
      fail("snapshot", oneLine(textBlocks(snap).join(" "), 600));
    else {
      const blocks = textBlocks(snap);
      const tree =
        blocks.length > 1 ? blocks[blocks.length - 1]! : (blocks[0] ?? "");
      const lines = tree.split("\n").filter((l) => l.trim() !== "");
      const elements = lines.filter((l) => /\[ref=e\d+\]/.test(l)).length;
      pass(
        "snapshot",
        `tab ${options.tab}: ${plural(elements, "element")} with a ref; first lines:`,
      );
      for (const l of lines.slice(0, 10)) log(`        ${oneLine(l, 160)}`);
    }
  }

  log(failed ? "\nFAIL" : "\nPASS: the bridge works.");
  return failed ? 1 : 0;
}
