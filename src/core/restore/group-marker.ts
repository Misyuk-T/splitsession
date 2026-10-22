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
 * Full only (the agent activity mark): while the agent works in a tab of a group, the group's glyph alternates between "◉" and
 * "○" (a pulse) instead of "⧉", and the rest of the title (name, invisible marker) stays exactly as it is. In Lite the
 * constants are empty and dropped, so the Lite bundle has neither glyph.
 */
export const GROUP_ACTIVE_PREFIX = __FULL__ ? "◉ " : "";
export const GROUP_HOLLOW_PREFIX = __FULL__ ? "○ " : "";

/** The glyph a group title leads with: `false` idle "⧉"; `true` the activity "◉"; `"hollow"` the other half of the pulse "○". */
export type GroupGlyph = boolean | "hollow";

const prefixOf = (glyph: GroupGlyph): string =>
  !__FULL__ || glyph === false
    ? GROUP_PREFIX
    : glyph === "hollow"
      ? GROUP_HOLLOW_PREFIX
      : GROUP_ACTIVE_PREFIX;

/** `active`: the agent-activity form (Full only; Lite always gets the plain glyph). */
export function groupTitle(
  name: string,
  containerId: ContainerId,
  active: GroupGlyph = false,
): string {
  return prefixOf(active) + name + groupMarker(containerId);
}

/** The glyph at the front of a title, with its space: "⧉" always, "◉" and "○" too in Full. */
const LEADING_GLYPH_RE = __FULL__ ? /^\s*(?:[⧉◉○] ?)?/ : /^\s*(?:⧉ ?)?/;

/** The title with its leading glyph set to the idle one (`false`) or an activity one; name and marker untouched. */
export function groupTitleWithGlyph(title: string, glyph: GroupGlyph): string {
  // The same prefix groupNameOf takes off (leading whitespace, one glyph, its space): a title the user typed as " ◉ Job" or
  // "◉Job" gets the glyph swapped, not a second glyph in front of it.
  return prefixOf(glyph) + title.replace(LEADING_GLYPH_RE, "");
}

/** Whether the title carries an activity glyph, "◉" or "○" (Full only). */
export function hasActiveGlyph(title: string | undefined): boolean {
  return __FULL__ && /^\s*[◉○]/.test(title ?? "");
}

/** A container name never starts with a group glyph: it would be taken for the glyph the next time the title is read. */
export function startsWithGroupGlyph(name: string): boolean {
  return (__FULL__ ? /^\s*[⧉◉○]/ : /^\s*⧉/).test(name);
}

/**
 * The container name a (possibly edited) group title says: the invisible marker and stray invisible characters taken off,
 * one leading "⧉" (or "◉" / "○", the activity mark) with its space taken off, whitespace collapsed. Not validated (see `checkContainerName`).
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
