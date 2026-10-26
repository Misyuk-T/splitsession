# Using SplitSession with AI agents (Claude in Chrome, Playwright)

SplitSession makes "open this page as that account" a single navigation, and makes "which account is this tab?" readable from
the tab list. Sections 1-6 work from a plain browser tool: navigate, read page text, evaluate a little JavaScript. No
SplitSession-specific tool is needed. Section 7 is the opt-in **agent bridge** for an agent that should drive your own Chrome.

This page is about the **Full** edition (README, "Two editions"). The Lite edition has no bridge and no
"Show the container name to pages" setting; only sections 1 and 2 (`open.html`, `#ctr=`) apply to it, and its extension ID is not
the one below.

The Full extension ID is fixed by the manifest key, so these addresses are the same on every machine:

```
EXT = chrome-extension://hapfikidacgfgnnajkgnaednpgnhmffk
```

With the bridge on, `bridge_info` prints the ID SplitSession is running with.

## 1. Open a page in a container: `open.html`

```
EXT/open.html?container=<name or id>&url=<URL-encoded http(s) address>
```

Navigate a tab (an existing one, or a new one) to that address. SplitSession puts **that tab** into the container, waits until
its isolation rules are active, then replaces the page with `url`. The first request to the site is already made as the
container.

- `container` is a container name (case-insensitive) or its ID. **An unknown name creates the container**, which is how
  an agent sets up "account B" on its own: `open.html?container=account-b&url=…`.
- `url` must be http or https, and URL-encoded (`encodeURIComponent`).
- The page cannot be opened from a web page, only by the browser (omnibox, `tabs.update`, DevTools protocol, an agent
  tool). That is deliberate: a website must not be able to create containers.
- A tab that was put in a container this way stays there: a **domain rule** for the site does not move it (a deliberate
  placement wins), until the tab visits another site.

Examples:

```
EXT/open.html?container=Work&url=https%3A%2F%2Fgithub.com%2Fnotifications
EXT/open.html?container=Personal&url=https%3A%2F%2Fwww.reddit.com%2F
```

## 2. The `#ctr=` marker

```
https://example.com/page#ctr=Work
```

Put the marker in any address and navigate there. SplitSession moves the tab into the **existing** container `Work` (name or
ID), strips the marker and navigates again. Other fragment parameters survive (`#a=1&ctr=Work` -> `#a=1`).

Use it when you cannot navigate to an extension address. Differences from `open.html`:

- the container must already exist (unknown names are ignored: any web page could carry a marker, and pages must not
  create containers);
- it works only for a tab that is **not in a container yet**, and only when the browser or an extension starts the
  navigation: the address bar, a bookmark, `tabs.update`, the DevTools protocol, an agent's `navigate` tool. A page
  cannot use it, neither by changing `location.hash` nor by navigating itself or a popup to a marked address (SplitSession
  checks the navigation's initiator);
- the marked address is requested **once before SplitSession sees it**, as the real profile (a known hole, see
  [limits.md](limits.md)); prefer `open.html` for anything with a login.

## 3. Read the situation: the bridge tools

With the agent bridge on (section 7), ask SplitSession instead of reading a page: `list_containers` returns every container
(id, name, colour, tab count), `list_tabs` returns every tab with its container and Chrome profile, and `bridge_info` returns the connected
profiles (key, name, size, extension version). Without the bridge, a tab's container is visible to the person as the toolbar badge and the tab group;
to a page it is visible only through the opt-in signals in section 4.

## 4. Telling accounts apart in a tab

Three signals. **The first two need the setting "Show container name to pages", which is off by
default**: switch it on in Settings, "For AI agents" before an agent relies on them. The badge is always
there.

| Signal | Where | Notes |
| --- | --- | --- |
| Title prefix `[name] ` | the tab title, hence `tabs_context` of Claude in Chrome and any `tabs.query` | added by SplitSession to the top frame of container tabs, survives SPAs that rewrite the title; can be switched off in settings |
| `data-ctr="name"` | attribute on the top document's `<html>` (`document.documentElement.dataset.ctr`) | present in container tabs, not affected by the title setting |
| Toolbar badge | a dot in the container's colour (no letters) | for people; not readable from the page |

The first two are readable by the page itself, so they depend on the setting **"Show container name to pages"** (off by default). With it off, pages see no name at all (no prefix, no `data-ctr`; the beacon answer has no
name either): use the badge (or, with the bridge on, `list_tabs`) instead. The trade-off: any script on the page can read the name, and the
same name on two sites lets trackers link the visits. Pages never see the container's ID: the beacon gives them an
opaque key that differs per site.

A plain tab has none of them: no prefix, no `data-ctr`.

Note that **`document.title` as the page sees it includes the prefix** (`[Work] Inbox`). A script that matches a title
exactly has to allow for that; `data-ctr` is the reliable way to read the container.

## 5. Claude in Chrome

Install SplitSession in the Chrome profile Claude in Chrome drives (load unpacked, see the README). Then:

1. Open a new tab and navigate it to `EXT/open.html?container=<name>&url=<address>` (the `navigate` tool takes it like
   any URL).
2. Use `tabs_context` to see your tabs: container tabs carry the `[name] ` prefix.
3. To act as the other account, open **another tab** with another container name. Do not reuse a tab for a different
   account; the tab is the account.
4. With the bridge on, `list_tabs` tells you which tabs are in which container.

Claude in Chrome attaches a debugger to the tab it works in. SplitSession's isolation does not use the debugger (it works with
request headers and content scripts). SplitSession's **agent bridge** (section 7) does attach one, but only while the bridge is
on and one of its tools works on a tab; Chrome lets several debugger clients share a tab, so neither refuses the other.
Do not let both agents drive the same tab at the same time: their clicks and keys would interleave.

## 6. Playwright

Branded Chrome ignores `--load-extension`; use Playwright's bundled Chromium with a persistent context. This is exactly
what SplitSession's own end-to-end suite does (`e2e/fixtures.ts`):

