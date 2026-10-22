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
 * Full only (the agent activity mark): while the agent works in a tab of a group, the group's glyph is "◉" instead of "⧉" and
 * the rest of the title (name, invisible marker) stays exactly as it is. In Lite the constants are never used and are dropped.
 */
export const GROUP_ACTIVE_PREFIX = __FULL__ ? "◉ " : "";

/** `active`: the agent-activity form (Full only; Lite always gets the plain glyph). */
export function groupTitle(
  name: string,
  containerId: ContainerId,
  active = false,
): string {
  return (
    (__FULL__ && active ? GROUP_ACTIVE_PREFIX : GROUP_PREFIX) +
    name +
    groupMarker(containerId)
  );
}

/** The glyph at the front of a title, with its space: "⧉" always, "◉" too in Full. */
const LEADING_GLYPH_RE = __FULL__ ? /^\s*[⧉◉] ?/ : /^\s*⧉ ?/;

/** The title with its leading glyph set to the plain one (`active` false) or the activity one; name and marker untouched. */
export function groupTitleWithGlyph(title: string, active: boolean): string {
  const rest = title.replace(__FULL__ ? /^[⧉◉] ?/ : /^⧉ ?/, "");
  return (active ? GROUP_ACTIVE_PREFIX : GROUP_PREFIX) + rest;
}

/** Whether the title carries the activity glyph (Full only). */
export function hasActiveGlyph(title: string | undefined): boolean {
  return __FULL__ && (title ?? "").startsWith(GROUP_ACTIVE_PREFIX);
}

/**
 * The container name a (possibly edited) group title says: the invisible marker and stray invisible characters taken off,
 * one leading "⧉" (or "◉", the activity mark) with its space taken off, whitespace collapsed. Not validated (see `checkContainerName`).
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
