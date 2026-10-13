import { gateKey } from "./gate";

/** The extension page a waiting tab shows instead of Chrome's "blocked" page: `<base>?u=<address>`. No network request. */
export function heldPageUrl(base: string, address: string): string {
  return `${base}?u=${encodeURIComponent(address)}`;
}

/** The address a held page stands for, or null when `url` is not one (`base` is the page without its query). */
export function heldPageTarget(
  url: string | undefined,
  base: string,
): string | null {
  if (!url || !url.startsWith(`${base}?`)) return null;
  const u = new URLSearchParams(url.slice(base.length + 1).split("#")[0]).get(
    "u",
  );
  return u && gateKey(u) !== null ? u : null;
}
