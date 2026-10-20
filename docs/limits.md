# What SplitSession isolates, and what it does not (v0.1)

SplitSession is a Manifest V3 extension. It isolates containers by rewriting request headers (declarativeNetRequest session
rules scoped to the container's tabs), by capturing `Set-Cookie` into its own per-container jar, and by namespacing
page-visible state with a script that runs before the page's own scripts. That is strong but not airtight: this page
lists what holds, what does not, and the holes we know about. The "isolated" items below are covered by the e2e suite
(`e2e/`, real Chromium against the local stand) or, for cookie parsing rules, by unit tests.

## Isolated

**Network cookies, whole tab.** Every request of a container tab, whatever its host (top frame, cross-origin iframes,
fetch/XHR, WebSocket handshake, dedicated workers), carries the container's cookies and nothing from the real profile.
`Set-Cookie` of those responses goes into the container's jar and never reaches the real profile.
- `SameSite` is honoured on cross-site requests: a request whose initiator is another site (fetch, XHR, images,
  iframes, form POSTs, WebSockets) carries only the container's `SameSite=None` cookies; a cross-site top-level GET
  navigation (a link) also its `Lax` and unspecified ones; `Strict` cookies never go cross-site. A page of another site
  in a container tab cannot ride the container's session (CSRF). See the residual holes under "Cookie semantics".
- Two containers logged into the same site as different users, side by side; a plain tab and the real profile see no
  login; a login in the real profile does not log a container out, and the other way round.
- 302 logins with HttpOnly cookies, fetch and XHR logins followed immediately by another request.
- Cross-domain OAuth through redirects (`a -> sso -> a`) and through a popup: each container keeps its identity on
  both domains.
- Host-only cookies are sent to their exact host only; Domain cookies to the domain and its subdomains. `Secure`
  cookies never travel over plain http (except on localhost-like hosts, as in Chrome).
- Cookie lifetime (Expires/Max-Age, 400-day cap), `__Secure-`/`__Host-` prefixes, public-suffix Domain rejection.
- Survives a restart of the extension's service worker (rules stay installed, state rehydrates).

**Page JS state**, per container on the same origin, with plain tabs keeping their own:
`document.cookie` (HttpOnly never visible), `cookieStore` (get/getAll/set/delete), `localStorage`, `sessionStorage`
(keys, `length`, `key()`, `clear()` only clears the caller's keys, `storage` events filtered), IndexedDB
(`open`, `deleteDatabase`, `databases()`, `IDBDatabase.name`), Cache Storage (`open/has/delete/keys/match`),
`BroadcastChannel`. The same holds in every same-origin window the page can reach: frames, `<object>`/`<embed>`
documents and popups, **including documents whose own scripts are disabled** (`<iframe sandbox="allow-same-origin">`
without `allow-scripts`, nested ones, `srcdoc`): Chrome runs no MAIN-world script there, so SplitSession patches such a realm
from a same-origin realm that has its patches (see "JS-state escapes" for the window that remains). A sandbox without
`allow-same-origin` gives the frame an opaque origin: neither the page nor the frame can reach any storage there.

**Tabs.** `window.open` popups, `target=_blank` links, Ctrl/Cmd/Shift/middle-click link opens from a container tab open
in the same container, and their first request is already isolated. `open.html?container=…&url=…` (by ID or name;
unknown names create the container) assigns the tab before the first request. A popup of a container page into the
**same** container keeps its `window.opener` (same identity: OAuth popups need it). A tab that SplitSession moves into a
**different** container, or out of one, because of a domain rule or the choose page, is never the same document any
more: see "Domain rules" below (found by the third review: the old tab kept its `window.opener`, so the page that
opened it could read the container's cookies and storage through it).

## Deliberately switched off

- **SharedWorker** is undefined in container tabs: its requests belong to no tab and would carry the real profile's
  cookies. Sites fall back to dedicated workers or break.
- **Service workers** cannot be registered in container tabs. A worker answers the requests of the pages it controls
  with its own fetches, which belong to no tab (tab ID -1): outside every per-tab rule, i.e. with the real profile's
  cookies, and their `Set-Cookie` lands in the real profile. A real-profile worker answering a container tab's
  navigation would show the regular account inside the container, and a login made there would land in the real
  profile. Hence:
  - **Strict mode** (setting in Options -> General, **off by default**; it never asks, the popup does not mention it).
    Turning it on, SplitSession removes every service worker of the profile (`browsingData`, all origins; Cache Storage and
    everything else untouched) and the shim refuses `navigator.serviceWorker.register` on every site in every tab. The
    sweep is repeated at browser start and after an update (for pages that were open before SplitSession's scripts were).
    Also in strict mode, a session rule for requests that belong to no tab (`tabIds: [-1]`) **that a page of a
    container site started** (`initiatorDomains` = the container sites) and go to such a site drops both `Cookie` and
    `Set-Cookie`, so a worker that slipped through can neither carry the real profile's session into a container tab
    nor write into the real profile's cookies there. Requests with **no initiator** (the browser's own: a background
    session refresh such as Google's device-bound session credentials, update and favicon fetches) and requests an
    extension starts are not touched (third review, finding 2: the rule used to strip them too, which could sign the
    real profile out of an account it shares with a container). A service worker's fetch has the worker's site as
    initiator, so it stays stripped (e2e: the leftover-worker test). With strict mode on, a second such rule
    blocks every `script` request outside tabs on every site: that is how a service worker's script is fetched
    (measured: type `script`, tab ID -1), so no realm can install one, even one SplitSession's scripts never patched. This one
    has no `initiatorDomains`: it touches no cookies, and it must also hold on sites no container has visited yet.
    Cost (why it is off by default): push notifications and offline mode of **every** site in the profile; on sites containers use, requests of
    the real profile that a page of such a site started outside any tab go **without cookies** and their `Set-Cookie`
    is dropped: shared workers in plain tabs and any worker of the site; `importScripts` and static module imports of
    shared workers (their main script is not affected).
    **Not verified on real sites:** that a browser-initiated session refresh (Google's, other DBSC users') really
    arrives without an initiator and keeps working, and that a Google account of the real profile stays signed in
    while Google is also used in a container. The e2e covers the rule's shape and the extension's own fetch (also
    initiator-less for this rule); **check by hand on a test Google account** before relying on it.
  - Without strict mode (the default): workers are removed and refused on sites a container has visited
    ("managed" sites, also in plain tabs), and **before SplitSession itself navigates a container tab** (`open.html`, the
    API, popups and `target=_blank` links opened from container pages, domain rules, the choose page, `#ctr=`, repeated
    navigations, reloads) it removes the target origin's workers and waits for that. Outside strict mode the refusal on
    managed sites is the shim in plain tabs there; a realm the shim never patched (a tab loaded before the site became
    managed, a DevTools/CDP isolated world) can still register a worker — the next navigation SplitSession makes to that
    origin removes it again. Strict mode adds a network block of worker scripts outside tabs on every site. (A network
    block on managed sites only was tried in `d6bf7fc` and dropped: it broke shared workers' imports in plain tabs.)

## Not isolated / known holes

**Stray first requests.** These requests go out as the real profile (its cookies, and its cookie store may receive the
response's `Set-Cookie` if the response arrives before SplitSession's rules), after which SplitSession repeats the navigation in the
container (GET only):
- a new tab the shim did not open: context menu "Open link in new tab", `<form target=_blank>`, `window.open` from a
  frame the shim did not run in;
- the `#ctr=<name>` marker (the marked URL is requested before SplitSession sees it). Honoured only for existing containers,
  for a tab that is not in a container yet, and for a navigation the browser or an extension started (the main-frame
  request has no `initiator`, or a `chrome-extension://` one; checked in `webRequest.onBeforeRequest`). A page cannot
  move its tab: a `location.hash` change is ignored, and so is any navigation a page starts to a marked URL (history
  entries keep their initiator, so Back to such an entry is ignored as well);
- after an extension update: open container tabs are restored and reloaded within moments, but requests made in
  between are not isolated. (Not covered by e2e: Playwright cannot reload an unpacked extension.)
- POST navigations are never repeated: a `<form target=_blank method=post>` result page stays the real profile's.
- a website Chrome opens directly inside a SplitSession group (an address or bookmark opened next to a grouped tab, a link
  from an ordinary tab, "Duplicate"): its request leaves about 2 ms after the tab exists, before any extension hears of it
  (measured), and **the gap is not 2 ms long**. The page keeps loading as the real profile for roughly 150-500 ms until
  SplitSession has seen the tab and reopened it (a fresh tab of the group's container, the old one closed); in that time the
  site's scripts run with the real profile's cookies and storage, can read them, and can write cookies and localStorage
  there. Anything written stays in the real profile after the old tab is closed. Unless the restore gate blocks that
  address, the site sees the real profile at least once. A new tab page opened inside a group ("New tab to the right", "New
  tab in group") makes no request and is put in the container at once, so an address typed there is isolated from its first
  request.

**Container tabs that come back** (browser restart with "Continue where you left off", an extension update, Ctrl/Cmd+
Shift+T and History's "Recently closed", a closed tab group opened again; setting "Restore container tabs after restart",
on by default). How it works is in decisions.md ("Container tabs that come back"); what holds and what does not:
- **Held before the first request (guaranteed by a rule, not by timing):** a tab that appears with the address of a
  container tab SplitSession remembers is blocked by a declarativeNetRequest rule (`ERR_BLOCKED_BY_CLIENT`) until SplitSession has
  matched it, then reloaded in its container (or as an ordinary tab). Holds for background tabs of a restored session,
  for reopened tabs and windows and for reopened groups. Tabs that Chrome restores "unloaded" or discarded are put in
  their container without loading.
- **Not held: the tab that was active in each window, and pinned tabs, at a browser start.** Chromium loads them while it
  restores the session, before the extension's rules are in force (measured with the extension loaded from the command
  line, as in the e2e; for an extension installed normally not verified, and assumed to be the same). Their first request
  goes out as the real profile (the site sees the real account's cookies for that address, and may set cookies in the real
  profile); SplitSession then matches the tab and loads it again in its container. Same class of hole as `#ctr=`.
- **Matching is evidence, not certainty.** A tab goes back into a container only on one of: the same tab and window IDs
  (extension update); its window's exact list of **two or more** addresses, in order, matching ONE remembered window (by
  position, so an ordinary tab on the same address in that window stays ordinary), at a browser start (and the 5 minutes
  after it) or when that window's recently-closed entry was restored just now; its recently-closed entry being the one just restored;
  sitting in a group whose title carries SplitSession's invisible marker for that container, with a closed tab of that container
  on that address. Conflicts at the strongest level, and at a browser start a tab with only the address in common, make
  the tab **wait** (blocked, not loaded) until the user picks in the popup ("Restore N container tabs" for the
  unambiguous ones, a per-tab "Open in…", "Open as ordinary tabs"). A waiting tab the user navigates elsewhere becomes an
  ordinary tab. Two windows with the same addresses in the same order cannot be told apart.
- **A window with a single web page is never evidence.** A link from another app or "open bookmark in new window" looks
  exactly like it, and a wrong match would put a page into another account. Such a tab is assigned only by the other
  evidence (restored recently-closed entry, SplitSession group marker). At a browser start, one that has only the address in
  common **waits** (that includes a one-tab window restored without its group: one click in the popup or on the tab's
  own page); in the 5 minutes after a start the same address in a new tab may wait too (SplitSession cannot tell it from a late
  "Restore pages?" window). Later it loads as an ordinary tab (blocked for about half a second, then reloaded).
- **A waiting tab is visible.** Instead of Chrome's "blocked by an extension" the tab shows SplitSession's own page
  (`held.html`, no network request) with the choices of the popup banner, its toolbar button carries a red "!" on that
  tab, and every other tab's button says "N tabs are waiting" in its tooltip and shows "!" (unless the agent bridge's
  purple dot is showing). The tab is on SplitSession's page, not on its address, until the user chooses; if the browser is closed
  meanwhile, the page comes back as "no longer on hold" and offers "Open as an ordinary tab" / "Choose a container…".
- **What is gated and costs.** Addresses of open container tabs are blocked for unknown tabs only at the next browser
  start (every tab SplitSession already knows, and every tab it sees appear, passes). Addresses of closed container tabs that
  Chrome can reopen (in its recently-closed list, closed moments ago, or a whole SplitSession group that was closed, kept for 30
  days) are blocked for tabs that just appeared: opening such an address in a brand-new tab (a bookmark into a new tab)
  shows "blocked" for about half a second, then loads as an ordinary tab. The address must be the same up to the
  fragment; an address with `*`, `^` or `|` is gated by its prefix.
- **Not covered:** Chrome's "Restore pages?" after a crash clicked more than 5 minutes after the start (the previous
  session is then no longer matched: ordinary tabs); a container tab whose address changed, or a tab that was closed, in the last ~0.1 s before the
  browser closed (the snapshot is written 0.1 s after a change, at the latest 0.5 s into a burst; closing a plain tab
  counts as a change, since it shifts positions; a stale window list would leave the window's container tabs waiting); a container tab on a page that is not http(s) (new-tab page); a tab opened from History's
  list of visited pages (that is a new navigation, not a restore: ordinary tab); a group the user renamed by retyping its
  title (the marker is gone: the group says nothing); saved groups synced from another device; "Delete group" is treated
  like "Close group". A tab inside a SplitSession group is always put in that container (see Tab groups): a tab restored into
  one, or one the restore holds back there, goes into the group's container. The address list of every window (as a
  hash) and the addresses of container tabs are kept in `storage.local`; switching the setting off deletes them.
- `sessionStorage` is not used as a signal: Chrome restores it with the tab, but only a loaded page can read it, and
  the decision has to be taken before the page loads.
- "Open all bookmarks in new window" in the first 5 minutes after a start without session restore: if the folder's
  addresses are exactly the same sequence (two or more) as a window of the last session that held container tabs, the
  new window may be put into that container (low probability: the whole sequence has to match).

**Races SplitSession repairs, but not instantly.** A response's `Set-Cookie` reaches the rules a few milliseconds later.
Top-level navigations that went out in between are detected by the Cookie header they actually carried and repeated
once; fetch/XHR wait for it (the fetch barrier). Not covered: sync XHR, `<img>`/`<script>` subresources started in that
window, and non-HttpOnly cookies set by a page's own main-frame response may be missing from `document.cookie` for the
first scripts of that page (they arrive by push right after).
The answer to such a stale top-level GET may not overwrite the cookie it missed (Drupal answers the hop after its login
redirect with a new anonymous session): its `Set-Cookie` for that cookie is dropped, the rest is imported, and the
repeated navigation gets the real answer. Not covered by that rule, so a login of this shape can still fail once there:
- a **307/308** login redirect: the next hop is a POST again, which SplitSession never repeats, and its answer is imported
  as is (a server that answers it with a new session replaces the login). Common login forms answer 302/303;
- a **fetch/XHR login whose response is a redirect** that `fetch`/XHR follows by itself: the barrier waits for the final
  response only, so the intermediate hop can go out without the new cookie, and its answer is imported;
- a login form inside an **iframe**: sub-frame hops are neither repeated nor protected.

**XHR handlers attached before `open()`** (residual of `52c65d4`). The XHR barrier (it holds back `readystatechange` at
state 4, `load` and `loadend` until the response's cookies reached the rules) is installed when a script calls `open()`;
until that commit it was installed at `send()`. An XHR object runs its listeners in the order they were added, so a handler
attached **before** `open()` (an `onload` or `onreadystatechange` set, or an `addEventListener`, on a fresh
`new XMLHttpRequest()` before its `open()` call) is ahead of the barrier and can still run before the response's cookies are
in. A request that handler starts at once may then go out without a cookie the response just set, for example a login
followed immediately by another request from inside the same handler. Handlers attached after `open()` are gated. `fetch` is
not affected. Not fixable from the shim without re-ordering listeners the page already registered.

**Service workers without strict mode** (the default): a navigation the
container tab's page starts itself (a link, a form, `location = …`, a server redirect to another site) or an address
typed into a container tab ("New tab" in a container, then the omnibox) is not prepared by SplitSession. If the target origin
has a worker of the real profile, it can answer that first request as the real profile (the removal SplitSession starts on
`onBeforeNavigate` is asynchronous; the page then unregisters it and reloads, so the next load is isolated). Strict mode
closes this.

**Service workers in strict mode.** Two layers while containers are in use: the shim refuses registration in every
realm it patched (every frame of every tab, sandboxed frames included), and the network rule above blocks the worker's
script for any realm the shim missed. While no container is in use, SplitSession's scripts do not run on sites
containers have not used (see "Content scripts" below), so the network rule is the only layer there (measured: refused,
`TypeError` instead of the shim's `SecurityError`). It also covers every realm the shim misses (the window under
"JS-state escapes", a tab open since before SplitSession was installed, the Chrome Web Store, a CDP isolated world:
measured, refused). Earlier versions of this page said a worker could appear only where SplitSession's
scripts do not run; that was wrong (a sandboxed frame without `allow-scripts` was enough, found by the second review).
What remains: the block is a session rule, reinstalled when SplitSession's background starts; between a browser start and
that moment a missed realm (with no container in use: any plain tab on a site containers have not used) could install
a worker, which the sweep at browser start then removes; a container tab restored at that start is reloaded only after
its origin's workers are removed. Should one exist
anyway, its requests to sites containers use carry no cookies and set none (the `Cookie`/`Set-Cookie` rule above): a
container tab it answers shows a logged-out page instead of the real account, and the shim then drops it and reloads.
Dedicated workers cannot register one (no `navigator.serviceWorker` there, measured in Chromium 156).

**Cookie semantics.** `Path` is ignored (every cookie goes to every path of its host). `SameSite` is honoured through
`declarativeNetRequest`'s `domainType` (request site versus initiator site), with these differences from Chrome:
- **Credentials mode is invisible to the rules**: a cross-site `fetch(…, {credentials: 'omit'})` or a CORS request
  without credentials still carries the container's `SameSite=None` cookies (Chrome would send none). `Lax`,
  unspecified and `Strict` cookies are not sent on such requests.
- A navigation without initiator (typed into the address bar, a bookmark, `tabs.update`, the DevTools protocol, the
  navigation `open.html` makes) counts as cross-site: it gets `None`, `Lax` and unspecified cookies but **not
  `Strict`** ones (Chrome sends them). The next same-site navigation or request has them. Sites that require a
  `Strict` cookie may look logged out on such a first load, as after following a link from another site.
- The initiator of a redirect chain is the page that started it: `a.com → sso.com → a.com/callback` started on
  `a.com` sends `a.com`'s `Strict` cookies on the last hop (Chrome would not after a cross-site redirect).
- A cross-site iframe's own requests to its own site carry all its cookies (DNR compares with the frame, Chrome with
  the top-level site); the iframe document request itself gets `None` cookies only. Inside such a frame
  `document.cookie` shows only `SameSite=None` cookies.
- The Lax-allowing-unsafe exception (unspecified cookies younger than 2 minutes on top-level cross-site POSTs) is not
  emulated: such POSTs get no unspecified cookies. `SameSite` of an incoming `Set-Cookie` is not checked against the
  response's context: a cross-site response can set a `Lax` cookie in the jar.
- More rules: a host whose cookies are not all `SameSite=None` needs up to three rules instead of one (first-party,
  third-party, cross-site top-level GET). The 5000-rule limit and the guard below are unchanged.

Partitioned (CHIPS) cookies are kept per top-level site, but a script-written partitioned cookie can be missing from the
local `document.cookie` view for a moment. `ws://` requests to subdomains of a host holding Secure cookies may still
carry those Secure cookies (a `urlFilter` cannot say "http or ws").

**JS-state escapes.**
- Dedicated workers are not patched: IndexedDB, Cache Storage and BroadcastChannel inside a worker of a container tab
  use un-namespaced names, i.e. the real profile's databases on that origin. (Their network requests are isolated.)
- **The moment a same-origin frame navigates, its new document is unpatched until SplitSession's scripts run in it.** Chrome
  creates the new document when the navigation commits, but injects content scripts only when its first element is
  parsed, in a later task. A page that keeps polling `window[n].document.cookie` (a tight `MessageChannel` loop) while
  it navigates its own same-origin iframe reads, in that gap, the real profile's non-HttpOnly cookies and the origin's
  unnamespaced storage (the real profile's keys and the `__facet:<key>:` keys of every container on that origin), and
  can write there. Measured in Chromium 156: one read per navigation, in 10 of 10 navigations, for ordinary and
  sandboxed frames alike (document still `loading`, no `<html>` yet). This is not new (it held for every same-origin
  frame before the second review too) and **no extension API closes it**: there is no hook between commit and
  `document_start`; see docs/decisions.md. In plain words: a site that deliberately tries can link the containers
  and the real profile **on its own origin**; it cannot read other sites' data this way. In a cross-site frame
  Chrome's own third-party cookie and storage partitioning limit what that gap shows.
  Same gap applies to same-origin popups (window.open) — 5/5 measured; details and rejected approaches in
  [docs/commit-gap.md](commit-gap.md).
- A sandboxed frame without `allow-scripts` whose parent is **cross-origin** (reached by a same-origin sibling or
  cousin) is patched one task after its document starts (measured: 2 polls per navigation in the same loop, no
  cookie leaked thanks to third-party partitioning); with a same-origin parent it is patched before any script runs.
- A same-origin child frame keeps using its parent's bridge (the parent patches it before its own shim runs), and so
  does a same-origin navigation that reuses an `about:blank` window. The view is the same; the frame's own cookie
  writes without `Path` get the parent document's path (SplitSession ignores `Path` anyway).
- The beacon URL is readable by any frame of a container tab. It reveals an opaque key for (container, the frame's
  registrable domain): HMAC-SHA-256 with a per-install secret, 80 bits, so keys of two sites cannot be linked and the
  container's ID never reaches a page. It also reveals the non-HttpOnly cookies of the requesting frame's registrable
  domain (including other hosts of that domain) and, only while "Show the container name to pages" is on (**off by
  default**; AI agents need it on), the container's name, which the top document then also carries as `data-ctr` and
  in the title prefix. The name is the same on every site, so trackers on two sites can link visits through it (and a
  page can read it to tell that it runs in SplitSession). An install from before this default changed that never switched it
  on itself gets it off (docs/decisions.md). That a page runs in *some* container stays detectable
  either way (the beacon answers at all). Any page can tell that SplitSession is installed while its scripts are
  registered (the beacon answers `{}` in plain tabs); with no container in use and no site used by one, it cannot.
- Page storage is namespaced by that key (`__facet:<key>:…`). Data stored under the v0.1 prefixes
  (`__facet:<container ID>:…`) is no longer read: localStorage, IndexedDB and caches of containers created before this
  change start empty (cookies are unaffected).
- A frame whose site got no beacon answer in time (a frame the background had not seen being requested) blocks for up
  to a second at document start while it asks for one. If none arrives (opaque origins, worker unreachable) it runs with
  a throwaway key: isolated, but what it stores is not found again.

**Content scripts (beacon and shim) only while containers are in use.** While a tab is in a container (or the restore
is matching or holding tabs), both scripts run in every frame of every tab, plain tabs included: each frame makes one
synchronous request to `http://ctr.localhost/whoami`, answered by a DNR rule with a `data:` URL (it never reaches the
network, but DevTools' Network panel shows it). 30 seconds after the last container tab is gone they are narrowed to the
sites containers have used (plain tabs there still hide the containers' `__facet:` storage and refuse service workers),
so a page on any other site makes no such request; a profile that never used a container has no script and no beacon
answer at all. The next container tab registers them again before its first navigation. What plain tabs lose while no
container is in use: on sites containers have not used, the shim's strict-mode guard (the network rule above still
refuses service workers). Deleting every container does not narrow further: its sites stay managed, because their
namespaced storage is still in those origins. Only things that are open keep every site covered: tabs in containers, tabs
the restore is deciding about or holds for you, a move into a container under way. What Chrome can bring back (a closed
group saved in its saved tab groups, recently closed tabs; up to 30 days) does not: the tabs come back held by the restore
gate (their address is blocked), which registers the scripts for every frame before the tab loads. Settings, Diagnostics,
"Page scripts" shows the state ("All sites", "Container sites only (N)", "Off") and why.

**Shared with the real profile and between containers:** HTTP cache, HTTP authentication, client certificates, the
browser fingerprint, permissions, saved passwords/autofill, history.

**Not verified:** prerendering and prefetch triggered by the browser, favicon fetches, and `<a download>` downloads:
any of these that Chrome issues without the tab's ID would carry the real profile's cookies.

**Limits.** Chrome allows 5000 session rules and 1000 regex rules per extension. SplitSession warns above 4000 rules, falls
back from regex to per-scheme URL filters past 900 regex rules, and refuses to put a tab into a container when the rules
would not fit. Deleting a container closes its tabs and forgets its cookies, but leaves its namespaced storage
(`__facet:<key>:…` keys, databases, caches) in the sites' origins.

**Tabs opened by the user** next to a container tab (Ctrl+T, bookmarks, omnibox) are plain tabs, as in Firefox.

## Interface, domain rules, tab groups and indicators (Stage C)

**Domain rules.**
- A rule fires when the browser starts a main-frame navigation to the rule's site: the address is opened in a **fresh
  tab** of the rule's container at the same place (window, position, pinned and active state) and the old tab is
  closed, as Firefox Multi-Account Containers does. The old tab is never navigated into the container: a document
  that stays alive keeps its `window.opener` (and any other reference another context holds), and that context would
  read the container's cookies, storage and HttpOnly-authenticated `fetch` through it. The new tab is created
  without an opener (`tabs.create`, no `window.opener`; SplitSession cannot always see an opener, so it is done for every
  move). The same holds for the choose page when the user picks a container different from the tab's current one
  (or none, from inside a container). Costs: the tab ID changes, the tab's back/forward history and scroll position
  are not carried over, a user tab group is left (SplitSession groups the new tab itself), and a script that holds the
  popup it opened sees it `closed`. The loop guard's history moves with the tab. **Not covered:** the popup's "Reopen
  in container" and `assignTab` through the API still put the *existing* tab in the container and reload it, so a
  tab that has an opener keeps it there (the user chose that move on this very tab; same hole, not yet fixed).
  The request that triggered the rule has already left, as whatever the tab was before
  (a plain tab: the real profile; a tab of another container: that container). Its `Set-Cookie` is not imported into the
  new container, and for a plain tab it may reach the real profile's cookie store. The same hole as `#ctr=`. The "ask"
  rule has it too: the page is requested once before the choose page replaces it.
- Server-side redirects are not judged: a navigation to `a.com` that is redirected to a ruled `b.com` stays where it is.
  Client-side redirects (`location = …`, meta refresh) are new navigations and are judged.
- A deliberate placement exempts its site: a tab put in a container through the popup, `open.html`, the choose page,
  `#ctr=`, or inherited from a container page (popups, `target=_blank`) is not moved by a rule on its first navigation,
  nor on further navigations within the same site while it stays in that container. Visiting another site ends the
  exemption, so coming back to the first site is a new visit and the rules apply.
  A **tab opened by a container page** is not judged at all during its first five seconds (and keeps the exemption for
  its first navigation after that), so an OAuth popup and its redirect hops cannot be hijacked into another
  container; the cost is that a link from a container page to a ruled site opens in the page's container, not the
  rule's.
- Rules are keyed by registrable domain (eTLD+1); a rule for `github.com` covers `gist.github.com` and cannot be
  narrowed to a subdomain. A site is never moved more than four times in ten seconds (loop guard).
- Rules for a container that is deleted are deleted with it.

**Tab groups** are a view of the containers, with one exception: **every tab inside a group that carries a container's marker
is in that container.** A website you drag into such a group, or one that is found in it otherwise, is reopened in the
container (a fresh tab at the same place, so the page reloads; its tab ID changes, history and scroll are not carried over, and a
form half-filled in it is lost). A tab that has loaded nothing (the new tab page Chrome opens inside a group, a tab Chrome has
not loaded or has discarded, a page that is not a website, a tab the restore holds back) is put in the container where it
stands. Besides the tab events, a check runs a second after tabs or groups change, when the worker starts, and every 30 s
while such a group exists (an alarm), so a tab that got in without an event (dropped from another window, from before an
update) is fixed within about half a minute. Every such action is in SplitSession's log (tab, from -> to, reason). Otherwise a group is only a view. Their titles end in an invisible marker (zero-width characters naming the container), so
SplitSession can recognise its own groups after a restart; a title read by another extension or agent includes those characters. They follow the container when a tab is assigned or moved to another window, when a
container is renamed or recoloured, when the setting is switched on and on "Re-group tabs"; they never read a tab's
group to learn its container (except for the rule above), and a tab you drag out of a group, or into a group that is not
SplitSession's, keeps its container and is **not** pulled back until one of those happens. Dragging a container tab from one container's group into
another's reopens it in the second. A group you made, or one whose title you retyped, has no marker and never moves a tab. The toolbar button shows an arrow on the
container's colour for four seconds after such a move. A tab SplitSession itself opens at a grouped tab's place (a domain rule,
the choose page) keeps the container it was opened in and leaves a group that names another one. With the "Group tabs by
container" setting off a moved tab is not grouped, and a tab put into another container leaves a group that names a different
one. Costs of the check: a website the user had sitting in a container's group from before this version is reopened in the
container (logged out there if the container has no login for it) once the updated worker starts. Pinned tabs cannot be grouped (Chrome). Groups are per window: a container with tabs in two windows has two
groups. Groups SplitSession made are removed when the setting is switched off; groups the user made are never touched. While
the user is dragging a tab, Chrome refuses group edits; SplitSession retries for about a second and then gives up on that one
tab (it joins its group at the next trigger); a move after a drag waits for the drop (up to about twenty seconds).

**Split view** (Chrome 140+). Chrome keeps the two tabs of a split view in one tab group, so a tab joined into a split view
with a tab of a container's group lands in that group. SplitSession does not reopen it there: a split view whose tabs are not
all in one container (two containers, or a container tab and an ordinary tab) is taken out of the group, both tabs keep their
containers and logins, and a container tab among them gets the `⧉ ` title mark. A split view of two tabs of one container stays
in that container's group; a split view of one container dropped into another container's group is taken out too, not
reopened. When the split view is closed the tabs stay ungrouped until "Re-group tabs now". For a moment after the join (about
a third of a second) the pair sits in the container's group. Chrome before 140 does not tell extensions about split views;
there a joined tab is reopened in the group's container as before.

**Title prefix.** Only while "Show the container name to pages" is on (off by default: a page can read its own title). `document.title` as the page's own scripts read it then includes `[name] `. Pages that keep rewriting their
title in a loop are given up on after 25 rewrites in 3 seconds (the prefix stays off for that document). An empty title
is left empty (Chrome then shows the address), so such a tab has no prefix until the page sets one. The prefix is applied
by a content script, so it appears a moment after the document starts and is absent on pages where content scripts do
not run (the Chrome Web Store, `chrome://` pages, PDFs in the built-in viewer).

**Outside-group mark.** A container tab that is not inside its container's tab group (dragged out, a pinned tab, or every container tab while "Show containers as tab groups" is off) gets `⧉ ` in front of its title; setting "Mark container tabs outside their group", on by default, both editions. The mark has no container name, but a page can read `document.title`, so a site learns that this tab is a container tab (and that it is outside its group). With the name prefix on the title reads `⧉ [name] Title`. The mark is not part of what agents read (`list_tabs`, page text and HTML, snapshots). It follows the same rules as the title prefix: an empty title stays empty, a page that keeps rewriting its title is given up on, it is applied by a content script (absent on `chrome://` pages, the Web Store, PDFs), and it appears a moment after the document starts. The mark follows Chrome's report of a tab joining or leaving a group, usually within a fraction of a second.

**Badge.** Chrome resets a tab's toolbar badge when the tab navigates; SplitSession sets it again after each commit, so it
can be missing for a few milliseconds.

**Export and import.** An export **with cookie jars is plain text and holds live logins**: anyone with the file can sign
in as you. The options page says so; without the checkbox the file has containers and rules only. Importing matches
containers by name, keeps existing ones as they are (colour included), creates missing ones, replaces rules for the same
site and merges cookies into the matching jar.

**Reinstalling.** Removing the extension deletes everything in `chrome.storage`: containers, cookie jars (the logins), rules,
settings. Chrome keeps the tab groups, and their titles keep SplitSession's invisible marker, so with no container left the
popup offers "Found N tab groups from an earlier install. Restore them as containers?". Restore gives each marked group
(never one of the user's own) back its container, with the group's name and colour and under the ID the marker names, and puts
the group's tabs in it (a loaded page is reopened in a fresh tab, like a tab dragged into a group; one Chrome has not loaded is assigned as it is); the groups are kept, not recreated. **Logins are not recovered**: the jars are gone, every site has to
be signed in again (a site that kept its session in `localStorage` or IndexedDB may still know the container, since that
storage is prefixed with the container ID and stays in the profile). Domain rules, other settings and a container with no
open tab in a group cannot be recovered either. Settings, Advanced, Export and import warns before a reinstall; an export
(with the cookies box ticked) is the only backup of the logins.

One gap is accepted in a restore: a tab Chrome has not loaded (unloaded or discarded) is assigned in place and read again
right after. If Chrome resumes its plain document in that instant, the document can send a few requests under the new
container's rules before it is replaced. Restore runs only with no container at all and each container starts with an empty
cookie jar, so the worst case is a few requests without cookies, or a cookie set by them landing in a jar that tabs restored
just before may have started filling.

**"New tab" in a container** opens Chrome's new tab page assigned to the container; an address typed into its omnibox is
requested as the container.

**The import file picker** is the operating system's: a hidden file input, the one native control the interface keeps.

## Agent bridge (opt-in, off by default)

The bridge is **not an isolation feature; it is a hole you open on purpose.** While the switch is on, an agent has
full access to every tab, in containers or not (docs/agents.md, section 7). What that means in practice:

- **All or nothing.** There are no per-site allow or deny lists, no read-only mode, no confirmation per action.
  Anything the agent does in a logged-in tab is done as you: it can read mail, post, buy, change settings. It acts through
  your browser, so sites see your browser, not a robot.
- **"On" trusts every program running as you.** The socket (`~/Library/Application Support/SplitSession/bridge.sock`, 0600 in a
  0700 directory) keeps other users and web pages out, but not another program of yours, or malware running as you,
  while the switch is on. The MCP server is not authenticated beyond that: there is no token. Turn it off when you are
  not using it.
- **Only this extension can start the host**: the host manifest's `allowed_origins` and the host itself pin SplitSession's fixed
  extension ID. Anyone who can edit your `NativeMessagingHosts` folder or `~/Library/Application Support/SplitSession/host/` can
  already run code as you.
- **The agent sees what the page shows, including container names** (titles carry the `[name] ` prefix when that
  setting is on), and `run_js` in the MAIN world runs in the page, where it can read the page's cookies that are not
  HttpOnly and its storage. Container isolation still applies to the *pages*; it does not apply to the agent, which
  sees all containers.
- **The debugger is visible, and it is yours to cancel.** While SplitSession is attached to any tab, Chrome shows "SplitSession started
  debugging this browser" and moves the page content down (and back up when it goes). SplitSession attaches only for trusted
  input, `upload_file`, `run_js`, background screenshots, dialogs, `watch` / console / network and `resize_viewport`
  (`snapshot`, `get_tab_text`, `get_tab_html`, `wait_for`, `select_option`, `scroll` and a screenshot of the tab on show do
  not need it), and then keeps the session for 60 s after the last such tool, so a burst of actions shows the bar once; it
  also stays for the whole `watch` (30 minutes at most); while a
  `resize_viewport` override lasts (30 minutes at most, or until the agent's MCP process is gone plus a 10 s grace); while
  a JavaScript dialog waits for an answer (10 minutes at most)). That bar cannot be hidden by an extension. "Cancel" detaches SplitSession; the agent gets an error that says
  the user took it back, and that tab is left alone for 60 s.
- **Debugger next to other debuggers.** Chrome lets several debugger clients share a tab (DevTools, Claude in Chrome,
  Playwright), so SplitSession attaches next to them and never detaches them. The risk is not a refusal but two agents typing
  into the same tab at once: do not run two agents on one tab. If Chrome refuses a second attach (it does so only for the
  same extension; after a service-worker restart that is SplitSession's own forgotten session, which it detaches and takes
  back), the tool says "the tab is busy". A real refusal by another client could not be reproduced in the e2e suite
  (Chrome 156 allows several clients), so that path is unit-tested only.
- **Some sites detect debuggers.** SplitSession enables only Page, Network and Log, which pages cannot observe; the console
  domain (Runtime), which anti-bot scripts probe for, is enabled only during `watch`. Trusted input and focus emulation
  are still a debugger's input: a site that fingerprints input timing can tell an agent from a person.
- **JavaScript dialogs.** A dialog that opens while SplitSession is attached (usually because the agent clicked something) is
  reported and answered with `handle_dialog`. A dialog that was **already open before SplitSession attached** cannot be seen or
  answered: SplitSession probes the page first and, if it does not respond, refuses with "a JavaScript dialog may be open, ask
  the user to close it" instead of enabling the Page domain (in Chromium 156 enabling it next to an open dialog that
  another client holds crashed the browser). A dialog SplitSession **did** see keeps its session attached (so `handle_dialog`
  works after the agent paused) for up to 10 minutes; after that SplitSession lets go of the tab and a later attempt says that
  the dialog was left open and cannot be answered any more.
- **`snapshot` is built from the DOM, not Chrome's accessibility tree.** That is what lets it run without the debugger
  (no "debugging" bar for a read). The output has the same shape, but names and roles are an approximation of the
  accessible-name algorithm: CSS-generated text, some implicit ARIA corners and closed shadow roots are missing or named
  differently; hidden elements are left out. Refs live in a registry in the extension's isolated world of each frame
  (weak references; nothing is added to the page) and die with the document.
- **Frames.** Same-site and cross-site iframes appear in `snapshot` (a same-origin frame is read with its parent; every
  frame of another site is a separate script and is matched to its `<iframe>` by address and order, at most 20 frames
  and 3 levels deep) and can be clicked by ref; a click is placed by the frame's position in the page. `upload_file` into a
  frame of another site is refused. `selector`, `get_tab_text`, `get_tab_html`, `scroll` by offset, `wait_for` by text and
  `run_js` work on the top frame only. A dialog opened by a cross-site frame is not seen.
- **`run_js`** runs through the protocol in the page's own world and works under any page CSP. Where the debugger
  cannot attach (a tab SplitSession may not debug, or one that is busy) it returns an error; there is no fallback. `world: "ISOLATED"` is refused on purpose (it would read the
  regular profile's cookies of a container site).
- **`screenshot_tab`** captures the tab that is on show in a window that is not minimised with Chrome's
  `captureVisibleTab` (no debugger, no tab switch; `"path": "visible"`; a window Chrome will not capture falls back to the
  debugger). It captures background tabs in place (`Page.captureScreenshot`; a screencast frame as the second try). Only if both give a picture of a single flat colour while the page has visible content is the tab activated for a
  moment and the previous tab restored (`"path": "activated"`): the user may see a flash. In headless Chromium every tab
  renders, so the e2e suite proves "no tab switch" there; in a real window Chrome normally renders a hidden tab for the
  capture as well, but a tab Chrome has discarded or frozen may need the activation path. A minimised window cannot be
  captured that way. Full-page shots stop at 16384 px.
- **`console_messages` / `network_requests` record only while SplitSession is attached** (during a debugger-using tool, the minute after it,
  and the whole `watch`), not before and not across a switch-off; `console.*` output only during `watch`. At most 500
  entries per tab; headers on request only, and `Cookie`, `Set-Cookie`, `Authorization`, `Proxy-Authorization` and CSRF
  token headers are always replaced by "(hidden by SplitSession)". Response bodies are not recorded.
- **`upload_file`** gives a page any file the agent names (the MCP server only checks that it exists). The agent can read
  your files anyway; the new part is that it can hand them to a website. Chrome may require "Allow access to file URLs"
  for SplitSession (chrome://extensions > SplitSession > Details) before it lets an extension set files; the tool says so if it does.
- **Focus emulation.** While SplitSession is attached, the tab's page believes it is focused, even in the background (that is
  what makes typing work there). A chat page may mark messages read in those seconds.
- **`resize_viewport`** emulates the size for the page only (the window does not change) and keeps SplitSession attached until
  `clear`, 30 minutes, or 10 s after the last MCP client has gone (the MCP server keeps one idle connection to the host
  while it runs; when it closes and no other is open, SplitSession clears overrides and detaches every tab). A client that
  exited without closing its connection (a frozen process) is not noticed; the 30-minute cap still applies. With plain Chromium, clearing restores the real size; under Playwright (whose own viewport emulation sits on
  the same tab) the page kept the emulated width after clearing, so the e2e test checks the release, not the size.
- **Agent activity in the page and the tab strip.** For the whole agent session on a tab (a tool touched it in the last
  ~8 s, or the debugger is held on it by a `watch`, a viewport pin or an open dialog) SplitSession draws a soft purple vignette
  along the viewport edges, made of gradients only (one `<facet-agent-overlay>` on `<html>`;
  a top-layer `<dialog>` still covers it; the colour is always purple, never the container's) and changes the `href` (and
  `type`) **attribute** of the page's own
  `<link rel="icon">` / `shortcut icon` nodes to an animated frame (a `data:image/png` URL: a ring of purple dots, 48 frames
  a turn at 30 a second, 1.6 s a turn), putting the
  page's values back afterwards; no node is removed, moved or replaced, `apple-touch-icon` is not touched. A page script that
  reads `link.href` (or a framework that diffs `<head>`) during the session sees the frame; one that rewrites the link
  meanwhile has its value kept as the new original (and our frame goes on top again until the end, switch-off or `pagehide`).
  A page with no icon link gets one extra link of ours instead. A page that rewrites its icon links more than ~80 times in
  10 s gets them left alone (no animation). The tab title is never touched. A page that blocks scripting (chrome://, the Web
  Store, error pages) gets the badge only. The session is renewed every 2 s by the service worker with a 6 s lease on the page:
  if the worker dies, the glow ends by itself. Favicon rate (measured, Chromium 156): Chrome reports a changed icon `href`
  to the browser process as fast as it is written, up to 60 a second (`tabs.onUpdated` `favIconUrl`: 10, 15, 20, 30, 60 fps
  targets gave 10, 15, 20, 30, 62 updates a second), so 30 fps is a choice, not Chrome's limit (what the tab strip then
  paints is Chrome's UI and cannot be measured from the extension). A tab in the BACKGROUND is different: its page timers are throttled
  (measured headed: a 30 fps `setInterval` ran 4-6 times a second, a 10 fps one ~3), so the service worker (whose timers are
  not throttled: 30.2 of 30 a second) sends the tab a `tick` message every 33 ms and the page draws the frame the wall clock
  says; measured 30.0-30.1 updates a second for a background tab. A Web Worker as the page's own metronome was
  not used: it is as fast (28 of 30 a second) but a page with a strict `script-src`/`worker-src` CSP refuses the blob worker
  even from the extension's isolated world. The ticks go only to scripted session tabs that are not the active tab of their
  window. A fully covered window of the active tab is throttled too, but its tab strip is not visible either.
  The glow's breathing is a single Web Animation per page: tool calls, screenshots and the page removing the overlay element
  never restart it (see decisions.md, "Smooth indicators").
- **`assign_tab`** has the known gap of the popup's "Reopen in": the tab keeps a `window.opener` of its old document.
  `open_in_container` has no such gap. `navigate` can be answered by a domain rule that replaces the tab (new ID).
- **One profile at a time, and the first one wins.** A second Chrome profile turning the bridge on does not take the
  socket over: its host sees a live socket, reports "busy" and exits; its popup says "Another Chrome profile holds the
  agent bridge — turn it off there first" and retries every 10 s (and on the 1-minute alarm), connecting when the first
  lets go. There is no way to use two profiles at once. `bridge_info` and the optional profile name (options page) tell
  the agent which profile it reached. Two hosts starting in the same instant are resolved by the socket bind (the loser
  is "busy"); a leftover socket of a killed host is detected (connection refused) and replaced.
- **Switching off mid-tool.** Tools check the switch before every step that changes something and stop waiting at once,
  so a received-but-not-started action is not performed; every debugger session is detached at the same moment. What cannot be recalled: a script already running in a page
  (`run_js`, including its timers), and a browser call already issued (a click that was dispatched, a navigation that
  was started).
- **macOS only** in this version (paths, `lsof` in the tests); Linux paths exist in the installer, untested.
- Chrome caps a message **to** the extension at 1 MiB; requests are small and refused beyond that. Results (the other
  direction, 4 GiB) are bounded by `maxChars` and screenshot size, and a 1.5 MB result is covered by an e2e test.
- The host program is a **copy** made by `pnpm bridge:install`; after changing the bridge or the Node version, run it
  again. `claude mcp add` points at the repository's `bridge/dist`, so `pnpm bridge:build` updates that side only.

