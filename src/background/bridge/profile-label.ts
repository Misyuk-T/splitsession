import type { StorageAreaLike } from '../../engine/storage/storage-area';

/** `chrome.storage.local` key of the profile label (a name the user gives this Chrome profile; empty: none). */
export const PROFILE_LABEL_KEY = 'bridgeProfileLabel';
export const PROFILE_LABEL_MAX = 40;

/** Single line, no control characters, at most PROFILE_LABEL_MAX characters. */
export function cleanProfileLabel(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return Array.from(raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()).slice(0, PROFILE_LABEL_MAX).join('').trim();
}

export async function readProfileLabel(area: StorageAreaLike): Promise<string> {
  try {
    return cleanProfileLabel((await area.get(PROFILE_LABEL_KEY))[PROFILE_LABEL_KEY]);
  } catch {
    return '';
  }
}

export async function writeProfileLabel(area: StorageAreaLike, raw: unknown): Promise<string> {
  const label = cleanProfileLabel(raw);
  if (label === '') await area.remove(PROFILE_LABEL_KEY);
  else await area.set({ [PROFILE_LABEL_KEY]: label });
  return label;
}
