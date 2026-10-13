import {
  bytesToHex,
  type ContainerId,
  createPageKeyCache,
  hexToBytes,
  PAGE_KEY_SECRET_BYTES,
} from "../../core";

/** `storage.local` key of the per-install secret behind page keys (hex). */
export const PAGE_KEY_SECRET_KEY = "pageKeySecret";

export type PageKeyOf = (containerId: ContainerId, site: string) => string;

/** Page keys from the stored per-install secret (`stored`: its value as read); a new secret is made and saved when none is valid. */
export async function loadPageKeys(
  local: { set(items: Record<string, unknown>): Promise<void> },
  stored: unknown,
): Promise<PageKeyOf> {
  let secret = typeof stored === "string" ? hexToBytes(stored) : null;
  if (!secret || secret.length !== PAGE_KEY_SECRET_BYTES) {
    secret = crypto.getRandomValues(new Uint8Array(PAGE_KEY_SECRET_BYTES));
    await local.set({ [PAGE_KEY_SECRET_KEY]: bytesToHex(secret) });
  }
  return createPageKeyCache(secret);
}
