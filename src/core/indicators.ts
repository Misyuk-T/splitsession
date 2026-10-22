import { CONTAINER_COLORS, type ContainerColor } from "./types";

/** Colours of the container dots, tab badges and (nearest match) tab groups. Firefox's container palette. */
export const CONTAINER_HEX: Readonly<Record<ContainerColor, string>> = {
  blue: "#37adff",
  turquoise: "#00c79a",
  green: "#51cd00",
  yellow: "#ffcb00",
  orange: "#ff9f00",
  red: "#ff613d",
  pink: "#ff4bda",
  purple: "#af51f5",
};

/** Chrome tab-group colours: grey, blue, red, yellow, green, pink, purple, cyan, orange. */
export type ChromeGroupColor =
  "blue" | "red" | "yellow" | "green" | "pink" | "purple" | "cyan" | "orange";

export const GROUP_COLOR: Readonly<Record<ContainerColor, ChromeGroupColor>> = {
  blue: "blue",
  turquoise: "cyan",
  green: "green",
  yellow: "yellow",
  orange: "orange",
  red: "red",
  pink: "pink",
  purple: "purple",
};

/**
 * The two colours a container's tab group alternates between while the agent works in it (Full): purple and pink, the
 * agent's colours; red and orange when the container is itself purple or pink (the pulse must differ from the group's own
 * colour). The title is never touched, so the chip keeps its width and the tabs do not jump.
 */
export function agentGroupColors(
  current: ContainerColor,
): readonly [ChromeGroupColor, ChromeGroupColor] {
  const own = GROUP_COLOR[current];
  return own === "purple" || own === "pink"
    ? ["red", "orange"]
    : ["purple", "pink"];
}

/**
 * The container colour a Chrome group colour stands for (the user recoloured the group in Chrome's menu). The current
 * colour wins when it maps to that same group colour; null for a colour no container has (grey).
 */
export function containerColorOfGroup(
  group: string,
  current: ContainerColor,
): ContainerColor | null {
  if (GROUP_COLOR[current] === group) return current;
  return CONTAINER_COLORS.find((color) => GROUP_COLOR[color] === group) ?? null;
}

/** Black or white, whichever reads better on the colour (WCAG relative luminance). */
export function readableTextColor(hex: string): "#000000" | "#ffffff" {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "#000000";
  const n = parseInt(m[1]!, 16);
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const luminance =
    0.2126 * channel((n >> 16) & 255) +
    0.7152 * channel((n >> 8) & 255) +
    0.0722 * channel(n & 255);
  return luminance > 0.35 ? "#000000" : "#ffffff";
}

/** The colour of every agent indicator (glow, favicon, pill, toolbar dot): "the agent is here". */
export const AGENT_COLOR = "#8b5cf6";
/** The lighter purple the agent dot blinks to (violet-300). */
export const AGENT_DIM_COLOR = "#c4b5fd";

/** `a` mixed with `b`: `t` 0 is `a`, 1 is `b`. Opaque lowercase `#rrggbb`; a colour that is not `#rrggbb` gives `a`. */
export function mixHex(a: string, b: string, t: number): string {
  const ma = /^#?([0-9a-f]{6})$/i.exec(a);
  const mb = /^#?([0-9a-f]{6})$/i.exec(b);
  if (!ma || !mb) return a;
  const na = parseInt(ma[1]!, 16);
  const nb = parseInt(mb[1]!, 16);
  const k = Math.min(1, Math.max(0, t));
  const part = (shift: number) =>
    Math.round(((na >> shift) & 255) * (1 - k) + ((nb >> shift) & 255) * k)
      .toString(16)
      .padStart(2, "0");
  return `#${part(16)}${part(8)}${part(0)}`;
}

// ---- Title prefix ----

/**
 * In front of the title of a container tab that is not inside its container's tab group. The glyph of the group titles,
 * and no name: the page can read its title, and learns only that this is a container tab.
 */
export const OUTSIDE_MARK = "⧉ ";

export const titlePrefixFor = (name: string): string => `[${name}] `;

/**
 * The title that should be shown: `prefix` followed by the page's own title, exactly once. A title that already starts
 * with the prefix is returned unchanged (our own write coming back through the observer), and `previous` (the prefix
 * of an earlier name, after a rename) is replaced instead of stacked. An empty page title stays empty: Chrome then
 * shows the address, which is better than a bare prefix.
 */
export function prefixedTitle(
  title: string,
  prefix: string,
  previous?: string,
): string {
  // `previous` first: the new prefix may be longer or shorter than it and start the same ("⧉ " / "⧉ [Work] ").
  if (previous && previous !== prefix && title.startsWith(previous)) {
    const rest = title.slice(previous.length);
    return rest === "" ? "" : prefix + rest;
  }
  if (title.startsWith(prefix)) return title;
  return title === "" ? "" : prefix + title;
}

/** The page's own title: `prefix` removed from the front when present. */
export function unprefixedTitle(title: string, prefix: string): string {
  return title.startsWith(prefix) ? title.slice(prefix.length) : title;
}

// ---- Agent activity mark ----

/**
 * Marks that older versions of the agent bridge put in front of a tab's title (eye for reads, robot for actions), after
 * the `[container] ` prefix: "[Work] 👁 Inbox". Nothing writes them any more (the title is never touched); the list stays
 * so that `withoutAgentMark` can still clean a title that an older worker left behind.
 */
export const AGENT_READ_FRAMES = ["👁 ", "👀 "] as const;
export const AGENT_ACT_FRAMES = ["🤖◐ ", "🤖◓ ", "🤖◑ ", "🤖◒ "] as const;
/** Every mark that may stand in front of a title, longest first (the static forms of older versions included). */
export const AGENT_TITLE_MARKS = [
  ...AGENT_ACT_FRAMES,
  ...AGENT_READ_FRAMES,
  "🤖 ",
] as const;

/**
 * The title without our own marks: the outside-group mark ("⧉ ") and the agent mark; the `[container] ` prefix stays.
 * For everything an agent reads (tab lists, the action log), which must not show our marks.
 */
export function withoutAgentMark(title: string): string {
  const body = title.startsWith(OUTSIDE_MARK)
    ? title.slice(OUTSIDE_MARK.length)
    : title;
  const prefix = /^\[[^\]]*\] /.exec(body)?.[0] ?? "";
  const rest = body.slice(prefix.length);
  for (const mark of AGENT_TITLE_MARKS)
    if (rest.startsWith(mark)) return prefix + rest.slice(mark.length);
  return body;
}
