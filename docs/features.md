# Features

The short version is in the [README](../README.md). This page has the detail.

<p>
  <img src="screenshots/popup-lite-light.png" alt="The SplitSession popup in light theme: the current tab's container and the list of containers" width="280">
  <img src="screenshots/popup-lite-dark.png" alt="The same popup in dark theme" width="280">
</p>

<p>
  <img src="screenshots/options-light.png" alt="The SplitSession settings page: tab groups, restore, strict mode, domain rules" width="560">
</p>

## Why containers

Chrome profiles isolate everything, but each one is a separate window with its own extensions, bookmarks and history. Switching profiles to answer a client's account, then back, gets old quickly, and an AI agent that drives "your browser" can see only one of them.

Containers isolate only what identifies you to a site (cookies and page storage) and leave the rest of the profile shared. You pick the account per tab, not per window.

## What you get

- **Containers**: a name, a colour (8 to choose from) and a cookie jar. Create, rename, recolour, delete.
- **Isolation of cookies and storage**: per-tab cookie jars for all network requests of the tab (frames, `fetch`, XHR, WebSocket handshakes), and per-container `document.cookie`, `localStorage`, `sessionStorage`, IndexedDB, Cache Storage and `BroadcastChannel`. Popups and links opened from a container tab stay in it.
- **Tab groups**: containers show up as Chrome tab groups titled `⧉ name` in the container's colour (optional). Renaming or recolouring such a group renames or recolours the container, and a tab dragged into a group is reopened in that container, so the group never lies about where a tab is. A container tab that is outside its group (dragged out, or tab groups off) gets `⧉ ` in front of its title, so it does not pass for an ordinary tab (optional; no container name in it, but sites can read titles).
- **Split view**: put two accounts of one site side by side in Chrome's split view. A split view of two containers (or a container tab and an ordinary one) leaves the container groups instead of being reopened, so each tab keeps its login; a split view of one container stays in its group.
- **Restore after restart**: with "Continue where you left off", Reopen closed tab, History or a reopened tab group, container tabs come back in their containers. Tabs SplitSession cannot match with certainty wait for you in the popup.
- **Domain rules**: per site, "always open in container X" or "ask me" (like Firefox's "Always open in").
- **Strict mode** (off by default): removes every service worker of the profile and refuses new ones, so none can answer a container tab with your regular logins. The price is push notifications on every site.
- **Export and import** of containers and rules as JSON. Cookies are left out unless you tick a clearly marked box.
- **Links and bookmarks**: `open.html?container=…&url=…` and a `#ctr=name` marker open a page in a container.
- Light and dark themes; every control is custom and keyboard accessible.

## Lite and Full

One codebase, two builds. **Lite** is containers only and is the edition for the Chrome Web Store (listed as *SplitSession: Multiple Logins per Site*). **Full** adds a local AI agent bridge.

| | **Lite** | **Full** |
| --- | --- | --- |
| Containers, isolation, strict mode, domain rules, tab groups, restore, export / import, `open.html` and `#ctr=` | yes | yes |
| Agent bridge (native messaging, MCP server, Chrome DevTools Protocol), off by default | not in the bundle | yes |
| Agent activity display (glow, label, tab-title mark, "AI" badge) | not in the bundle | yes |
| "Show the container name to pages" (`data-ctr`, `[name]` title prefix), off by default | not in the bundle | yes |
| Extra permissions | none | `nativeMessaging`, `debugger` |
| Extension ID | assigned by the Web Store (a local build gets a path-derived one) | fixed: `hapfikidacgfgnnajkgnaednpgnhmffk` |
| Build output | `.output/lite/chrome-mv3` | `.output/chrome-mv3` |

Lite is not a Full build with the settings hidden: the agent code is not compiled into it, and `scripts/check-lite.mjs` fails the Lite build if any bridge, CDP or native-messaging marker, or any of the three Full-only permissions, ends up in the bundle. The two editions have different IDs and can be installed side by side, but do not run both on the same sites at once: each would isolate its own tabs.

## Privacy and storage

SplitSession requests access to all sites, because rewriting request headers per tab needs it. It sends nothing anywhere ([privacy policy](privacy.md)). Containers and cookie jars live in `chrome.storage.local` on your machine, unencrypted (as do Chrome's own cookies); full-disk encryption is what protects both.

## Project status

Beta, version 0.1. It is not in the Chrome Web Store yet; the Lite edition is being prepared for it. The interface and the isolation engine are stable enough for daily use by the author, and the open items are real-site verification and the limits in [limits.md](limits.md).
