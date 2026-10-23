import { PROFILE_KEY_LENGTH, PROFILE_KEY_RE } from "../../bridge/protocol";
import type { StorageAreaLike } from "../../engine/storage/storage-area";

/**
 * `chrome.storage.local` key of this Chrome profile's bridge key: a random ID made once, the name of the profile's socket
 * (`bridges/<key>.sock`) and how the agent addresses the profile when it has no name. Not the user's label: that one can
 * change, and two profiles may share it.
 */
export const PROFILE_KEY_KEY = "bridgeProfileKey";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** `PROFILE_KEY_LENGTH` characters a-z0-9 (about 52 bits), from the platform's CSPRNG. */
export function newProfileKey(
  random: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array = (b) =>
    crypto.getRandomValues(b),
): string {
  // 252 is the largest multiple of 36 below 256: values above it are skipped so every character is equally likely.
  let key = "";
  while (key.length < PROFILE_KEY_LENGTH) {
    for (const byte of random(new Uint8Array(PROFILE_KEY_LENGTH * 2))) {
      if (byte >= 252) continue;
      key += ALPHABET[byte % 36];
      if (key.length === PROFILE_KEY_LENGTH) break;
    }
  }
  return key;
}

/** The stored key; a new one is made and stored when there is none (or it is malformed). */
export async function readProfileKey(area: StorageAreaLike): Promise<string> {
  try {
    const stored = (await area.get(PROFILE_KEY_KEY))[PROFILE_KEY_KEY];
    if (typeof stored === "string" && PROFILE_KEY_RE.test(stored))
      return stored;
  } catch {
    /* unreadable: make one */
  }
  return renewProfileKey(area);
}

/** A fresh key, stored (two profiles carrying the same key: a copied profile directory). */
export async function renewProfileKey(area: StorageAreaLike): Promise<string> {
  const key = newProfileKey();
  try {
    await area.set({ [PROFILE_KEY_KEY]: key });
  } catch {
    /* kept in memory for this worker's life */
  }
  return key;
}
