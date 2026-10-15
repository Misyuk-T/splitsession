---
title: SplitSession privacy policy
permalink: /privacy
layout: page
---

# SplitSession privacy policy

Effective date: 2026-10-14

SplitSession is a free, open-source Chrome extension by Taras Misiuk that lets you keep several accounts of the same
website signed in side by side ("containers"). This policy covers both editions: **Lite** (containers only) and **Full**
(containers plus an optional local AI agent bridge). The Chrome Web Store has the Lite edition, which contains none of the
Full edition's features or extra permissions. The source code is public: <https://github.com/Misyuk-T/splitsession>.

## In short

- Everything SplitSession handles stays **on your computer**. The extension sends nothing to the developer or to any other
  server. There is no account, no analytics, no crash reporting and no telemetry.
- The extension makes no network requests of its own. (The pages you browse make theirs, as usual.)
- Full only: if **you switch on** the agent bridge, an AI agent on your own computer can read and operate your tabs. It is
  off by default. See "The Full edition's agent bridge" below.

## What data SplitSession handles

All of it stays on your device: in the extension's own storage (`chrome.storage`) or, for page storage, in the site's own
storage in your browser (see the table). SplitSession does not encrypt it; full-disk encryption is what protects it, as it
protects Chrome's own cookies. It is not synced and not backed up by the developer.

| Data | Why | Where |
| --- | --- | --- |
| **Containers**: names, colours, and a cookie jar per container (the cookies that sites set in that container's tabs) | to keep each container signed in to its own account | `chrome.storage.local` |
| **Page storage of container tabs**: `localStorage`, `sessionStorage`, IndexedDB, Cache Storage and `BroadcastChannel` data, which SplitSession keeps apart per container | to separate the accounts | in the site's own storage in your browser, under per-container prefixed names |
| **Tab addresses and titles** of tabs in containers (and of recently closed ones) | to apply your site rules and to put container tabs back in their container after a restart or "Reopen closed tab" | `chrome.storage.local` and `chrome.storage.session` |
| **Settings and site rules** ("always open this site in container X") | to behave the way you set it up | `chrome.storage.local` |
| **A short local log** of what the extension did (for example "tab moved to container X because of a rule") | to help you see why something happened, on the Diagnostics part of the options page | on your device |

SplitSession does not access Chrome's browsing history, bookmarks, saved passwords, form data or the contents of pages
(Lite never does; Full reads pages only for the agent bridge, below). It does read the address of a tab when the tab
navigates, only to check your site rules, and it keeps the addresses and titles of container tabs (including recently
closed ones) on your device, as listed above. Cookies are handled only to keep containers apart: a container's
cookies are sent only to the site that set them, from tabs of that container, exactly as Chrome would send them.

## What leaves your device

Nothing leaves your device by SplitSession's own action. The developer runs no server and receives no data.

- **Export** creates a JSON file only when you click Export, and saves it where you choose. Cookies are included only if you
  tick the clearly marked box, and then the file contains live logins: keep it as safe as a password.
- **Import** reads only a file you pick.
- The extension does not load or run remote code.

## The Full edition's agent bridge

The Full edition has an optional bridge for an AI agent that you run yourself on the same computer (for example Claude Code
or Codex). It is **off by default** and is one all-or-nothing switch in the extension's Settings.

- **While it is off**: the extension holds no connection, no helper process runs and no socket exists. Nothing is reachable.
- **While you have it on**: any program running as your user that can reach the bridge's private local socket, normally the
  agent you installed, can list your tabs and their containers and can read and operate them: page text and HTML, the
  accessibility snapshot, screenshots, console and network lists (cookie and authorization header values are always
  hidden), clicks, typing, file uploads and running scripts, in every tab of every window, signed-in pages included. It can
  act as you on those sites. Chrome shows its own "started debugging this browser" bar while the debugger is in use, and
  the extension shows that the agent is working (a glow on the page, a badge on the toolbar button).
- **Where that data goes**: it travels from the extension to a helper program on your computer through Chrome's native
  messaging, and from there over a local Unix socket (never a network port) to your agent. SplitSession itself sends it
  nowhere else. What your agent then does with it, including sending it to an AI provider you chose, is governed by that
  agent's and provider's own terms and settings, not by SplitSession. Switch the bridge off, or do not install the helper
  program, if you do not want that.
- **The bridge's action log** keeps, for each tool call: the tool name, the tab ID, the site (host), whether it worked and
  when. It does **not** keep page content, typed text or the agent's answers.
- The bridge never reads or sets cookies or storage and does not bypass container isolation.

The helper program is the separate `splitsession-bridge` package (<https://www.npmjs.com/package/splitsession-bridge>). It
stores nothing except a small start/stop log next to its socket (`host.log`; no requests and no page content).

The Lite edition has none of this: it does not contain the bridge code, and its package is checked for that at build time.

## Permissions, and why

| Permission | Used for |
| --- | --- |
| Access to all sites (`<all_urls>`) | rewriting the `Cookie` request header and `Set-Cookie` response header of container tabs for whatever site you open in a container, and running the script that keeps page storage apart. SplitSession cannot know in advance which sites you will use. |
| `declarativeNetRequest`, `webRequest` | replacing a container tab's cookies on its requests and capturing the cookies the site sets into that container's jar |
| `scripting` | registering and running the script that namespaces `document.cookie`, `localStorage` and the like per container (Full also uses it to read pages for the agent) |
| `tabs`, `tabGroups`, `webNavigation`, `sessions` | knowing which tab belongs to which container, showing containers as tab groups, and putting tabs back after a restart or "Reopen closed tab" |
| `storage` | keeping your containers, jars, rules and settings on your device |
| `browsingData` | removing service workers (which could answer a container tab with another account's data); it removes service workers only |
| `alarms` | housekeeping timers in the extension's background worker |
| `nativeMessaging` (Full only) | talking to the local helper program of the agent bridge |
| `debugger` (Full only) | trusted clicks and typing, file uploads, screenshots and the console and network lists for your agent, only while the bridge is on and a tool needs it |

## Keeping and deleting your data

- Data stays until you remove it. Deleting a container deletes its cookie jar, its rules and closes its tabs. Site rules
  and settings can be changed or removed on the options page.
- **Uninstalling** the extension removes everything it keeps in `chrome.storage` (containers, cookie jars, rules, settings,
  tab records). The per-container page-storage entries that SplitSession wrote into sites' own storage are ordinary site
  data: clear them with Chrome's "Delete browsing data" (cookies and other site data) for the sites you used.
- Full: to remove the helper program, run `npx splitsession-bridge uninstall` and remove the MCP server entry from your AI
  client.
- You can **export** your containers and rules at any time, and **import** them again.

## Limited Use

SplitSession's use of information received from Chrome APIs follows the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), including the
Limited Use requirements. The data described above is used only to provide the extension's single purpose (keeping
several accounts of one website signed in side by side). It is not sold or transferred to third parties, not used or
transferred for purposes unrelated to that purpose, not used for advertising, and not used to determine creditworthiness
or for lending. No human reads it, because it never reaches the developer.

## Children

SplitSession is not directed at children, and it does not knowingly collect any personal information from anyone.

## Changes to this policy

The policy is versioned in the project's repository (`docs/privacy.md`), where every change is visible in the history.
Material changes will be mentioned in the release notes, and the effective date above will change.

## Contact

Questions or concerns: open an issue at <https://github.com/Misyuk-T/splitsession/issues>.
