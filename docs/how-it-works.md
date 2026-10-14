# How it works

A short tour of the isolation model. The reasoning behind each choice is in [decisions.md](decisions.md); what is and is not isolated is in [limits.md](limits.md).

1. A container belongs to a **tab** (`tabId -> container`), not to a site, so everything the tab requests, on any host, is in its container.
2. For a container's tabs, `declarativeNetRequest` session rules replace the `Cookie` request header with the container's jar and strip `Set-Cookie` from responses. The profile's real cookies are neither sent nor changed. The rules follow `SameSite`.
3. `Set-Cookie` headers are read in `webRequest` before the rules remove them, and stored in the container's jar.
4. A script that runs before the page's own scripts learns its container synchronously and namespaces cookie, storage, IndexedDB, Cache Storage and `BroadcastChannel` access per container.
5. Pages that a container tab opens (`window.open`, `target=_blank`) are created blank, put in the same container, and only then navigated, so even the first request of an OAuth popup is isolated.
6. Service workers and shared workers make requests outside any tab's rules, so they are switched off in containers; strict mode extends that to the whole profile.
7. The content scripts are registered only while containers are in use, so in a profile with none, ordinary pages are untouched.
8. A tab without a container is an ordinary Chrome tab.

## Security model in one page

SplitSession separates accounts on the same site; it is not a privacy tool and not a sandbox.

- **Isolated**: network cookies of the whole tab, the page storage APIs above, popups and links from a container tab, several accounts of one site at once.
- **Not isolated**: the HTTP cache, HTTP auth, client certificates, browser fingerprint, saved passwords and history. The first request of a tab SplitSession did not open itself can go out as the real profile before it is moved into its container.
- **A known hole**: a site that deliberately polls its own same-origin iframe or popup while it navigates can read the real profile's cookies and storage of that origin in the instant before SplitSession's scripts run. No extension API closes this; it can link accounts on that one site only. It is documented and not fixed on purpose: [commit-gap.md](commit-gap.md).
- **Not verified on real sites yet.** The isolation engine and the interface are covered by unit tests and by an end-to-end suite that runs real Chromium against a local multi-host stand imitating the usual login patterns (302 and XHR logins, HttpOnly cookies, OAuth by redirect and by popup, cross-origin iframes). Real sites bring service workers, anti-abuse checks and fingerprinting that the stand does not have, and some may notice two sessions from one browser.

## The agent bridge (Full)

The bridge is **off by default** and one all-or-nothing switch: when on, the agent can do everything in every tab, logged-in pages included. Every tab's toolbar badge turns amber, and pages the agent touches show a glow and a label (this can be turned off). Chrome shows its own "started debugging this browser" bar meanwhile. The debugger is never used to read or set cookies, headers or storage, so container isolation still holds.

Chrome's native messaging connects the extension to a local host; the MCP server talks to the host over a private Unix socket (mode 0600), never over a network port. The tool list, the install options and the security model are in [agents.md](agents.md).
