import { browser } from "wxt/browser";

import { callApi } from "../../engine/api-client";

/**
 * `open.html?container=<id|name>&url=<encoded http(s) URL>`: deterministic entry for agents, popups and hotkeys.
 * Ensures the container (creating it by name if needed), puts THIS tab into it, waits until its rules are active,
 * then replaces itself with the target URL, so the very first request to the site is already isolated.
 */
async function run(): Promise<void> {
  const status = document.getElementById("status")!;
  const detail = document.getElementById("detail")!;
  const params = new URLSearchParams(location.search);
  const ref = params.get("container")?.trim() ?? "";
  const target = params.get("url") ?? "";
  const fail = (message: string) => {
    status.textContent = message;
    status.className = "error";
    document.title = "SplitSession: cannot open";
  };
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return fail('Missing or invalid "url" parameter.');
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return fail("Only http and https addresses can be opened in a container.");
  if (!ref)
    return fail('Missing "container" parameter (container name or ID).');
  detail.textContent = url.href;

  const tab = await browser.tabs.getCurrent();
  if (tab?.id === undefined) return fail("This page must be opened in a tab.");
  try {
    const container = await callApi("ensureContainer", ref);
    status.textContent = `Opening in container “${container.name}”…`;
    await callApi("assignTab", tab.id, container.id);
    // No service worker of the target's origin may answer the first request (it would go out as the real profile).
    await callApi("prepareNavigation", url.href);
  } catch (error) {
    return fail(
      `Could not open in container: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  location.replace(url.href);
}

void run();
