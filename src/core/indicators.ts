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

// ---- Title prefix ----

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
  if (title.startsWith(prefix)) return title;
  const stripped =
    previous && previous !== prefix && title.startsWith(previous)
      ? title.slice(previous.length)
      : title;
  return stripped === "" ? "" : prefix + stripped;
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

/** The title without the agent mark (the `[container] ` prefix stays). For the action log, which must not show our own marks. */
export function withoutAgentMark(title: string): string {
  const prefix = /^\[[^\]]*\] /.exec(title)?.[0] ?? "";
  const rest = title.slice(prefix.length);
  for (const mark of AGENT_TITLE_MARKS)
    if (rest.startsWith(mark)) return prefix + rest.slice(mark.length);
  return title;
}
