import { collapseName, sanitizeNameInput } from "../names";
import type { ContainerId } from "../types";

/**
 * SplitSession's groups are titled `⧉ ` + name + marker, where the marker is the container ID as invisible characters:
 * U+2063 + three of four zero-width characters per ID character + U+2063. Chrome keeps the title as it is through
 * session restore and saved groups. Two parts, two jobs:
 * - the visible glyph "⧉ " only tells the user which groups are SplitSession's. It is NOT evidence: a group the user
 *   titled "⧉ fake" is the user's own and decides nothing;
 * - the invisible marker is the identification (the group -> container map, `ownedGroups`, is the other one, for a group
 *   whose marker the user's retyping removed). A title without the marker names no container.
 * Titles of earlier versions (name + marker, no glyph) are still recognised and are rewritten to the new form.
 */
const MARK = "⁣";
const DIGITS = ["​", "‌", "‍", "⁠"] as const;
const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
// eslint-disable-next-line no-misleading-character-class -- the digits are four distinct zero-width code points, each one a single character
const MARKER_RE = new RegExp(`${MARK}([${DIGITS.join("")}]{3,96})${MARK}$`);

export function groupMarker(containerId: ContainerId): string {
  if (!/^[a-z0-9]{1,32}$/.test(containerId)) return "";
  let out = MARK;
  for (const ch of containerId) {
    const n = ID_ALPHABET.indexOf(ch);
    out += DIGITS[(n >> 4) & 3]! + DIGITS[(n >> 2) & 3]! + DIGITS[n & 3]!;
  }
  return out + MARK;
}

/** The visible prefix of every SplitSession group title. */
export const GROUP_GLYPH = "⧉";
export const GROUP_PREFIX = `${GROUP_GLYPH} `;

/**
 * Full only (the agent activity mark): while the agent works in a tab of a group, the group's glyph blinks between two sparkles,
 * "✦" (U+2726) and "✧" (U+2727), instead of "⧉"; the rest of the title (name, invisible marker) stays exactly as it is and the
 * group's colour is never touched. They are as wide as "⧉" (measured, canvas `12px system-ui` in Chrome: ⧉ 9.55 px, ✦ -0.04 px,
 * ✧ -0.02 px against it; emoji such as 🟣 ⚪ are 15 px and made the tabs jump), so neither a blink nor the start and the end move the
 * tabs next to the group chip. In Lite the list is empty and the literals are dropped from the bundle.
 */
export const AGENT_MARK_GLYPHS: readonly string[] = __FULL__
  ? ["\u2726", "\u2727"]
  : [];

/** A group's glyph: `false` the idle "⧉", or the index of a frame of the blink (Full only). */
export type GroupGlyph = false | number;

const prefixOf = (glyph: GroupGlyph): string =>
  !__FULL__ || glyph === false
    ? GROUP_PREFIX
    : `${AGENT_MARK_GLYPHS[glyph % AGENT_MARK_GLYPHS.length]} `;

/** `glyph`: a frame of the agent-activity blink (Full only; Lite always gets the plain glyph). */
export function groupTitle(
  name: string,
  containerId: ContainerId,
  glyph: GroupGlyph = false,
): string {
  return prefixOf(glyph) + name + groupMarker(containerId);
}

/**
 * The glyph at the front of a title with its space and the whitespace before it. "⧉" always; in Full also the mark glyphs
 * "✦" "✧" (each may carry U+FE0F, the optional variation selector) and, recognised for one release so that a group an earlier
 * build left marked is cleaned up and the glyph never becomes part of a container name, the blink emoji of 0.1.7-dev builds ("🟣" is
 * a surrogate pair, hence the `u` flag; "⚪") and the "◉ ◎ ○" of 0.1.5-dev builds (remove the legacy ones after the next release).
 */
const LEADING_GLYPH_RE = __FULL__
  ? /^\s*(?:(?:[⧉✦✧◉◎○\u26AA]|\u{1F7E3})\uFE0F? ?)?/u
  : /^\s*(?:⧉ ?)?/;

/** The title with its leading glyph (and the whitespace before it) replaced by the idle "⧉ " or a frame of the blink; name and marker untouched. */
export function groupTitleWithGlyph(title: string, glyph: GroupGlyph): string {
  // The same prefix groupNameOf takes off: a title the user typed as " ✦ Job" or "✧Job" gets the glyph swapped, never a second one.
  return prefixOf(glyph) + title.replace(LEADING_GLYPH_RE, "");
}

/** Whether the title leads with an agent-mark glyph (a sparkle, or a legacy emoji / "◉ ◎ ○") instead of "⧉" (Full only). */
export function hasMarkGlyph(title: string | undefined): boolean {
  return __FULL__ && /^\s*(?:[✦✧◉◎○\u26AA]|\u{1F7E3})/u.test(title ?? "");
}

/** A container name never starts with a group glyph: it would be taken for the glyph the next time the title is read. */
export function startsWithGroupGlyph(name: string): boolean {
  return (__FULL__ ? /^\s*(?:[⧉✦✧◉◎○\u26AA]|\u{1F7E3})/u : /^\s*⧉/).test(name);
}

/**
 * The container name a (possibly edited) group title says: the invisible marker and stray invisible characters taken off,
 * one leading glyph ("⧉", a mark sparkle, or a legacy emoji / "◉ ◎ ○") with its space taken off, whitespace collapsed. Not validated (see `checkContainerName`).
 */
export function groupNameOf(title: string | undefined): string {
  const bare = stripGroupMarker(title ?? "").replace(/[\u2061-\u2064]/g, "");
  return collapseName(
    sanitizeNameInput(bare.replace(LEADING_GLYPH_RE, ""), 1000),
  );
}

/** The container a title's marker names, or null (no marker, or a malformed one). */
export function decodeGroupMarker(
  title: string | undefined,
): ContainerId | null {
  const m = title ? MARKER_RE.exec(title) : null;
  if (!m || m[1]!.length % 3 !== 0) return null;
  let id = "";
  for (let i = 0; i < m[1]!.length; i += 3) {
    const d = (k: number) =>
      DIGITS.indexOf(m[1]![i + k] as (typeof DIGITS)[number]);
    const n = (d(0) << 4) | (d(1) << 2) | d(2);
    if (n >= ID_ALPHABET.length) return null;
    id += ID_ALPHABET[n];
  }
  return id;
}

export function stripGroupMarker(title: string): string {
  return title.replace(MARKER_RE, "");
}
