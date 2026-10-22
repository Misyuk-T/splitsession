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

export function groupTitle(name: string, containerId: ContainerId): string {
  return GROUP_PREFIX + name + groupMarker(containerId);
}

/**
 * Glyphs that 0.1.5-dev builds wrote in front of a group's title while the agent worked ("◉", "◎", "○"; the mark is now the
 * group's colour and the title is never touched). They are still recognised, for one release, so that a group left marked by
 * such a build is cleaned up and its glyph never becomes part of a container name. Full only; Lite never had them. Remove
 * after the release that follows 0.1.5.
 */
const LEADING_GLYPH_RE = __FULL__ ? /^\s*(?:[⧉◉◎○] ?)?/ : /^\s*(?:⧉ ?)?/;

/** The title with its leading glyph (and the whitespace before it) replaced by the idle "⧉ "; name and marker untouched. */
export function groupTitleIdle(title: string): string {
  return GROUP_PREFIX + title.replace(LEADING_GLYPH_RE, "");
}

/** Whether the title still carries an agent-mark glyph of a 0.1.5-dev build, "◉" "◎" or "○" (Full only). */
export function hasLegacyMarkGlyph(title: string | undefined): boolean {
  return __FULL__ && /^\s*[◉◎○]/.test(title ?? "");
}

/** A container name never starts with a group glyph: it would be taken for the glyph the next time the title is read. */
export function startsWithGroupGlyph(name: string): boolean {
  return (__FULL__ ? /^\s*[⧉◉◎○]/ : /^\s*⧉/).test(name);
}

/**
 * The container name a (possibly edited) group title says: the invisible marker and stray invisible characters taken off,
 * one leading "⧉" (or a leftover "◉" / "◎" / "○") with its space taken off, whitespace collapsed. Not validated (see `checkContainerName`).
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
