/** Container-name rules shared by every form (popup, options, choose page) and by import validation. */

/** What the UI accepts. The store itself tolerates up to 64 so names created over the API still round-trip. */
export const MAX_CONTAINER_NAME = 32;
export const MAX_STORED_NAME = 64;

/** Collapses whitespace the way the store does, so duplicates are detected on the same form the store compares. */
export const collapseName = (raw: string): string => raw.replace(/\s+/g, ' ').trim();

/**
 * Makes a raw value from an input safe to keep while the user types: control characters (including line breaks) and
 * zero-width characters are dropped, the length is capped. Leading spaces are dropped; trailing ones stay so the user
 * can type "Work account".
 */
export function sanitizeNameInput(raw: string, max: number = MAX_CONTAINER_NAME): string {
  const kept = Array.from(raw)
    .filter((ch) => !isStrippable(ch.codePointAt(0)!))
    .join('')
    .replace(/^\s+/, '');
  return Array.from(kept).slice(0, max).join('');
}

/** Control characters, zero-width characters, line/paragraph separators, bidi overrides, byte-order mark. */
function isStrippable(cp: number): boolean {
  return (
    cp <= 0x1f ||
    (cp >= 0x7f && cp <= 0x9f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x2028 && cp <= 0x202e) ||
    cp === 0x2060 ||
    cp === 0xfeff
  );
}

export type NameCheck = { ok: true; name: string } | { ok: false; message: string };

/**
 * Validates a container name as the user types.
 * @param existing names already taken (all containers)
 * @param own the container's current name when renaming, so keeping it is not a duplicate
 */
export function checkContainerName(raw: string, existing: readonly string[], own?: string): NameCheck {
  const name = collapseName(raw);
  if (name === '') return { ok: false, message: 'Give the container a name.' };
  if (Array.from(name).length > MAX_CONTAINER_NAME) return { ok: false, message: `Use at most ${MAX_CONTAINER_NAME} characters.` };
  const lower = name.toLowerCase();
  const ownLower = own === undefined ? undefined : collapseName(own).toLowerCase();
  if (existing.some((n) => collapseName(n).toLowerCase() === lower && lower !== ownLower)) {
    return { ok: false, message: `A container named “${name}” already exists.` };
  }
  return { ok: true, name };
}