```ts
import { chromium } from '@playwright/test';

const ext = '/path/to/facet/.output/chrome-mv3';
const context = await chromium.launchPersistentContext('/tmp/profile', {
  channel: 'chromium',
  headless: true, // works with the new headless mode
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});

const EXT = 'chrome-extension://hapfikidacgfgnnajkgnaednpgnhmffk';
const open = (container: string, url: string) =>
  `${EXT}/open.html?container=${encodeURIComponent(container)}&url=${encodeURIComponent(url)}`;

const alice = await context.newPage();
await alice.goto(open('alice', 'https://example.com/login'));
const bob = await context.newPage();
await bob.goto(open('bob', 'https://example.com/login')); // same site, separate cookies and storage
```

Playwright's own `page.context().cookies()` shows the **real profile's** cookies, not a container's: a container's
cookies are not in Chrome's cookie store. To look at a jar, ask the extension's service worker:
`worker.evaluate(() => facet.getJar('<container id>'))` (the background API is on `globalThis.facet`).

Playwright MCP works the same way when the browser it launches loads the extension with the arguments above; the
`navigate` tool accepts the `open.html` address.

## 7. The agent bridge: your own agent drives your Chrome tabs (opt-in)

Sections 1-6 need nothing but a browser tool. The **agent bridge** is the other way round: a local MCP server that lets
an AI coding agent running on your Mac (Claude Code) **list your Chrome tabs across all windows, see each tab's
container, and operate them like a Playwright-class agent**: accessibility snapshots with element refs, real (trusted)
mouse and keyboard input, file uploads, JavaScript dialogs, screenshots of background tabs, console and network, all
through the Chrome DevTools Protocol (`chrome.debugger`). It exists for the case where the agent should work in the
browser you are already using, with the accounts you are already logged in to.

### What "on" means

