/**
 * Pages the agent bridge may not operate in either mode: scripts cannot run in them, and the debugger (full mode) is refused
 * too. Kept apart from cdp.ts so the store bundle, which has no CDP code, still has it.
 */

/** Why SplitSession will not attach to this address, or null when it may. */
export function refusedUrl(url: string | undefined): string | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol === "chrome-extension:")
    return "extension pages (SplitSession's own included) are not operated by the agent";
  if (
    /^(chrome|chrome-untrusted|chrome-search|devtools|view-source|edge|brave|opera|vivaldi):$/.test(
      u.protocol,
    )
  )
    return `${u.protocol}// pages belong to the browser; Chrome does not let extensions debug them`;
  if (
    u.hostname === "chromewebstore.google.com" ||
    (u.hostname === "chrome.google.com" && u.pathname.startsWith("/webstore"))
  )
    return "Chrome does not let extensions debug the Chrome Web Store";
  return null;
}