One switch, all or nothing, **off by default**. It lives in **Settings, "For AI agents"** (the second section of the options page, after General; the popup's gear opens Settings, and the popup has no agent UI at all until the switch is on).

- **Off**: the extension holds no connection, no host process runs, no socket exists. Nothing is reachable.
- **On**: any program running as your macOS user that can reach the socket (the MCP server Claude Code starts, or
  anything else you run) can do everything below in **every tab of every window**, container tabs and plain tabs,
  including pages you are logged in to. It can act as you on those sites. There are no per-site lists, no read-only mode
  and no confirmations in this version (see "Ideas" below).
- While it is on, the popup gets **one compact row**: a status dot, "Agent", a counter of actions, a chevron that unfolds the
  **last five actions** (time, tool, tab title or site), and a small switch to turn it off. Settings shows **"Agent connected —
  full access"** in amber. If the host is missing or the connection fails, the popup row says only "Agent · not connected" with
  a gear that opens Settings at the agent section; **the popup never shows install commands**. While the switch is off the
  popup has no agent row at all.
- **Turning it off** (the popup row's switch or Settings) closes the connection at once; the host process exits and removes its socket.
  Closing Chrome does the same.

### Set-up (2 steps)

Needs Node.js 20 or newer, on macOS or Linux (Windows is not supported yet). The companion program is the npm package
`splitsession-bridge` (`bridge/` in this repository).

1. `npx splitsession-bridge install`. It copies the program to `~/Library/Application Support/SplitSession/host/` (macOS) or
   `$XDG_CONFIG_HOME/SplitSession/host/` (Linux, default `~/.config`), registers it with Chrome (`com.splitsession.bridge.json` in Chrome's
   `NativeMessagingHosts` folder, `allowed_origins` = the Full extension's ID) and registers the MCP server with your AI client:
   - `--client <list>` (comma separated or repeated): `claude`, `codex`, `cursor`, `claude-desktop` (macOS), `gemini`, `vscode`,
     `all` or `none`. Without it: in a terminal, `install` finds the AI clients on your computer and asks Y/n for each
     ("Register SplitSession with: [x] Claude Code [x] Codex ..."); in a script (no terminal) it is `none`, which registers
     nothing and prints every snippet.
   - Claude Code: `claude mcp add --scope user splitsession -- <node> <host copy> mcp` (an older registration is replaced).
     Codex: `codex mcp add splitsession -- <node> <host copy> mcp` when the `codex` CLI has it, otherwise a line-level edit of
     `~/.codex/config.toml` (a `[mcp_servers.splitsession]` table; your comments and other tables stay as they are).
     Cursor `~/.cursor/mcp.json`, Claude Desktop `~/Library/Application Support/Claude/claude_desktop_config.json`, Gemini CLI
     `~/.gemini/settings.json`: `mcpServers.splitsession = {command, args}`. VS Code (default profile)
     `~/Library/Application Support/Code/User/mcp.json` (Linux: `~/.config/Code/User/mcp.json`): `servers.splitsession` with `type: "stdio"`.
   - Safety: only the `splitsession` entry is added or replaced, other servers (and their secrets) are never printed. A file that
     changes is first copied to `<file>.bak-<timestamp>`, then replaced atomically (temp file + rename). A file that is not
     plain JSON (VS Code's `mcp.json` often has comments) or has an unexpected shape is left untouched and the snippet is
     printed for you to paste. Re-running `install` changes nothing when the entry is already right.

   Other options: `--browser chrome|chromium|brave|edge|arc|all` (default `chrome`; Arc is macOS only, its folder is
   Chromium's usual one and has not been verified here), `--extension-id <id>` (default the Full extension; for another build,
   e.g. a future Store ID). `install` is idempotent: run it again after changing Node versions (the launcher pins the Node that
   installed it) or to update. `npx splitsession-bridge status` reports the manifests, the copied program and whether a host
   is running (read-only).
2. Open **Settings, "For AI agents"** (the second section of the options page, after General) and flip **Agent bridge**. Chrome starts the host when you do; no restart needed. The same section has a **"How to connect"** disclosure with step 1 (a copy block, live status, "Check again").

Remove it with `npx splitsession-bridge uninstall`: it takes down the host and the `splitsession` entry (only that key, with a
backup) from every AI client above (`--client <list>` limits it). `npx splitsession-bridge status` lists which clients have it
registered and whether they point at the current host copy.

**From a source checkout** (development): `pnpm bridge:install` builds `bridge/` and runs the same `install`, but defaults to `--client none`
(it prints the snippets and never touches your client's configuration; add `--client claude,codex,...` to register). Its
`uninstall` leaves the AI clients alone too when `--dir` / `--host-dir` is given, unless `--client` is. `pnpm bridge:uninstall`
is the same `uninstall`. The package is published by hand: [release/npm.md](release/npm.md).

**Coming from "Facet" (renamed 2026-10-11).** The native host is now `com.splitsession.bridge` and its data folder
`~/Library/Application Support/SplitSession`. Reload the extension in `chrome://extensions` (its ID is unchanged, so containers
and cookie jars stay), run `npx splitsession-bridge install` (it also deletes the old `com.facet.bridge.json` manifest and the old host copy in
`~/Library/Application Support/Facet/host`), (it registers `splitsession` with Claude Code), and remove the old
registration with `claude mcp remove --scope user facet`. Agent tool names change from `mcp__facet__…` to `mcp__splitsession__…`.

If the host is not installed, the popup row says "not connected" and Settings, "For AI agents", status says so; its "How to connect" disclosure shows `npx splitsession-bridge install` with a Copy button and "Check again". If a
tool call fails, the MCP server says which it is: *"SplitSession agent bridge is off — turn it on in SplitSession Settings → For AI agents"* or
*"host is not installed — run `npx splitsession-bridge install`"*.

### How it is wired, and why it is safe-ish

```
Claude Code --stdio--> splitsession-bridge.mjs mcp --Unix socket--> splitsession-bridge.mjs host --Native Messaging--> SplitSession (service worker)
```

- **Native Messaging** is Chrome's own mechanism for an extension to talk to a local program. The host manifest pins
  `allowed_origins` to this extension's fixed ID (`chrome-extension://hapfikidacgfgnnajkgnaednpgnhmffk/`): no other
  extension and no web page can start the host or talk to it through Chrome. The host also refuses any other origin.
- **No network port.** The MCP server reaches each profile's host through a Unix socket:
  `~/Library/Application Support/SplitSession/bridges/<profile key>.sock` (one per Chrome profile whose switch is on; the
  shared `~/Library/Application Support/SplitSession/bridge.sock` only for an extension or host of 0.1.x). The directories are
  0700, the sockets 0600. A web page cannot connect to them (a localhost TCP port could be tried by any page). Other macOS
  users cannot either; **programs running as you can**, in every profile whose switch is on.
- **Several profiles do not widen the trust model.** Each profile has its own switch, its own host process and its own
  0600 socket; a profile whose switch is off has no socket and cannot be reached. The host still refuses any caller but the
  allowed extension origin, and checks the profile key the extension sends (6-16 letters a-z or digits, so it can only name a
  file inside `bridges/`). The key is not a secret: it only says which socket is which. The MCP server only removes a socket
  file that refuses connections and is older than 5 s, and a host only removes its own socket (same inode).
- The host copy lives in `~/Library/Application Support/SplitSession/host/`, not in your repository: macOS blocks or prompts
  when a program started by Chrome runs from `~/Documents`, and the host must start silently. Re-run
  `npx splitsession-bridge install` after you change the bridge or switch Node versions (the launcher pins the Node that installed it).
- Every tool call is validated twice (MCP server, then the extension), has a deadline (15 s; `snapshot` 25 s,
  `screenshot_tab`/`type`/`run_js` 30 s, `wait_for` 35 s), and is written to SplitSession's log (Advanced, Diagnostics in the options
  page): tool, tab ID, site, ok/error, time. **Never page content or typed text.**
- The extension's permissions for the bridge: `nativeMessaging`, **`debugger`** (Chrome asks you to accept it when you
  reload the extension).

### The debugger ("full hands")

- Chrome shows **"SplitSession started debugging this browser"** (and moves the page content down and up) for as long as an
  extension is attached with `chrome.debugger`. So SplitSession uses the debugger **only for what a plain script cannot do**:
  trusted input (`click`, `hover`, `drag`, `type`, `press_key`), `upload_file`, `run_js`, background `screenshot_tab` (not
  of the tab on show: see below), `handle_dialog`, `watch` / `console_messages` / `network_requests`, `resize_viewport`,
  and `navigate_back` / `navigate_forward` (they need the exact history entry). **Reading and finding never attach**:
  `snapshot`, `get_tab_text`, `get_tab_html`, `wait_for`, `select_option`, `scroll`, `list_tabs` and the other navigation tools
  work through `scripting.executeScript` (the DOM, in an isolated world) and Chrome's tab APIs.
  A click by ref first asks the page where the element is (a script), and the debugger only sends the mouse events.
- When the debugger **is** needed it is attached to the tab (only while the bridge is on) and **kept for 60 s after the
  last tool that used it**, so an agent's burst of actions (act, think, act ...) is one attach, one bar, one shift of the
  page. After a quiet minute it detaches. `watch` and `resize_viewport` keep it attached for longer (30 minutes at most
  each), and so does an **open JavaScript dialog** (10 minutes at most): only SplitSession's session can answer it, so it is not
  let go while the dialog waits, and `handle_dialog` works however long the agent paused. Switching the bridge off,
  the tab closing and the agent's MCP process going away (10 s grace, then viewport overrides are cleared) detach at once
  rather than after the minute.
- A **screenshot of the tab that is on show** (the active tab of a window that is not minimised) uses Chrome's
  `captureVisibleTab`: no debugger, no tab switch (`"path": "visible"`). Background tabs, full-page shots, tabs with a
  viewport override or an open dialog, and windows Chrome will not capture use the debugger as before.
- SplitSession never attaches to `chrome://` pages, other browser pages, the Chrome Web Store, or **any extension page,
  including its own** (the agent does not get to flip SplitSession's switches).
- Inputs are real Chrome input events (`isTrusted: true`). Pages see a focused tab while SplitSession is attached
  (`Emulation.setFocusEmulationEnabled`), so typing works in background tabs.
- Only safe protocol domains are enabled: Page (dialogs, navigations), Network (the request list) and Log (browser
  messages). **Runtime (`console.log` capture) is enabled only while `watch` runs**: some sites look for exactly that to
  spot debuggers.
- **Isolation is not bypassed.** No tool reads or writes cookies or storage, sets headers, intercepts or rewrites
  requests, or navigates with the protocol: `navigate`, `navigate_back`/`forward`, `reload` and `open_in_container` go
  through SplitSession's own paths (service-worker removal, rules before the first request). Agent code runs only in the page's
  MAIN world, where SplitSession's cookie shim answers `document.cookie` with the container's jar. Request lists never show
  `Cookie`, `Set-Cookie` or `Authorization` values. The e2e suite checks a container tab with the debugger attached
  through reload, navigate, back and forward: the first request of each carries only the container's cookies.
- **The page's own DOM is read in an isolated world** (an extension's `executeScript`, never the page's world, so the
  cookie shim is not involved and the page's scripts cannot see the walker). The only mark it ever leaves in a page is
  one random attribute on the target `<input type="file">` of an `upload_file`, for the few milliseconds the debugger needs
  to take hold of it; refs live in a registry inside that isolated world (weak references, no attribute, id or class is added).

### Several Chrome profiles

Each Chrome profile has its own switch, and **any number of profiles can have it on at the same time**. One MCP server (one
entry in your AI client) sees all of them.

- **How.** Chrome starts one host per profile. The extension keeps a random **profile key** (10 letters and digits, made once,
  in that profile's `chrome.storage.local`) and opens every connection with `hello` and that key; the host then listens on
  `bridges/<key>.sock`. The key is not the profile's name: the name can change and two profiles may share one. Switching a
  profile off removes its socket; a socket left by a killed host is removed by the next host of that profile or by the MCP
  server (a socket that refuses connections and is older than 5 s).
- **What the agent sees.** `bridge_info` lists the connected profiles: `profileKey`, `label` (the name set in Settings, or
  `null`), `windows`, `tabs`, `containers`, `extensionVersion`. With exactly one profile its fields are also at the top level,
  as before. `list_tabs` and `list_containers` put every profile's items together, each with `profile: {key, label}`; they take
  an optional `profile` (a name, case-insensitive, or a key) to ask one profile only.
- **Tools on a tab** (`tabId`) find the tab's profile by themselves, **live on every call**: the MCP server asks each
  connected profile which tab IDs it has (`__tabs`, answered by the extension without counting it) and acts only if exactly
  one has this one; none: "no tab with id …"; several: "exists in several Chrome profiles", and `profile` says which. All
  profiles of one Chrome share one tab numbering (tab IDs are numbered per browser process), so this only happens across
  **separate** Chrome processes (two browsers, or a second `--user-data-dir`). With `profile`, only that profile is asked and
  it must have the tab. One profile connected: the same check.
- **Stale tab IDs are refused, never redirected.** The MCP server remembers where the agent saw each tab ID (the profile and
  the host process that served it: every host has a random session ID on its answers). If the only profile that has the ID now
  is not where the agent saw it (that profile went away and another one has the number, or the same profile's bridge restarted
  and Chrome may have numbered tabs again), the tool does nothing and says "stale tab id …: call list_tabs again". A full
  `list_tabs` replaces what the agent saw (for every profile, or for the one in `profile`); a tab the agent opens is seen where
  it opened it. An ID the agent has seen in two profiles needs `profile` until a complete `list_tabs` (every connected
  profile, unfiltered) shows it in one profile only, even if one of the two profiles has gone meanwhile. IDs the agent never saw (none listed in this MCP session) are only checked for a single owner.
- **Tools that open a tab** (`open_tab`, `open_in_container`) need `profile` when several profiles are connected (or a `windowId`,
  which belongs to one profile). Without it the tool fails and lists the profiles; SplitSession never guesses which account the
  agent meant. With one profile connected nothing changes: no `profile` needed anywhere.
- **Names.** Give each profile a name under **Settings, "For AI agents" > Advanced > Profile name**. The switch's status says
  "Connected as “Work”"; when two or more profiles are on and this one has no name, the card says so and its **Name this
  profile** button opens the field.
- **Bookkeeping is not an agent action.** To label and route, the MCP server asks each extension `__profile` (key and name) and
  `__tabs` (tab and window IDs): the extension answers those itself, so they are not counted, listed in the popup or logged.
- **Mixed versions.** A host of 0.1.x (npm `splitsession-bridge@0.1.0`) still works with this extension, one profile at a time on
  the shared socket; the switch card says "One Chrome profile at a time" and shows `npx splitsession-bridge@latest install`.
  An extension of 0.1.x with the new host works too: it sends no `hello`, so after 1.5 s the host takes the shared socket for
  it, and the MCP server shows that profile with the key `legacy`. Only one profile can use the shared socket; a second such
  profile is told "Another Chrome profile holds the agent bridge", as before. After updating the bridge program, restart your
  AI client so it starts the new MCP server.

| Extension | Host + MCP server (installed together) | Result |
| --- | --- | --- |
| 0.1.x | 0.1.x | One profile at a time (shared socket), as before. |
| 0.1.x | 0.2+ | Works; that profile uses the shared socket (`legacy` key), others with a new extension use their own. |
| new | 0.1.x | Works for one profile; the card asks to update the bridge; a second profile waits ("busy"). |
| new | 0.2+ | Every profile at once. |

### Several agents at once: tab leases (bridge 0.3+)

Two AI sessions can use the same Chrome profile at the same time (each client starts its own MCP server; they meet at the
profile's host). Without a guard one session's click or navigation lands between the other's steps, say in the middle of a
publishing queue. So the host gives a tab to **one session at a time**:

- **Who holds a tab.** The session that opened it (`open_tab`, `open_in_container`) or last **changed** it: `navigate`,
  `navigate_back`, `navigate_forward`, `reload`, `click`, `drag`, `type`, `press_key`, `select_option`, `upload_file`,
  `run_js`, `handle_dialog`, `assign_tab`, `resize_viewport`, `activate_tab`, `close_tab`. A tab nobody holds (your own tabs
  too) is free for anyone; the first such action takes it.
- **What is refused.** Another session's action from that list on a held tab fails before it reaches Chrome:
  `tab 7 is in use by another agent session (claude-code-3f9a, last action 12s ago); open your own tab (open_tab /
  open_in_container) or pass takeOver: true if the user asked you to work in it`.
- **What is never refused.** Reading and looking: `snapshot`, `get_tab_text`, `get_tab_html`, `screenshot_tab`,
  `console_messages`, `network_requests`, `wait_for`, `watch`, the list tools, and also `hover` and `scroll`. They neither take
  nor need a lease.
- **`takeOver: true`** on a changing tool takes the tab over (and the previous holder is then refused in turn). The tool
  description tells the agent to use it only when you asked it to work in that very tab.
- **`list_tabs`** adds `inUseBy: "<session>"` to a tab another session holds and `yours: true` to one the caller holds; other
  fields are unchanged.
- **When a lease ends.** The holder's MCP server exits (its connection to the host closes), the tab is closed, the holder does
  nothing on the tab for **120 s**, or the bridge is switched off. Leases are per host (per Chrome profile) and live only in
  memory.
- **Session names.** Each MCP server calls itself `<name>-<4 hex>`: `CLAUDE_SESSION_NAME` from its environment, else the MCP
  client's own name (`claude-code`, `codex`, …), else `agent`. Set `CLAUDE_SESSION_NAME` per session when you want readable names.
- **Mixed versions.** The leases are entirely in the host plus the MCP server, so an extension of 0.1.x / 0.2.x needs no
  update. A host older than 0.3 ignores the new request fields and leases nothing; an MCP server older than 0.3 names no session,
  and the host then neither leases nor refuses anything for it. Update both with `npx splitsession-bridge@latest install` and
  restart the AI clients.

### The agents' window (extension after 0.1.8, off by default)

With the setting on, tabs an agent opens **itself** (`open_tab`, `open_in_container`) go into one separate ordinary window of
the profile, not the window you are working in. **Off by default**: they open as background tabs in the current window.

- **Made on demand.** The first such open creates the window without taking focus (`focused: false`, `state: "normal"`); the
  blank tab a new window starts with is closed once the agent's own tab is in it. The next opens reuse the window. If you close
  it, the next open makes a new one. A container's tabs get their tab group in that window as usual.
- **Identified by its ID, not a title.** Chrome has no window-title API, so the window's ID is kept in `chrome.storage.session`
  (gone with the browser session, which is also when the window itself is gone).
- **An explicit `windowId` always wins**, with the setting on or off.
- **Setting.** Settings → For AI agents → "Open agent tabs in a separate window" (default **off**). Off: new tabs open in the
  current window, as before 0.1.9. On: the behaviour described here.
- **Working in a tab you already have open** is unchanged: any tab, including the one you are looking at. The tool descriptions
  tell the agent: *if the user says "this tab" or "the current tab", use the tab with `active: true` in the user's last-focused
  window; tabs you open yourself go to the agents' window (when that setting is on).*
- If Chrome cannot make the window, the tab opens where you are (the same as with the setting off).

### Per-site pacing (bridge 0.4+)

A loop of agent actions can send one site a burst of requests (a script of 80 parallel fetches got both Reddit accounts a 429
on 2026-10-22). The **host** therefore spaces out the actions that make a site's server receive a request, per registrable
domain (eTLD+1; an IP address or `localhost` counts as its own site), across **all agent sessions of the profile**:

- **Paced:** `navigate`, `navigate_back`, `navigate_forward`, `reload`, `open_tab` and `open_in_container` (the site of the `url`;
  `about:`/`chrome:` pages have none), `click`, `select_option`, `upload_file`, and `press_key` with Enter (the site the tab shows
  now). **Not paced:** every reading tool, `hover`, `scroll`, `type`, `run_js` (nobody can tell what a script does to the
  network), `close_tab`, `activate_tab`, `assign_tab`.
- **At least 1500 ms between two such actions on one site**, in the order they arrived (FIFO per site). The host **waits** and
  then forwards; the agent just sees the tool take longer. Other sites and reads do not wait behind it.
- **Cap: 30 s.** An action that would have to wait longer than that is answered `site busy: <site> already has more than 30
  seconds of agent actions queued …` instead of being queued; the agent can work on another site and come back.
- **The tab's current site** is asked of the extension (`__tab_url`, an internal call that returns the address only). An older
  extension does not know it, and the host then does not pace the actions that need it (those that carry a `url` are still paced).
- **`SPLITSESSION_SITE_GAP_MS`** in the host's environment changes the gap (milliseconds; `0` switches pacing off). It exists for
  tests; Chrome starts the host, so the variable must be in Chrome's environment.
- It spaces actions; it does not make a site's rate limits go away, and a `click` on a link that triggers many requests is still
  one action.

### Which session is acting (bridge 0.4+)

The host passes the session's name with each forwarded call (an optional `session` next to `tool` and `args`; an older
extension ignores it, an older host sends none). The extension cleans it again (letters, digits, space, `-_.` only, so it can
never carry markup) and uses it twice:

- the page pill reads **`<session>: reading` / `clicking` / `typing` …** instead of `Agent: …` (cut to 24 characters with an
  ellipsis; plain text in the overlay's closed shadow root). With no name (old host) it still says `Agent: …`;
- every **Diagnostics** "agent action" entry has a `session` field.

### Seeing what the agent touches ("Show agent activity", on by default)

While the agent works with one specific tab (every tool except `list_tabs`, `list_containers` and `bridge_info`), that
tab shows it, without taking focus or switching tabs. An **agent session** on a tab lasts while the debugger is *held* on
it (a `watch`, a `resize_viewport` pin, an open JavaScript dialog) **or** a tool touched the tab within the last ~8 s (the
quiet minute the debugger stays attached after a burst does not keep it). It survives in-page navigations and full page
loads (the new document gets the glow again at commit) and ends with a ~600 ms fade. **Everything is purple** (`#8b5cf6`:
"the agent is here"), whatever the tab's container; the container's colour stays on the container's own UI (tab groups, the
toolbar badge's colour dot).

- **In the page, the whole session**: a soft **vignette along the edges of the viewport**, made of gradients only (about
  26 px from each edge fading to transparent, low opacity; there is no border, outline or shadow, so no line anywhere),
  slowly breathing (35 % to 100 % on an eased sine, 2.8 s a cycle). **On each action** a stronger, slightly wider layer
  (34 px) and a pill in the top-right corner join it, "<session>: reading" / "clicking" / "typing" / ... ("Agent: …" when the host names no session), with a small custom
  glyph: an **eye** for read-only tools (`get_tab_text`, `get_tab_html`, `snapshot`, `screenshot_tab`, `console_messages`,
  `network_requests`, `wait_for`, `watch`), a **pointer** for everything that acts. A click, hover, drag, typing or upload
  also raises a ring once at the element (1.6 s, eased). The bright layer goes ~2.5 s after the last action, the soft
  vignette stays for the session. It is one `<facet-agent-overlay>` element on `<html>` (not `<body>`) with a **closed** shadow root: fixed,
  `pointer-events: none`, maximal z-index, no layout effect, no reading or clicking it from the page. `prefers-reduced-motion`:
  a static vignette, no fades, a static ring of dots.
- **Tab strip**: the *tab* title is **never touched** (no emoji, no marks: the title is the page's own data for analytics,
  history and rebuilt titles). The **favicon** is a **ring of 8 purple dots that rotates** (14 frames per turn at 10 frames
  a second, 1.4 s a turn; the leading dot opaque, the others fading into a tail). It is drawn at 64 px and Chrome scales it
  to 32 and 16 px (the e2e suite checks both). There is no glyph in it any more: the pill carries the eye and the pointer.
  SplitSession sets the **`href` (and `type`) attribute of the page's existing icon links** to the current frame and puts the
  page's own values back when the session ends, when "Show agent activity" or the bridge is switched off, and when the page
  unloads. No icon node is removed, moved or replaced; `apple-touch-icon` is not touched; a value the page sets meanwhile
  becomes the new original; a page without an icon link gets one link of ours, removed alone. Chrome follows an `href`
  change (SVG-icon pages too), so the tab strip animates. The toolbar button's dot of that tab **blinks** (about twice a second:
  purple and a lighter purple; on a container tab the container's colour and purple) for as long as the agent works with
  the tab and ~3.6 s after its last action; then the idle dot comes back. With "Show agent activity" off it does not blink.
- **Tab group** (container tabs in a SplitSession group only): while the agent works in any tab of the group, the **glyph in
  the group's title blinks** "✦ name" ↔ "✧ name" every 1.2 s instead of "⧉ name" (the name and the invisible container
  marker are exactly as before), also when the group is collapsed. **The group's colour is never touched.** The three glyphs
  are equally wide (measured in Chrome: ⧉ 9.55 px, ✦ and ✧ within 0.04 px of it; emoji are 15 px and made the tabs next to
  the chip jump), so neither the blink nor the start and the end move the tabs. One title-only write for the start, one per
  tick, one at the end ("⧉" back). It starts with the tab's first action and ends when the toolbar dot of the last active tab
  stops blinking (the same timer, ~3.6 s after the last action; no second clock), when "Show agent activity" or the bridge is
  switched off, when the tab leaves the group or closes, and when the group goes. The blink timer runs only while some group
  is marked. The changes are not edits: the container is not renamed by them and the tab-group guard ignores them; a rename or
  a recolour the user makes while the mark is on still syncs to the container (the mark stays on the new name; a recolour simply
  wins, as the mark writes no colours). If the worker dies while the mark is on, the next start puts "⧉" back on our groups
  (the invisible marker says they are ours; also with groups off); it also turns back the 🟣 ⚪ of the dev builds before the
  sparkles and the "◉ ◎ ○" of 0.1.5-dev builds (recognised for one release). Plain groups, groups SplitSession does not keep
  and plain tabs get no mark. Full edition only (`group-activity.ts`, `TabGroupProjection.setActivity`).
- **While the bridge is on**, plain tabs show a small **purple dot** on the toolbar button (idle, steady); container tabs keep
  their container-colour dot. With the bridge off there is no purple dot at all. The button's tooltip says the agent has full access.
- `list_tabs`, `list_containers` and `bridge_info` touch no specific tab: popup counter and list only.
- A page that cannot be scripted (`chrome://`, the Web Store, error pages) gets the blinking dot only. Nothing here can make a
  tool fail.
- What the agent reads is not changed by it: `get_tab_text` and `get_tab_html` leave the overlay out (and show the page's own icon values), `snapshot` does not see the overlay (it is `aria-hidden`), `list_tabs` and the `title` fields
  are given **without** the mark, and `screenshot_tab` hides the overlay for the moment of capture. `run_js` (an
  action) never sees a mark in `document.title`; scripts running next to a read-only tool might, for ~2.5 s.
- Turn it off under Settings > For AI agents > "Show agent activity":
  nothing is injected, retitled or badged.

### Switching off mid-tool

Turning the switch off (or losing the connection) aborts every tool that was already received: each step that changes
something re-checks first, and waits end at once, so a request that was queued or slow does not act after "off". The
agent gets "the SplitSession agent bridge was switched off". Every debugger session is detached at the same moment (an attach
that was still under way is undone as soon as it completes). A script already running inside a page (`run_js`) cannot
be recalled.

### Tools

The way to work with a page: **`snapshot`, then act by ref, then `snapshot` again** when the page has changed.

Every tool also takes an optional `profile` (a profile's name or key, from `bridge_info`). The MCP server reads it and never
passes it to the extension. Tools on a tab need it only when the same tab ID exists in two Chrome processes (see "Several
Chrome profiles").

```text
snapshot {tabId: 812}
  {"tabId":812,"url":"https://example.com/signup","title":"Sign up","refs":9,"truncated":false}
  - heading "Create your account" [level=1] [ref=e1]
  - textbox "Email" [ref=e2]
  - textbox "Password" [ref=e3]
  - checkbox "I agree to the terms" [ref=e4]
  - combobox "Country" [collapsed] [ref=e5]: Ukraine
  - button "Join" [ref=e6]
  - link "Log in instead" [ref=e7] /url=/login
  - iframe "Captcha" [ref=e8]:
    - checkbox "I'm not a robot" [ref=e9]
type {tabId: 812, ref: "e2", text: "me@example.com"}       -> {"typed":14}
click {tabId: 812, ref: "e4"}                              -> {"clicked":"<input#terms>"}
select_option {tabId: 812, ref: "e5", values: ["Poland"]}  -> {"selected":["pl"]}
press_key {tabId: 812, ref: "e3", key: "Enter"}            -> {"pressed":"Enter","times":1}
wait_for {tabId: 812, text: "Welcome"}                     -> {"ok":true,"waitedMs":840}
```

Refs belong to the document they came from: after a navigation the old ones are refused ("take a new snapshot"); a
later snapshot of the same document keeps the ref of an element that is still there. CSS `selector`s (top frame) work
wherever a ref does. Iframes are in the snapshot, cross-site ones included (each frame is read on its own and put under its
`<iframe>`; a click inside one is placed by the frame's position).

**How the snapshot is made.** It is read from the DOM (an isolated-world script; no debugger), in the shape of Chrome's
accessibility tree: the same lines, roles, `[level=…]` / `[checked]` / `[disabled]` / `[expanded]` / `[focused]` / `/url=`
attributes and refs as before. It is an *approximation* of the accessible-name algorithm, not Chrome's own: names come from
`aria-labelledby`, `aria-label`, `<label>`, `alt`, `placeholder`, the content and `title`, in that order; roles from the
`role` attribute and the tag. Differences you may notice: elements Chrome reports for CSS-generated content, `::before`
text or implicit ARIA edge cases are missing or named a little differently; hidden elements (`display: none`,
`visibility: hidden`, `aria-hidden`, closed `<details>`) are left out; password values are shown as bullets; a
`contenteditable` root is a `textbox`; open shadow roots and `<slot>`s are followed, closed shadow roots are not; a frame
Chrome does not let the extension script (a sandboxed or error frame) shows `(cannot be reached)`. If a page matters and a
name looks wrong, `get_tab_html` with a `selector` shows the source.

**Tabs and containers**

| Tool | What it does |
| --- | --- |
| `bridge_info` (`profile?`) | The connected Chrome profiles: `profiles: [{profileKey, label, windows, tabs, containers, extensionVersion}]` (`label`: the name the user set, or `null`). With one profile also `profileKey`, `profileLabel`, `windows`, `tabs`, `containers`, `extensionVersion` at the top level. Call it when the tabs are not the ones you expected. |
| `extension_log` (`limit?`, `contains?`, `level?`, `profile?`) | Read-only. SplitSession's own diagnostics log, the entries Settings → Advanced → Diagnostics shows (the extension keeps the most recent few hundred), newest last: `time` (ISO), `level`, `message`, `data` (as text); each entry cut to 2000 characters. `limit` (default 200, max 2000) keeps the newest matches, `contains` filters message and data (case-insensitive), `level` is `info`/`warn`/`error`. No cookies or page content reach this log. `profile` is required when several profiles are connected. |
| `list_containers` (`profile?`) | Containers of every connected profile: id, name, colour, number of tabs, `profile` (`{key, label}`). |
| `list_tabs` (`windowId?`, `containerId?`, `profile?`) | Every tab of every window of every connected profile: `tabId`, `windowId`, `index`, `active`, `focused` (`true` on the one tab the user is looking at: the active tab of their last-focused ordinary window, or, when that is the agents' window, of the last non-agents window they used; absent elsewhere; "this tab" means it), `agentWindow` (`true` on tabs in the agents' window), `pinned`, `title`, `url`, `status`, `groupId`, `container` (`{id, name}` or `null`), `profile` (`{key, label}`). Start here. |
| `open_in_container` (`url`, `container`, `createIfMissing?`, `active?`, `windowId?`, `wait?`, `profile?`) | New tab in a container through SplitSession's own open path: assigned before the first request, so the page loads with that container's cookies. Unknown container is an error unless `createIfMissing`. Opens in the background unless `active`, in the current window (the agents' window when that setting is on) unless `windowId` says otherwise. `profile` is required when several profiles are connected (unless `windowId` says it). |
| `open_tab` (`url`, `active?`, `windowId?`, `wait?`, `profile?`) | New plain tab (http(s), `about:blank`, `chrome://`) in the current window (the agents' window when that setting is on) unless `windowId` says otherwise. `profile` as for `open_in_container`. |
| `navigate` (`tabId`, `url`, `wait?`) | Navigate a tab, keeping its container. A domain rule can still replace the tab (new `tabId`). |
| `navigate_back`, `navigate_forward` (`tabId`, `wait?`) | The previous / next entry of the tab's history (exactly that entry, through the debugger; Chrome's Back button would skip pages nobody interacted with, which is every page the agent just opened). Container tabs get SplitSession's service-worker check first. |
| `reload` (`tabId`, `bypassCache?`, `wait?`) | Reload, keeping the container. |
| `close_tab`, `activate_tab` (`tabId`) | Close; or make active and focus its window. |
| `assign_tab` (`tabId`, `container` or `null`, `createIfMissing?`, `reload?`) | Move a tab into / out of a container; reloads by default. Same caveat as the popup's "Reopen in": a `window.opener` of the old page survives; prefer `open_in_container`. |

**Seeing the page**

| Tool | What it does |
| --- | --- |
| `snapshot` (`tabId`, `maxChars`=60000) | The accessibility tree with refs (above). The primary way to see a page. |
| `screenshot_tab` (`tabId`, `format`=png\|jpeg, `quality`, `fullPage?`) | An image, **without switching tabs**: the tab on show is captured as it is (no debugger), background tabs are captured in place. Only when Chrome hands back a blank picture of a background tab is the tab activated for a moment and the previous one restored. The answer says which way it went (`"path": "visible" \| "background" \| "screencast" \| "activated"`). `fullPage` captures the whole page (up to 16384 px). |
| `get_tab_text` (`tabId`, `maxChars`=20000) | `innerText` of the top frame. Result: a JSON line (`url`, `title`, `length`, `truncated`) then the text. |
| `get_tab_html` (`tabId`, `selector?`, `maxChars`=50000) | `outerHTML` of the document or of the first match. |
| `wait_for` (`tabId`, `text` \| `textGone` \| `ref`/`selector` + `state`=visible\|hidden, `timeout`=5000 ms, max 30000) | Waits for text to appear or go, or an element to become visible or hidden. |

**Acting** (real Chrome input events, `isTrusted: true`)

| Tool | What it does |
| --- | --- |
| `click` (`tabId`, `ref` \| `selector` \| `x`+`y`, `button`=left\|right\|middle, `clickCount`, `modifiers`) | Scrolls the element into view and clicks the middle of its box: mouse move, press, release. `clickCount: 2` double-clicks. |
| `hover` (`tabId`, `ref` \| `selector` \| `x`+`y`) | Moves the mouse there (`:hover`, `mouseenter`). |
| `drag` (`tabId`, from `ref`\|`selector`\|`x`+`y`, to `toRef`\|`toSelector`\|`toX`+`toY`) | Press, move in steps, release; HTML5 drag and drop (`draggable`) is completed with drag events. |
| `type` (`tabId`, `ref` \| `selector`, `text`, `append?`, `slowly?`, `submit?`) | Focuses the field, selects its content (or puts the caret at the end with `append`) and inserts the text as Chrome's own input (React-style controlled inputs see it). `slowly`: one key press per character (≤ 2000). `submit`: Enter afterwards. |
| `press_key` (`tabId`, `key`, `ref?`/`selector?`, `repeat?`) | `"Enter"`, `"Escape"`, `"Tab"`, `"ArrowDown"`, `"Meta+A"`, `"Control+Shift+K"`, `"ControlOrMeta+C"` ... to the focused element (or focus `ref` first). macOS editing shortcuts (select all, copy, undo ...) are sent as the editing commands Chrome needs. |
| `select_option` (`tabId`, `ref` \| `selector`, `values`) | Chooses options of a native `<select>` by value or label (fires `input` and `change`; page script, no debugger). |
| `upload_file` (`tabId`, `ref` \| `selector`, `paths`) | Puts local files (absolute paths; the MCP server checks they exist) into an `<input type="file">`. |
| `scroll` (`tabId`, `ref` \| `selector` \| `to`=top\|bottom \| `dx`/`dy`) | Scrolls the top frame or brings an element into view. |
| `run_js` (`tabId`, `code`, `awaitPromise`=true, `returnByValue`=true, `maxChars`) | `code` is a function body (`return` a value; `await` allowed). Runs in the page's own world through the protocol, so it **works under any Content-Security-Policy**. Errors come back as `Name: message`. `world: "ISOLATED"` is refused: an isolated world would read the regular profile's cookies of a container site. On a tab SplitSession may not debug, or one where the debugger cannot attach (busy), it returns an error: there is no fallback. |
| `handle_dialog` (`tabId`, `accept`, `promptText?`) | Answers an alert / confirm / prompt / beforeunload. A tool whose action opened one says so in its answer ("a JavaScript confirm is open on this tab: ..."), and page tools refuse until it is answered. |
| `resize_viewport` (`tabId`, `width`+`height` \| `clear`) | Emulates a viewport size (e.g. 390 x 844) without touching the window; lasts until `clear`, switch-off, the tab closing, 30 minutes, or 10 s after the agent's MCP process is gone. |

**Debugging the user's own site**

| Tool | What it does |
| --- | --- |
| `watch` (`tabId`, `minutes`=5 (1-30), `stop?`) | Keeps SplitSession attached and records the console (`console.*`, uncaught errors) and network for that long. |
| `console_messages` (`tabId`, `since?`, `level?`, `limit?`) | What was recorded: `console.*` and uncaught errors **only while `watch` runs**; browser messages (CSP violations, failed loads) whenever SplitSession is attached. Each entry has a `seq`; pass `since` = the last one you saw. |
| `network_requests` (`tabId`, `since?`, `filter?`, `includeHeaders?`, `limit?`) | Requests made while SplitSession was attached (any debugger-using tool, the minute after it, the whole `watch`): method, url, type, status, size, time, failure. Cookie and authorization headers are always hidden. |

Records are kept per tab while the bridge is on (at most 500 entries each) and dropped when the tab closes or the
bridge goes off.

Errors come back as MCP tool errors (`isError`) with a sentence that says what to do. `chrome://` pages, the Web Store,
extension pages and error pages cannot be operated (Chrome, and SplitSession's own rule for extension pages).

Sizes: a request from the host to the extension is capped by Chrome at 1 MiB (tool arguments are limited far below that:
`code` 200 KB, `text` 100 KB); results travel the other way, where Chrome's cap is 4 GiB, and are bounded by
`maxChars` (up to 2,000,000) and by screenshot size.

### Ideas, not built

Per-site allow and deny lists, a read-only mode (no click/type/run_js), a confirmation prompt for the first use of each
tool on a site, per-tab "hands off" marks, idle auto-off.

## 8. What the agent should know about the limits

- Two accounts of one site in one browser can trip the site's own anti-abuse checks; SplitSession isolates cookies and page
  storage, not the browser's fingerprint.
- `window.open` popups and links that open new tabs from a container tab stay in the same container, so OAuth popups
  work; a tab opened in any other way (a bookmark, the omnibox, Ctrl+T) is a plain tab.
- After a browser restart, container assignments are gone; open the pages again through `open.html`.

The full list: [limits.md](limits.md).
