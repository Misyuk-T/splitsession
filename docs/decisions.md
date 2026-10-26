# Decisions log

> **Facet was renamed to SplitSession on 2026-10-11.** Entries below are historical and keep the old name (and the old
> native host `com.facet.bridge`, folder `Application Support/Facet`, file `facet-bridge.mjs`); see the last section, "Rename",
> for what changed and what deliberately did not.

Decisions taken while implementing the plan, where the plan was silent or was refined. Newest last.

## Stage A (2026-10-09): scaffold and `src/core`

- **Toolchain versions** are the latest stable on npm at the time: WXT 0.21.4, Vite 8.3.4, Vitest 5.0.3, TypeScript 7.0.2, Preact 11.0.1, `@preact/preset-vite` 2.10.6, tldts 7.4.18. There is no `@wxt-dev/module-preact`; Preact is wired through `@preact/preset-vite` in `wxt.config.ts` (verified with a throwaway popup build).
- **`host_permissions: ["<all_urls>"]` for v0.1** instead of the plan's optional host permissions: header rewriting needs host access and headless e2e cannot click permission prompts. `cookies` stays optional.
- **Cookie identity** is `(name, domain, host-only flag, path, partitionKey)`. The host-only flag is part of the key (RFC 6265bis 5.7), so `a.com` host-only and `Domain=a.com` cookies coexist.
- **Cookie lifetime** is capped at 400 days (Chrome / RFC 6265bis). `Max-Age <= 0` and past `Expires` store `expires = 0`; the jar treats an expired upsert as a delete.
- **Rejections mirror Chrome**: `Secure` from a non-secure origin (localhost-like hosts count as secure), `SameSite=None` without `Secure`, `Partitioned` without `Secure`, public-suffix `Domain` (private registries such as `github.io` included), `__Secure-`/`__Host-` violations (`__Host-` is checked against the final path, so the default path `/` qualifies).
- **`document.cookie` writes containing `HttpOnly` are rejected outright** (Chrome and RFC 6265bis: script cannot create HttpOnly cookies), and script writes cannot overwrite or delete an existing HttpOnly cookie. `applyDocumentCookieWrite` takes `(host, string, {secure, path?, topLevelSite?, now?})` so the default-path and `Secure` checks have the data they need.
- **Partitioned (CHIPS) cookies** carry `partitionKey = ctx.topLevelSite`. If the caller does not know the top-level site the key is null and the cookie never matches anything.
- **Secure cookies and plain http in the DNR compiler.** A per-host rule that carries `Secure` cookies would also fire for `http://` requests and send them in clear text. For hosts holding Secure cookies (and their subdomains) the compiler therefore adds a second rule: `urlFilter: "|http://"`, priority `100 + labels`, setting only the non-Secure cookies (or removing the header). Not emitted on localhost-like hosts. `ws://` is not covered (a `urlFilter` cannot say "http or ws").
- *(Superseded in Stage B: identity-only generic answer, snapshot per registrable domain.)* **Beacon payload is per tab and larger than the plan's `{"c": ...}`**: `{c, k, s}` where `k` is a snapshot of the non-HttpOnly cookies visible to the tab and `s` its top-level site. The ISOLATED script rebuilds a `CookieJar` from `k` and computes `document.cookie` for its own host locally, using the same core code. This keeps one beacon rule per tab instead of one per host. If the snapshot would exceed 200 000 bytes it is replaced by `{c, o: 1}` and the shim must fall back to fetching cookies asynchronously.
- *(Changed in Stage B.)* **Priority bands**: catch-all 1, host rules `10 + labels`, http-only variants `100 + labels`, beacon 1000. Label counts are capped at 63 so bands cannot overlap.
- *(Fixed in Stage B: EXACT rules.)* **Known approximation, inherited from the plan**: `requestDomains` also matches subdomains, so host-only cookies of `a.com` are offered to `x.a.com` when only the `a.com` rule applies. Paths are not matched.
- **Beacon `urlFilter`** is `|http://ctr.localhost/whoami^` so a cache-busting query string still matches.
- **`compileTabRules` throws on `tabId < 0`**: `-1` in a DNR `tabIds` condition matches every non-tab request (service workers, other extensions).

## Stage B (2026-10-09): engine, background, content scripts, e2e

Measured in Playwright's bundled Chromium 156 (Chrome for Testing, `channel: 'chromium'`, headless) unless noted.

### Core rule compiler
- **Host-only cookies are exact-host only.** Per cookie host `h` the compiler now emits a WIDE rule (`requestDomains: [h]`, Domain cookies only, which is right for subdomains) and, when `h` holds host-only cookies, an EXACT rule anchored on the host with `regexFilter` `^(?:https?|wss?)://h(?::[0-9]+)?/` (plus `requestDomains: [h]` for indexing). Fixes the Stage A leak of `a.com` host-only cookies (HttpOnly sessions included) to `x.a.com`. A substring/`*` urlFilter was rejected: `x.a.com/?u=https://a.com/` would match it.
- **Regex budget.** Chrome allows 1000 regex rules; the engine gives the compiler a shared budget of 900. Past it, EXACT rules fall back to one left-anchored `urlFilter` per scheme (`|https://h^`; `^` never matches `.`). Unit tests check both forms produce identical headers.
- **Priority bands** changed to fit the pair: WIDE `10 + 2*labels`, EXACT `11 + 2*labels`, http-only variants `200 + 2*labels` / `201 + 2*labels` (EXACT http also covers `ws://`), generic beacon 1000, per-site beacons `1000 + labels`.
- **Rules per container, not per tab.** Every rule carries `tabIds: [all tabs of the container]`, so the rule count grows with containers and hosts, not tabs. Tabs are split into groups by top-level site only while the jar holds partitioned (CHIPS) cookies (since 2026-10-26 the groups' identical rules are merged: "Session rules scale with containers").
- **The beacon is readable by the page.** Measured: a page's own `fetch('http://ctr.localhost/whoami')` (CORS or no-cors) and sync XHR receive the DNR `data:` redirect body. Stage A's whole-jar snapshot would have exposed every non-HttpOnly cookie of the container to any frame. Now the generic per-container rule answers only `{c, n}` (ID, name); the `document.cookie` snapshot comes from one rule per registrable domain with `initiatorDomains: [site]` (verified: the initiator of an ISOLATED-world XHR is the page origin). Residual exposure is listed in limits.md.
- `compileManagedBeaconRule` builds the global `{m:1}` answer (see SW policy). A tiny DNR matching simulator (`src/core/dnr/dnr-simulator.ts`, test-only) lets compiler tests assert the Cookie header a URL ends up with.

### Engine and background
- **Session rules** (`SessionRuleManager`): invalidations are coalesced (`setTimeout 0`) into one `updateSessionRules` call that atomically removes a container's old IDs and adds the recompiled rules (IDs released in a batch may be reused in the same batch: Chrome removes first). Flushes are serialised. Failure or a batch over 5000 rules keeps the old rules; `assignTab` then refuses the assignment. Soft limit 4000 logs a warning. On worker start every existing session rule is replaced in one call (`reset`).
- **Stores.** Containers in `storage.local` (`containers`), jars as `jar:<id>` (debounced 150 ms, flushed on `onSuspend`). IDs are 10 lowercase alphanumerics (they end up in storage prefixes). Names are unique, case-insensitive. Tab registry `tabId -> {containerId, topLevelSite, activeSince, windowId, url}` in `storage.session`, mirrored to `storage.local` (`tabsBackup`).
- **Extension update / reload wipes session rules and `storage.session`.** Measured with `runtime.reload()`: an open container tab's next request carried no container cookie. On `onInstalled(reason: 'update')` the background restores tabs from the `storage.local` backup whose ID, window and origin still match, reinstalls their rules and reloads them (fresh content scripts). `onStartup` (browser start) drops the backup: tab IDs restart. Not covered by e2e: an unpacked extension loaded with `--load-extension` does not come back after `runtime.reload()` under Playwright.
- **Set-Cookie capture** in `onHeadersReceived` and `onBeforeRedirect` (`extraHeaders`, deduplicated per requestId+URL+status), only for container tabs. A response is not imported when its request was sent before the tab's rules were active, or (within 1 s of activation) carried a Cookie header with anything but container cookies: it went out as the real profile.
- **Stale-hop detector, by header not by clock.** Measured: a 302 hop whose `onSendHeaders` fired 0.6 ms AFTER `updateSessionRules` resolved still went out with the old rules. So the detector records the Cookie header actually sent (`onSendHeaders` + `extraHeaders`, main/sub frames) and re-navigates a GET main-frame request sent within `[change, rules + 1 s)` whose header lacks the changed cookie. Also measured: `tabs.update` to the same URL while that hop was still in flight produced no request at all, so the re-navigation waits for the stale request to complete (max 3 s) and is skipped if the tab moved on. At most once per change window per (tab, URL) and 3 per tab per 10 s.
- **Tab inheritance.** Measured: tabs created over CDP (Playwright `newPage`, like Ctrl+T) carry `openerTabId` of the active tab; inheriting on it put "plain" tabs into containers. Now `tabs.onCreated` inherits only the shim's own `about:blank#facet-<nonce>` child; everything else page-initiated (links, forms, context menu, `window.open` outside the shim) comes from `webNavigation.onCreatedNavigationTarget`. Bookmarks, omnibox and Ctrl+T never inherit (Firefox behaviour).
- **`window.open` / links.** The shim opens `about:blank#facet-<nonce>` with the page's target and features (returns the WindowProxy synchronously), the background assigns the child and answers `await-child`, then the shim calls `w.location.replace(url)`; fallback after 800 ms. `noopener`/`noreferrer` and plain `target=_blank` links (implicit noopener) are opened by the background (`about:blank` tab, assign, then navigate; `openerTabId` set). Side effect: such tabs get no `Referer`. `rel=opener` and named targets keep the `window.open` path. Ctrl/Cmd/Shift and middle clicks open background tabs the same way.
- **Fetch barrier.** In container tabs `fetch` and async XHR wait (max 1 s) for pending `document.cookie` writes to be acknowledged (the background replies after the rules are installed), and each response waits (max 400 ms) for a `settle` round trip: the background lets queued webRequest events run, waits for pending Set-Cookie work of the container and the rules flush. This makes "XHR login, then fetch" deterministic at the cost of one message per response. Sync XHR is not gated.
- **Keepalive.** Top frames of container tabs ping the worker every 25 s so Set-Cookie handling does not pay a cold start.
- **SW-free zone.** Origins committed or navigated to in container tabs become managed sites (`storage.local`, registrable domains). Their service workers are removed with `browsingData.remove({origins}, {serviceWorkers: true})` (throttled 30 s per origin). Cache Storage is NOT wiped: it would erase the containers' own namespaced caches, and a cache without its worker serves nothing. Non-container tabs learn about managed sites through a dynamic DNR rule answering the beacon with `{m:1}` (`initiatorDomains`), which survives browser restarts. A container page that is nevertheless controlled by a worker unregisters it and reloads once.
- **Static default beacon answer.** A static ruleset answers the beacon `{}` (priority 900) so the content script's XHR never reaches the network (a local server on port 80 would otherwise see every page load), even before the worker starts. (Since 2026-10-13 the ruleset is disabled while no content script is registered.)
- **`open.html`** is an unlisted page, NOT web-accessible: browser-initiated navigations (omnibox, `tabs.update`, CDP, agents) reach it, web pages cannot use it to create containers. Unknown names create the container.
- **`#ctr=<name or id>`** is handled on `onBeforeNavigate` and `onReferenceFragmentUpdated` (main frame): assign the tab to that container, navigate to the URL without the marker (other fragment parameters kept). Only EXISTING containers: any web page can put the marker in a link, so it must not create containers (`open.html`, unreachable from pages, does). The marker's own request goes out as the real profile (accepted, see limits).
- **`deleteContainer` closes the container's tabs** (as Firefox does) and drops jar and rules. Namespaced page storage stays in the origins (no API removes keys by prefix).
- **API** for extension pages via `runtime.sendMessage({type: 'facet/api', method, args})` (`src/engine/api-client.ts`), refused for content scripts; the same object is `globalThis.facet` in the worker for tests.

### Content scripts
- Built as WXT unlisted scripts (`beacon.js`, `shim.js`, anonymous IIFEs) and registered at runtime with `scripting.registerContentScripts`, ISOLATED beacon first then MAIN shim, `document_start`, `allFrames`, `matchOriginAsFallback`, `matches: ["<all_urls>"]` (idempotent on every worker start). Trade-off: every frame of every tab runs one sync beacon XHR (answered locally by DNR in about a millisecond) and parses 25 KB of script; in tabs without a container the shim installs nothing. Narrowing `matches` to managed sites is left for later.
  (Superseded 2026-10-13: registered only while containers are in use, see "Content scripts only while containers are
  in use".)
- `tldts` is aliased to a 60-line stand-in in the beacon bundle only (`src/content/tldts-lite.ts`): 11 KB instead of 274 KB for a script that runs in every frame. The beacon's local `document.cookie` view is optimistic; the background (full PSL) is authoritative and corrects it in the write reply.
- **Bridge.** The beacon appends `<facet-bridge>` to `<html>`; the shim detaches it before any page script runs, so only the two worlds hold the node. Requests are synchronous CustomEvents (string detail, answer in an attribute); pushes go the other way. The page never sees the cross-host snapshot, and the background derives tab, origin and container from `sender`, never from the message.
- **Shim modes:** container (everything namespaced, see limits.md), managed (no container on a managed site: `__facet:` names hidden, explicit requests for them quarantined, SW registration refused), plain (nothing patched). Patches replace prototype properties (no `delete`), keep `name`/`length`, and report native source through a `Function.prototype.toString` proxy. Same-origin child windows reached through `contentWindow`, `contentDocument` or `window.open` get the same patches on access.
- **`data-ctr`** (container name) is set on the top document only, for agents.

### E2E
- Playwright 1.64, its Chromium 156 build (`pnpm exec playwright install chromium`), `launchPersistentContext` with `--load-extension`, headless. One browser per worker, fresh containers per test, real-profile cookies cleared before each test. The stand (`test-server/server.mjs`) serves `a.`, `sub.a.`, `b.`, `sso.`, `cdn.`, `nosw.localhost` on one port.
- Worker restart: CDP `ServiceWorker.stopAllWorkers` from a page session does not stop extension workers; `Target.closeTarget` on the worker target does. Opening a tab to issue it would wake the worker again (`tabs.onCreated`), so the test drives CDP through an existing page. Playwright re-binds the same `Worker` handle to the restarted worker; the test proves the restart with a marker global.

## Stage C (2026-10-09): interface, domain rules, tab groups, indicators

Measured in Playwright's Chromium 156 (headless) unless noted. Written by the implementing agent without access to the owner; every item below was a judgement call.

### Structure
- **The engine got one additive hook**, nothing else: `Facet.events` (`src/background/events.ts`) emits `tab-assigned`, `tab-unassigned`, `tab-replaced`, `container-updated` and `container-deleted` from `assign`, `unassign`, `handleTabReplaced`, the post-update restore, `updateContainer` and `deleteContainer`. Everything new (`Extras`: settings, rules, exemptions, tab groups, badges, rule engine) subscribes to it; the engine does not know about any of it. `assign` returns early when the tab is already in the container and then emits nothing, hence the API-level `assignTab` marks the placement itself.
- **API**: `FullApi = FacetApi & ExtrasApi` (`full-api.ts`); `facetApi` (extension pages) and `globalThis.facet` (tests) are the full API, and `listeners.ts` dispatches over the union of both method lists. New methods: `getSettings`, `updateSettings`, `listDomainRules`, `setDomainRule`, `removeDomainRule`, `exportData`, `importData`, `regroupTabs`, `newTabInContainer`, `applyChoice`. `assignTab` is wrapped (see Domain rules).
- **Storage** (`storage.local`): `settings` (`{tabGroups, titlePrefix}`), `domainRules` (list of `{domain, action, containerId?}`). `storage.session`: `ownedGroups` (Chrome group ID -> container), `ruleExemptions`. The plan put `domainRules` on the container; a separate list keeps one rule per site and survives containers being deleted and re-created. Rules naming a deleted container are pruned.
- **Settings reach the title-prefix content script through `storage.local` directly** (`storage.onChanged`), not through the background: no message, no wake-up of a sleeping worker, and the page reacts at once. Container renames are pushed by `tabs.sendMessage` (`facet/renamed`).

### Domain rules (`always` / `ask`)
- **Key**: the registrable domain (eTLD+1; for `a.localhost`-style hosts and IP addresses, that host). Typed input is reduced to it ("https://www.GitHub.com/login" -> `github.com`); public suffixes (`com`, `github.io`) are refused.
- **Re-navigating a tab to the same URL while its first request is in flight works** (measured: e2e "moves a plain tab" shows the container's login on the final page). The engine assigns the tab, waits for the rules, `tabs.update`s the same URL. The stage-B note about `tabs.update` being ignored concerned a redirect hop in flight, not a fresh navigation. The first request still goes out unisolated (documented hole); a stray `Set-Cookie` from it is not imported (assignment time check in `harvest`).
- **Rules must not fight deliberate choices.** Without exemptions, "Reopen in Personal" on a site with a rule for Work would be undone at once, and an OAuth popup of a Personal page would be sent to Work. Model (`core/exemptions.ts`, persisted in `storage.session`): every assignment emits `tab-assigned`, which marks "the tab's next main-frame navigation is part of this placement"; the site of that navigation stays exempt while the tab stays on it and in that container; visiting another site, or changing container, ends it. Taking a tab out of its container (API `assignTab(id, null)`) is a placement too. `#ctr=` URLs are skipped by the engine and mark the placement for the repeated navigation.
- **Children of a container tab** are not judged for five seconds. Facet inherits asynchronously and the child's first navigation (and the stale-cookie re-navigation after it) can start before the placement event fires, while the registry already says "container A": the first version of the guard compared registry state and failed under load, in the full suite only. The rule engine now keeps its own 5-second record of children (`onCreatedNavigationTarget`, parent in a container) and skips them while they are unassigned or in the parent's container. A mutation check (disabling this guard) makes the "`<form target=_blank>` child keeps its container" e2e fail.
- **`ask`**: `tabs.update` to `choose.html?url=<encoded>&tab=<id>`. The page lists containers plus "Open without a container" and a "Remember my choice" switch. Choosing calls `applyChoice`: remember + container = rule becomes `always <container>`; remember + no container = the rule is **deleted** (no rule means "leave it alone", which is what "stop asking" means); then the tab is placed and the page does `location.replace(url)`, which the placement exempts. Without "remember", a rule `ask` asks again on the next visit.
- **Loop guards**: placement-before-navigation (the repeated navigation finds the right container), exemptions, and at most four rule actions per tab per ten seconds.
- **Prerender** navigations (`documentLifecycle: 'prerender'`) and subframes are ignored.

### Tab groups
- **Superseded in part (2026-10-11, see "Dragging a tab into a SplitSession group" at the end): dragging a tab INTO a group that carries a container's marker now reopens it in that container; since 2026-10-13 ("Tabs inside a SplitSession group: the group tells the truth") every tab inside such a group is in its container, however it got there.** The rest of this section stands: taking a tab out of a group, or into a group that is not SplitSession's, leaves its container alone.
- **Chosen (original): leave tabs alone** after the user moves them. Re-grouping on every `groupId` change would fight the user (they could not drag a tab out), and nothing may ever infer a container from a group. Groups are rebuilt only on assignment, window change (`tabs.onAttached`), container rename/recolour, the setting being switched on, and the explicit "Re-group tabs" action (popup footer, `regroupTabs`). Verified by e2e: ungroup a tab, put another into a foreign group, wait, nothing changes; `getTabContainer` is the same throughout.
- One group per (window, container); Chrome deletes empty groups itself. Groups Facet made are tracked by ID (`ownedGroups`), so turning the setting off ungroups exactly those and never a group the user made. All group operations run on one queue (two tabs assigned together share one new group) and retry for ~1 s while Chrome refuses edits during a drag. Pinned tabs are skipped.
- Colour mapping container -> Chrome group: turquoise -> cyan, others by name. Container colours are Firefox's palette (hex in `core/indicators.ts`).

### Indicators
- **Badge**: initials of the first two words ("Work" -> `Wo`) on the container's colour, with black or white text by luminance (superseded 2026-10-11: now a colour dot, see the end of this file). **Chrome resets a tab's badge on navigation** (measured: `setBadgeText` on a tab, then a cross-origin navigation, text is empty), so it is re-applied on `webNavigation.onCommitted` (main frame), `tabs.onUpdated` (`loading`/url) and `tabs.onActivated`.
- **Title prefix** `[name] ` is applied by the ISOLATED beacon script (`src/content/title-prefix.ts`, started from `beacon.isolated.ts` for the top frame of container tabs only; beacon bundle +1.5 KB). It observes the root (until `<head>` exists), `<head>` (children) and `<title>` (children, text), so a title set by `document.title`, by editing the element, by replacing it, or created late is caught; a title that already starts with the prefix is left alone (never doubled); a rename swaps the old prefix for the new one. Empty titles stay empty. After 25 rewrites in 3 seconds the script gives up on that document (a page that undoes the prefix in a loop).
- `data-ctr` is unchanged.

### Interface
- **Preact 11 + plain CSS** (two shared files, `theme.css` tokens and `components.css`, plus one per page). No CSS Modules (no benefit for ~600 lines), no UI library. Main text 16 px, secondary 14 px, nothing smaller: asserted by an e2e test that walks every text node of the four pages in both colour schemes (it also asserts no `select`, `dialog`, date/time/colour/number inputs, every `form` has `novalidate`, no JS dialog).
- **Components** (all with ARIA roles and keyboard): `Switch` (`role=switch`), `Checkbox` (`role=checkbox`, a button, not `<input type=checkbox>`), `ColorPicker` (radiogroup, roving tabindex, arrows/Home/End), `MenuButton` (menu / menuitemradio, Arrow/Home/End/type-ahead/Esc/Tab), `Select` (select-only combobox + listbox with `aria-activedescendant`, a `div`, not a button, so Space/Enter do not double-fire), `Dialog`/`ConfirmDialog` (modal, focus trap, Esc, focus restored, safe button focused first), `TextField` (live inline message, counter, sanitising). Popovers are `position: fixed`, flip upward and clamp to the viewport, so a scrolling list cannot clip them.
- **Buttons are not disabled while a request runs** (a disabled focused button loses focus and Chrome does not give it back; found by an e2e test). Handlers guard against double submits instead. Permanent states (no tab, invalid form) still use `disabled`.
- **Name validation** (`core/names.ts`): trimmed and whitespace-collapsed, at most 32 characters in the UI (the store accepts 64 so names created over the API round-trip; imports accept 64), control, zero-width and bidi characters never enter the field, duplicates are case-insensitive and reported as the user types; an empty field is reported after the first blur or submit. The site field of a rule is validated the same way (`normalizeRuleDomain`) and shows what it reduces to.
- **Popup**: acts on the active tab; `?tab=<id>` overrides it (tests open the popup as a normal tab). "New tab" asks the background to open Chrome's new tab page and assign it (`chrome://newtab/`, `about:blank` if that fails): the user types an address into the omnibox and it is requested as the container. It is done in the background because the popup closes the moment the new tab takes focus. The popup then calls `window.close()` as well.
- **Options** uses `open_in_tab`. The one native control left is a visually hidden `<input type=file>` (the OS file picker cannot be replaced); the visible control is a custom button. Export downloads through a Blob link.
- **Export/import**: format `facet-export` version 1 (`containers`, `rules`, optional `jars`), strict validation (first problem rejects the whole file, with a message), 20 MB cap. Import matches containers **by name**, keeps existing ones unchanged (colour too), creates missing ones, replaces rules of the same site, merges cookies when the file has them. The UI parses the file itself first and shows a plan ("create 1 container, keep 1, set 2 rules, add 1 cookie") before anything changes. The cookie checkbox is off by default and its warning appears when it is ticked.
- **Choose page**: non-web or missing `url` gives a calm "nothing to choose" notice. `choose.html` and `state.html` are unlisted (not web-accessible), like `open.html`.
- **state.html** is plain DOM (no framework), text-first, single spaces between `key=value` pairs so `innerText` and `get_page_text` agree, re-renders on tab events.

### Icons
- `assets/icon.svg` (three stacked rounded cards in container colours, front card with a light facet) rendered by `scripts/make-icons.mjs` with Playwright's Chromium to `public/icons/icon-{16,32,48,128}.png`, which are committed; manifest `icons` and `action.default_icon` point at them. `Logo.tsx` repeats the drawing.

### Tests and tooling
- The e2e fixture now resets domain rules and settings before every test (they outlive a test in the shared browser), and `tabIdOf` finds a tab by a title that *ends with* its marker (container tabs carry a prefix).
- `pnpm zip` already existed (WXT) and produces `.output/facet-0.1.0-chrome.zip`.

## Security fixes after the isolation review (2026-10-09)

An independent review found three problems; a fourth (the beacon identifier) was reported separately.
Each has a permanent e2e test in `e2e/security.spec.ts` that failed before the fix; the review's throwaway repro files
(`docs/review-repros/`) are gone. Measured in Playwright's Chromium 156 (headless) unless noted.

### 1. Service workers of the real profile (blocker)
- **Measured first**: a session rule with `tabIds: [-1]` (`tabs.TAB_ID_NONE`) is valid and matches the fetches a
  service worker makes for the pages it controls (probe: a network-first worker's navigation fetch got the `-1` rule's
  header). Such requests can never carry container cookies (container rules list real tab IDs only); without a rule
  they carry the real profile's cookies and their `Set-Cookie` lands in the real profile.
- **Strict mode** (setting `strictMode`; since 2026-10-11 a plain setting, default **off**, see "Strict mode as a plain
  setting" below), logic in `src/engine/strict-mode.ts`. Turning it on: `browsingData.remove({}, {serviceWorkers:
  true, cacheStorage: false})` once, then a dynamic DNR rule answers the beacon `{g:1}` for every frame (priority 920:
  above the static `{}`, below managed `{m:1}` and container answers), and the shim's new **guard** mode refuses
  `serviceWorker.register` and patches nothing else. The sweep is repeated on browser start and after an update, for
  pages that ran before the scripts did. Measured: dedicated workers have no `navigator.serviceWorker` in Chromium 156,
  so they are no way around the guard.
- **~~When the interface asks~~** (superseded 2026-10-11: there is no consent prompt any more, see below).
- **No-tab rule** (session rule key `@no-tab`, compiled by the engine like a container): in strict mode (setting on),
  `tabIds: [-1]` + `requestDomains: <managed sites>` strips `Set-Cookie`, priority 1. Chosen over also
  stripping `Cookie`: that would log out the real profile's shared workers and other extensions on those sites, and the
  worker case it guards against no longer exists once strict mode is on. Not applied without strict mode (the user chose minimal
  interference).
- **Every navigation Facet starts awaits `ServiceWorkerPolicy.prepare(origin)` first**: marks the site managed (and
  waits for the `{m:1}` rule), then `browsingData.remove({origins: [origin]}, {serviceWorkers: true})`, deduplicated
  while in flight, 2 s throttle (the background `noteContainerOrigin` keeps 30 s). Wired into `openInContainer` (API,
  popup/`target=_blank` children via `facet/open-tab`), `facet/await-child` (the shim now sends the target URL; the
  `window.open` child is navigated after the reply, or after the shim's 800 ms fallback), `open.html` (new API `prepareNavigation` before
  `location.replace`), domain-rule moves, `applyChoice` (choose page), `#ctr=`, stale-hop re-navigations, "Reopen in"
  reloads and the post-update restore. **Not** for "New tab in…": the address is typed into the omnibox later and
  Facet never sees it before the request; strict mode covers it.

### 2. SameSite (blocker)
- Measured: DNR `domainType` compares the request with its initiator; a navigation **without initiator** (CDP
  `Page.navigate`, `tabs.update`) and one started by an extension page are `thirdParty`. A same-site
  `location.href` navigation is `firstParty`; a cross-site iframe document request is `thirdParty`.
- Per matcher (WIDE / EXACT, secure and http bands) the compiler emits: `firstParty` all cookies; `thirdParty`
  `SameSite=None` only; `thirdParty` + `main_frame` + `requestMethods: ['get']` one step higher with None + Lax +
  unspecified. All-None hosts keep one rule without `domainType`; the GET rule is skipped when it would equal the
  third-party one. Every category is always covered in the http band (an empty list removes the header), otherwise the
  secure-band rule (with Secure cookies) would answer plain http.
- Priorities: four steps per label (`10 + 4*labels` WIDE, +1 its GET rule, +2 EXACT, +3 its GET rule); http band moved
  from 200 to 300 so the bands still cannot overlap (max 265 below). The regex budget is spent per emitted regex rule
  (up to three per EXACT matcher); when a matcher's split does not fit, it falls back to URL filters.
- Typed navigations therefore do not carry `Strict` cookies (Chrome sends them). No DNR condition matches "no
  initiator", so this is accepted and documented: such a first load looks like arriving from a link.
- The stale-hop detector ignores `Strict` cookies (a cross-site navigation lacks them by design). The beacon's
  `document.cookie` view in a frame of another site than the top document shows `SameSite=None` cookies only.
- The DNR test simulator learned `domainType` (no initiator = third party, as measured) and `requestMethods`.

### 3. `#ctr=` from pages
- `onReferenceFragmentUpdated` is no longer handled at all. `onBeforeNavigate` asks `Facet.ctrDecision`, which accepts a
  marker only for an existing container, a tab without a container, and a main-frame request whose `initiator`
  (`webRequest.onBeforeRequest`, frames only, non-blocking) is absent or `chrome-extension://…`. Measured: `tabs.update`
  from an extension reports the extension's origin as initiator, so agents (Claude in Chrome) and Facet's own pages
  must count; a page cannot produce such an initiator. Measured too: history entries keep their initiator, so neither
  `history.back()` nor the browser's Back button to a page-made marked entry is honoured.
- The decision waits up to 2 s for the request (either event can come first) and is cached per navigation
  (`tabId + timeStamp + url`), shared with the domain-rule engine, whose `markerContainer` is now async: a marker
  Facet ignores is judged by the rules like any URL.

### 4. Beacon identifier
- Per-install secret (32 random bytes, `storage.local.pageKeySecret`, hex). Page key = first 80 bits of
  HMAC-SHA-256(secret, `<containerId>|<registrable domain>`) in lowercase base32 (`src/core/page-key.ts`, synchronous
  SHA-256 checked against Node's crypto in unit tests, because the compiler is synchronous). Not exported (a new
  install has new keys).
- The beacon never carries the container ID: per-site rules (`initiatorDomains: [site]`) answer `{c: key, n?, k, s}` for
  every site with cookies **and every site the container's tabs load frames from** (recorded in
  `webRequest.onBeforeRequest` for main and sub frames, so the rule is usually installed before the response); the
  generic rule answers `{p: 1}`. A frame that gets `{p: 1}` sends `facet/need-site` and polls the beacon synchronously
  for up to 1 s (measured: the message leaves while the frame's main thread is blocked; the e2e test removes a site's
  rule and the frame still ends up in the right namespace). Failing that: a throwaway key.
- Storage namespaces are `__facet:<key>:` now; data under the old `__facet:<containerId>:` prefixes is abandoned (no
  migration: the old prefix is exactly the cross-site identifier being removed).
- **"Show the container name to pages (for AI agents)"** (setting `showNameToPages`, default on): the name goes into
  the beacon only when on; `data-ctr` and the title prefix appear only with a name. Switching it off removes both from
  open pages at once (`storage.onChanged` in the content script); the title-prefix switch is disabled while it is off.
- The engine reads `settings` from storage itself at start (before compiling any rule, so a name is never exposed in
  the window before Extras loads) and gets later changes through `Facet.applySettings`, serialised so the API's
  `updateSettings` resolves after the rules reflect the change.

### Tests
- e2e fixture: every test starts with strict mode on (`updateSettings({strictMode: true})`), the steady state; tests of
  the other states switch it themselves. The SharedWorker/service-worker test of plain tabs on unmanaged sites runs with
  strict mode off. The cross-site iframe cookie test now uses a `SameSite=None` cookie and checks a Lax one stays out.
- Test stand: `/swnet.js` + `/swnet-page` (network-first worker, from the review) and `/link?to=&target=` (a link and
  a POST form to any address).

## Security fixes after the second review (2026-10-09)

The second independent review found a blocker: a page could reach a same-origin realm Facet's
shim never ran in, a sandboxed frame without `allow-scripts`, and through it (rv4) read and write the real profile's
`document.cookie` and `localStorage` from a container tab, and (rv3) register a service worker in strict mode, after
which a link in a container tab logged in with the real profile's session. A second point was reported separately: the
container name was exposed to pages by default. Permanent e2e tests: `e2e/security.spec.ts`, describe "frames whose
scripts are disabled", plus the updated "leftover real-profile worker" test; each failed on the code before the fix.
Measured in Playwright's Chromium 156 (headless).

### Measured first
- Chrome runs **every ISOLATED content script before the MAIN ones** at `document_start`, whatever the registration
  order (order seen: beacon, a third ISOLATED script, then the shim). A "seal" script registered after the shim to
  check that the shim ran is therefore impossible; a microtask queued by an ISOLATED script also runs before the shim.
- In a sandboxed frame without `allow-scripts` the ISOLATED beacon runs, the MAIN shim does not. The initial
  `about:blank` of an ordinary iframe gets the shim synchronously on insertion (the old note in limits.md that
  `frames[0]` right after insertion is unpatched was out of date); that of a sandboxed one does not.
- Patching a realm from a same-origin realm works whatever the target's sandbox flags (functions from the patching
  realm run fine there).
- A service worker's script is fetched as `script` with tab ID -1 and a `Service-Worker: script` header; a shared
  worker's main script as `xmlhttprequest`, tab ID -1.
- **Navigation commit gap**: when a same-origin frame navigates, its new document exists (readyState `loading`, no
  `<html>`) for at least one task before content scripts run. A tight `MessageChannel` poll of `window[n]` read the
  real profile's cookie and `localStorage` once per navigation, 10 of 10, for ordinary and sandboxed frames alike.
  Pre-existing for every same-origin frame.

### 1. Realms without the shim (blocker)
- **Parent-side patching (`FrameGuard`, `src/content/shim.main.ts`)** in every mode (container, managed, guard): one per
  bridge, it keeps every same-origin window reachable from its realms patched with the same `Shared` (bridge and
  namespace), so the adopted realm shows exactly the adopter's own view. Triggers: every DOM insertion method
  (`appendChild`, `insertBefore`, `replaceChild`, `append`/`prepend`/`before`/`after`/`replaceWith`/
  `replaceChildren` on all their interfaces, `insertAdjacentElement/HTML`, `innerHTML`/`outerHTML` setters,
  `setHTML(Unsafe)`, `document.write/writeln/close/execCommand`, `document.body`, `Range.insertNode/surroundContents`,
  `moveBefore`) sweeps right after inserting; a `MutationObserver` on every patched document sweeps before the next
  parser-inserted script runs (the parser performs a microtask checkpoint before each script); the `frames`, `self`
  and `length` getters sweep; `contentWindow`, `contentDocument`, `getSVGDocument()` (iframe, frame, object, embed),
  `Document.defaultView`, `opener`, `MessageEvent.source`, `UIEvent.view` and `window.open` adopt what they return.
  Indexed access on `window` (`window[0]`) cannot be intercepted; the insertion hooks and the observer patch the frame
  before that matters. The sweep uses the native `length` getter captured before page scripts (`length` is
  `[Replaceable]`) and checks each window proxy once (one caught exception for a cross-origin frame).
- **Beacon side (`src/content/seal.isolated.ts`)**, since a seal after the shim is impossible: the beacon of every frame
  with a bridge, before any script can touch its new realm, asks a **same-origin parent** to patch it (`facet:adopt`
  with its index, mode and key; the parent accepts only when its own mode and key are equal, i.e. its view is the one
  the frame would have). A frame whose shim then runs finds its realm patched and keeps the parent's bridge, which
  lives as long as the frame (chosen over a rebind handshake: passing a capability between two shim instances in one
  page cannot be hidden from the page). On the next task (`MessageChannel`, timer as fallback), a bridge still in the
  document means the shim never ran: it is removed and every same-origin window of the frame tree and of the opener's
  tree is asked to sweep (cousins of a cross-origin parent, top-level documents with a `sandbox` CSP). A shim that
  starts also sweeps its whole tree once, for sandboxed realms that existed before it.
- **Rejected for the commit gap**: no extension API runs code between commit and `document_start`
  (`registerContentScripts`/`userScripts` start at `document_start`; `executeScript` and `webNavigation` are
  asynchronous). A `pagehide` listener in the old document plus a `user-blocking` task does not help: an attacker can
  hop through a cross-origin document (no hook there) and has high-priority task sources of its own. Forcing an opaque
  origin on same-origin subframes (`Content-Security-Policy: sandbox` via DNR) would break every same-origin iframe
  app. Wrapping every callback entry point of the page to re-check its frames is too invasive. Documented in
  limits.md as the remaining hole, with its measured size.
- **Strict mode, network layer**: the no-tab session rule now removes the request `Cookie` as well as `Set-Cookie` on
  sites containers use (this reverses the earlier choice to keep `Cookie`: a worker that answers a container tab's
  navigation must not carry the real session in, which is what rv3 showed). After the OK a second session rule blocks
  every `script` request with tab ID -1 on every site, so no service worker can be installed by any realm (verified
  with a CDP isolated world, which the shim never patches). Recompiled when the guard changes
  (`ServiceWorkerPolicy.onGuardChanged`). Costs in limits.md; the browser-initiated ones (Google's session refresh)
  are flagged for a manual check.

### 2. The container name is no longer shown to pages by default
- `showNameToPages` defaults to `false`: the name is one identifier on every site (beacon `n`, `data-ctr`, title
  prefix). The options page keeps the switch with the privacy explanation; README and docs/agents.md tell agents to
  switch it on.
- **Migration**: the stored settings now carry `explicit`, the keys a patch ever named; keys never set follow the current
  defaults. The previous format stored every value on any change, so a `true` cannot be told from the old default:
  every old default was `true`, hence a stored `false` is kept as a choice and a stored `true` is read as "never set".
  For `showNameToPages` this means an install that had switched the name on explicitly gets it off once (the price of
  not being able to tell; agents switch it on again). `SettingsStore.load` rewrites the old format once; the engine and
  the title-prefix script read both formats through the same `readSettings`.

### Tests
- `e2e/security.spec.ts` "frames whose scripts are disabled": the reviewer's rv4 (read and write through
  `window[n]` of a sandboxed frame, before and after load, `contentDocument`, the frame's native `cookie` getter called
  on the container's document, `srcdoc` via `innerHTML` read in the same task, a frame inside the sandboxed frame,
  a re-navigated frame), `<object>` with same-origin HTML, a sandboxed cousin under a cross-site parent, an opaque
  sandbox (neither side reaches storage), and rv3 (sandboxed `register()` own and borrowed, an unpatched CDP world, then
  the container login through a link lands in the container). The commit gap is measured by a probe kept out of the
  suite (a test asserting a hole would be odd); its numbers are above.
- Screenshot script: grants strict mode before shooting (the usual state); options screenshots refreshed.

## Security fixes after the third review (2026-10-09)

The third independent review found two things. Permanent e2e tests in `e2e/security.spec.ts`
("a tab moved into a container has no opener" and the strict-mode "session refresh" test); each failed on the code
before the fix (verified by building the old `src/` and running them).

### 1. A tab moved into a container by a domain rule or the choose page kept `window.opener`
- Cause: `DomainRuleEngine` assigned the SAME tab and navigated it again (`assign` + `tabs.update`), and
  `applyChoice` did the same for the choose page. A plain page that did `w = window.open('/whoami')` held `w` for the
  tab after the move and read from it the container's user, `document.cookie`, `localStorage`, and could
  `w.fetch(...)` with the container's HttpOnly session: a deterministic link between the real profile and a container.
- Decision (as in Firefox): **every** move of a tab into a different container, or out of one, opens the address in a
  fresh tab and closes the old one. Facet cannot see every opener (`openerTabId` is the tab-strip relation, not
  `window.opener`; a popup's opener may not be reported), so there is no "only when it has an opener" branch.
  `Facet.replaceTab` creates the tab with `tabs.create` at the old tab's window, index, pinned and active state,
  without `openerTabId`; for a container it goes through `openInContainer` (about:blank, assign, service-worker
  removal for the target, then navigate), for "no container" it creates the tab, runs the callback and navigates.
  Creating first and closing the old tab after means nothing is lost if the container's rules cannot be installed.
- The engine keeps its guards: the callback (`onCreated`, after assignment and before the navigation) marks the new
  tab's site as exempt and **copies the old tab's action history**; without the copy a chain of client-side redirects
  between ruled sites would get a new tab, and a fresh limit, per hop. The existing 4-in-10-seconds limit and the
  loop-safe exemptions are unchanged.
- Choose page: `applyChoice` returns `{ replaced }`. When the chosen container differs from the tab's current one,
  the address opens in a fresh tab and the choose tab is closed 150 ms later (after the reply, or the page would get
  a closed-port error). When it is the same (including plain to plain) the page navigates itself as before, and keeps
  its opener, which is harmless: same identity.
- Unchanged on purpose: a popup or `target=_blank` link of a container page into the SAME container keeps its opener
  (OAuth popups, `postMessage`). e2e: `navigation.spec.ts` and the new "SAME container" test.
- Costs, in limits.md: tab ID changes, history and scroll are not carried over, a user tab group is left, the opener
  sees a closed window.
- **Not fixed (flagged):** the popup's "Reopen in container" and the API's `assignTab` still assign the existing tab
  and reload it, so a tab with an opener keeps it there. The user asked for that move on that tab, and changing it
  needs a new API and rewriting the popup tests; it is the same hole and should get the same treatment next.

### 2. Strict mode's no-tab rule stripped `Cookie` from every tab-less request to a container site
- Cause: `compileNoTabRule` matched `tabIds: [-1]` + `requestDomains: <container sites>` with no initiator condition.
  Browser-initiated requests also have tab ID -1: a background session refresh of an account in the real profile
  (Google's device-bound session credentials) goes to a site a container also uses, loses its `Cookie`, and the real
  profile may be signed out.
- Fix: `initiatorDomains: <the same sites>`. A service worker's fetch has the worker's site as initiator (the existing
  leftover-worker e2e still passes with the rule narrowed, i.e. `fetch(e.request)` of a navigation keeps the site as
  initiator), requests of the browser itself have none and do not match.
- The worker-script **block** rule keeps no `initiatorDomains` (judged): it touches no cookies, so it cannot sign
  anything out; and its job is to stop a worker from being installed on sites no container has visited yet.
- Tests: unit tests of the compiled rule shape and, through the DNR simulator, of who matches (site initiator: stripped;
  none, extension or unmanaged initiator, or a tab request: untouched); e2e: the extension service worker's `fetch`
  (tab -1, extension initiator, so not a managed site) still carries the real profile's `Cookie` and its
  `Set-Cookie` lands in the real profile. A truly initiator-less request (Chrome's own) cannot be produced from
  Playwright; **a Google account must be checked by hand** (limits.md).

## Agent bridge (2026-10-09)

Built on an explicit product decision: a local MCP server through which the user's own agent (Claude Code, same
Mac) sees and operates Chrome tabs across all windows, container-aware. The user owns the machine, browser and accounts.

### Product
- **One all-or-nothing switch, off by default** (`agentBridge` setting). On: full access to every tab; off: no connection,
  no host process, no socket. No per-site lists in this version (docs/agents.md lists the ideas). The ON state is
  deliberately loud: the popup card turns amber (2 px border), a banner says "Agent connected — full access" with an action
  counter, and the switch is one click in the popup and in the options page. When the host is missing or the connection
  fails the card stays amber and says so, because the switch is still ON.
- "Connected" means the **host connection is live**, not that an agent session is attached: the MCP server connects per
  call, so the host cannot tell an idle agent from none. The wording "an agent on this computer can..." is the honest one.
- The setting is **not exported/imported** (transfer files carry containers, rules and optionally jars only), and the
  `facet/api` messages that change settings are accepted from extension pages only: a web page or content script cannot
  flip the switch.

### Transport
- **Native Messaging + Unix socket**, not a localhost WebSocket. A TCP port can be probed by every web page and by every
  user on the machine; Native Messaging is pinned by the browser to `allowed_origins: [chrome-extension://hapfikidacgfgnnajkgnaednpgnhmffk/]`
  (the ID is fixed by the manifest key), and the host double-checks the origin argument. The socket is 0600 in a 0700
  directory. One program, two modes: `host` (Chrome-launched) and `mcp` (Claude-launched), bundled by esbuild into one
  file with the MCP SDK inside (no `node_modules` at run time).
- The host speaks Chrome's length-prefixed JSON on stdio and newline-delimited JSON on the socket; the MCP server
  connects **per tool call**, so switching the bridge off and on never needs a Claude Code restart. Requests get global
  ids in the host (several clients are fine), a deadline (tool timeout 15 s inside the extension, +5 s in the host), and
  every pending request is answered with an error when the extension goes away. A second host does **not** take a live
  socket over (see "Several profiles" below); a host removes only its own socket (inode check).
- **Message sizes.** Chrome limits a message *from the host to the extension* to 1 MiB, and the other direction to 4 GiB.
  The spec called for "chunk or truncate" at 1 MiB; since the capped direction carries only small requests, the host
  **refuses** an oversized request with a clear error (tool arguments are also capped well below: code 200 KB, text 100 KB)
  and results are not chunked: they are bounded by `maxChars` (≤ 2,000,000) and screenshot size. e2e proves a 1.5 MB result
  gets through. No chunking protocol was added for a direction that does not need it.
- The extension keeps the port while the setting is on (a native-messaging port also keeps the service worker alive),
  reconnects with back-off 1, 2, 4 … 30 s, and an alarm (1 min) restarts it after the worker was stopped. "Host not
  found" is not retried by timer, only by the alarm and the "Check again" button (status `host-missing`, install command
  shown). The host sends `fatal` before exiting on its own errors, so the popup shows the reason. The host keeps a small
  log (`host.log` next to the socket: starts, stops, errors, never requests or content).

### Found while testing: the host must not live in ~/Documents
Started from a Chromium launched in the agent's environment, the launcher in the repository (`~/Documents/projects/facet/bridge/dist`) failed with
`/bin/sh: ...: Operation not permitted` and Chrome reported "Native host has exited". macOS (TCC) refuses, or prompts
for, a program that Chrome starts inside Documents/Desktop/Downloads. `pnpm bridge:install` therefore **copies** the bundle
and writes the launcher into `~/Library/Application Support/Facet/host/` and points the host manifest there. The
`claude mcp add` command keeps the repository path as specified (that process is started by Claude Code, which already
works in the repository); the cost is two copies, so the docs say to re-run the installer after changes.

### Extension side
- New permission `nativeMessaging` (install-time warning "communicate with cooperating native applications"); optional
  `userScripts` for the `run_js` fallback, requested by a button on the options page, never automatically. No `debugger`.
- Tools (docs/agents.md) are defined once (`src/bridge/spec.ts`: names, descriptions, JSON Schemas) and used for the MCP
  `tools/list`, for validation in the MCP server and again in the extension (`src/bridge/validate.ts`, a small JSON-Schema
  subset): what is advertised is what is enforced. The router is in `src/background/bridge/router.ts`.
- Page functions (`inject.ts`) run in the ISOLATED world of the top frame except `run_js`. `type` uses the prototype's
  native value setter (from the isolated world this bypasses a React-style instance tracker, so frameworks see the change)
  and fires `input` and `change`; `click` fires pointer/mouse events then `.click()`. `run_js` wraps `code` as an async
  function body with `new Function`; **the ISOLATED world cannot do that** (extension CSP, verified in e2e), so it is
  reported as such, and MAIN under a strict page CSP gives a clear error. Fallback: `chrome.userScripts.execute` runs the
  body as a function literal in the source (no eval) and a second call collects the result from a window slot.
- `open_in_container` goes through `Facet.openInContainer` (about:blank, assign, service-worker removal, then navigate),
  opens in the background by default (an agent should not steal focus), and does not create containers unless
  `createIfMissing` (a typo must not make an account). `navigate` on a container tab calls `prepareNavigation` like every
  navigation Facet starts. `assign_tab` goes through the placement-aware API and reloads by default; it has the known
  `window.opener` gap (flagged in the third review) and says so.
- `screenshot_tab` activates the tab, waits 250 ms, captures, and restores the previously active tab of that window;
  screenshots are serialised.
- **Log policy**: every tool call is logged as `agent action` {tool, tabId, host, ok, ms, error ≤120 chars}; never URL
  paths, page text, typed text or results. The counter lives in `storage.session` (survives worker restarts, resets when
  the user switches the bridge on).

### Tests
Unit: framing (partial and split frames, multiple frames per chunk, > 1 MiB, oversize and invalid input), line framing,
argument validation for every tool, the relay (ids, several clients, timeout, client gone, oversized request, extension
gone), the MCP socket client and the "off / not installed" messages, the router (with a fake browser) and the connection
state machine (status transitions, back-off, host-missing, fatal, worker restart). e2e (`e2e/agent-bridge.spec.ts`, 13
tests): the host manifest is written into **the test profile's own `<user-data-dir>/NativeMessagingHosts`** (Chrome reads
host manifests there), not into the system Chromium directory, so nothing outside the temp directories is ever touched
and cleanup is the profile's removal; the socket is in a private temp dir via `FACET_BRIDGE_SOCKET`. The MCP server is
driven with the SDK's `Client` over stdio against the local stand. The fixtures reset `agentBridge` to off for every test.

### Review follow-up: switching off mid-tool, several Chrome profiles (2026-10-09)
- **Abort on off.** `AgentBridge` owns an `AbortController`; its signal travels in `ActionMeta.signal`. It is aborted when
  the switch goes off and when the port drops (the answer has no reader either way), and replaced for the next connection.
  `serve` refuses to start a tool when the bridge is no longer enabled on that port. In the router, `live(meta)` is
  checked after `facet.ready`, after every tab lookup, before each `executeScript`, before the mutating steps that follow
  an `await` (`prepareNavigation`, container resolution/creation, the screenshot pause), in `waitForLoad` and the
  userScripts polling loop; `withTimeout` also rejects on abort, so the caller is answered at once. The error is
  "the Facet agent bridge was switched off; the action was not performed". Page-side scripts cannot be recalled (limits.md).
  e2e makes the lookup slow (patches `chrome.tabs.get` once in the worker), switches off during it, and proves the page
  did not change; a control run without switching off proves the click does happen.
- **Several profiles: first wins.** Taking a live socket (the old "newest wins") made the first profile's popup lie. Now
  the host probes the socket on start (`probe.ts`): connects = live host -> sends `{type:'busy'}` and exits without
  touching the socket; connection refused / not a socket = stale file -> removed and taken; `EADDRINUSE` at bind (two
  simultaneous starts) = busy. The extension shows status `busy`, stays in it between looks (no flicker), retries every
  10 s with no back-off growth (each look costs one short-lived process), and the alarm and "Check again" also look. A
  profile that was busy connects on its own when the other lets go: it is switched on there, so that is what the user asked for.
- **Telling profiles apart.** New read-only tool `bridge_info` (`profileLabel`, window/tab/container counts, version) and
  a profile name field in the options page, kept in `storage.local` (`bridgeProfileLabel`, one line, 40 characters), not
  in `Settings` (which is boolean-only and synced to the engine). No `chrome.identity` (no extra permission, no account
  e-mail exposed). `list_tabs` keeps its shape (an array); its neighbour tool carries the hint.
- Tests: unit (abort on off and on connection drop, busy state machine, router abort paths, `bridge_info`, label cleaning,
  `probeSocket` incl. a SIGKILLed process's socket), e2e (switch off mid-tool; second real Chrome profile on the same
  socket becomes busy, then connects when the first lets go; profile name from the options page). The e2e socket
  directory is `/tmp/fb-*` (short path; `$TMPDIR` on macOS is too long for the 104-byte limit).

### Fresh tabs stayed blank: navigate only after the initial about:blank has committed (2026-10-09)
- **Symptom.** `e2e/rules.spec.ts` ("always", "ask", "another container") failed intermittently, and with `--repeat-each=20`
  in 36 of 180 runs: the replacement tab made by `replaceTab` stayed at an empty URL (`status: unloaded`).
- **Cause: a product bug, not the harness.** `tabs.create({ url: 'about:blank' })` returns while the tab's own blank load
  is still pending. Facet then assigned the tab and called `tabs.update({ url })`; the request went out and even got its
  200, but the pending blank page committed over it ("loading about:blank", then `ERR_ABORTED` and `unloaded`). The same
  race sat in `openInContainer` (every "open in a container"), where it only lost against a fast machine. Ruled out with
  traces (`webRequest`, `webNavigation`, `tabs.onUpdated`): not the tab group projection, not the removal of the old tab,
  not the exemption window, not `followReplacement`.
- **Fix.** `Facet.createBlankTab` (used by `openInContainer` and the plain branch of `replaceTab`) resolves only after
  `webNavigation.onCommitted` reported the tab's main-frame `about:blank` (`handleCommitted` records it, with a waiter
  set; 3 s ceiling with a warning, so a lost event cannot hang an open). No sleeps. The registry entry is dropped on
  tab removal. `rules.spec.ts --repeat-each=20`: 180/180.

### Visible agent activity and a compact popup (2026-10-10)
- **Why.** With the bridge on, an agent reads and operates tabs the user is not looking at. The user asked to *see* it:
  highlight the tabs the agent touches. And the popup had grown past Chrome's 600 px cap (748 px with six containers and the
  bridge off, 972 px with the install help), so it already scrolled.
- **One injected function does all the page-side work** (`overlay.ts`, `pageActivity`, ISOLATED world, top frame,
  `scripting.executeScript`), including the title mark. It could have been the existing title-prefix content script, but
  that one runs only in container tabs and only when `showNameToPages` is on; the agent also works in plain tabs, so the
  mark has to work without any Facet content script. State lives on the isolated world's global, shared by every injection
  into the document. The background (`activity.ts`) only decides *what* to show (`TOOL_LOOK`: label, kind, and whether the
  title gets the eye: read-only tools only) and owns the badge.
- **Overlay design.** One `<facet-agent-overlay>` on `<html>` (not `<body>`: no `:last-child` surprises, no scroll
  container effects), `all: initial`, fixed, `pointer-events: none`, z-index 2147483647, **closed** shadow root. Styles go
  through the CSSOM and motion through the Web Animations API: a page CSP that blocks inline styles cannot blank it. A
  timer, not the animation's `finished`, removes the nodes, because a tab that is not drawn runs no animations. Page
  scripts can see that the element exists (a MutationObserver will notice), never what is inside. A top-layer `<dialog>`
  still covers it; not worth the popover-API machinery.
- **(Retired 2026-10-10, see "Agent session: glow, drawn glyphs, no title marks".)** **Title mark goes after the container prefix** (`[Work] 👁 Inbox`). Before it, the container script's "does the title
  start with my prefix" check would stack a second prefix; after it, both scripts converge whoever writes last. The mark is
  only removed when our own mark is where we put it (`applied`), so a page title that happens to start with an eye is never
  eaten. Write budget (25 per 3 s) like the container script: a page that fights it wins.
- **What the agent reads stays clean.** `get_tab_text`/`get_tab_html` drop the overlay element, our favicon link and the
  mark in `<title>`; `list_tabs` and every `title` field are given without it. (Superseded 2026-10-10 by "Review fixes"
  below: actions no longer write the mark at all, so `run_js` sees a clean `document.title`.)
- **Screenshots** hide the overlay (`visibility: hidden`, then two animation frames or 160 ms) right before
  `captureVisibleTab` and show it again in a `finally`. The e2e takes a control screenshot of the same page (pink border
  pixel) and then the tool's (white), and was checked to fail with the hide removed.
- **Badge**: "AI" on purple (`#ff2d95` pink until 2026-10-10, see "Quieter debugger" below), restored through `BadgeIndicator.apply` 150 ms after the page side faded. `close_tab` waits
  600 ms after showing "closing" so the user can see which tab goes. Nothing in `AgentActivity` can fail a tool: no
  scriptable page means badge only.
- **Setting** `agentActivity` (default on, like the other defaults: a never-set key follows the default). In the options page
  and in the "…" menu of the popup's bridge card (`menuitemcheckbox`, the first use of a toggle item in `MenuButton`).
- **Recent actions**: `BridgeState.recent` (five, newest first: time, tool, ok, tab title without our mark, host) is
  published through `storage.session` with the counter and shown in the popup. Never page content; the title is the tab's.
- **Popup density.** One row for the bridge when it is off, two when on plus the five actions; "This tab" is one row
  (dot, container, site, "Reopen in…" menu); container rows are 38 px; "Open state page" and "Re-group tabs" moved into the
  header's "…" menu (the footer is gone); the status line became a toast over the bottom edge (it used to reserve a line);
  the section headers are merged away. Only the container list scrolls, inside its own region; the form for a new container
  sits above it. Main text 16 px, secondary 14 px, as before. Typical state, six containers: 748 px -> 471 px with the
  bridge off; with the bridge on and five actions it needs no scroll at 600 px (e2e), where the old layout needed ~1000 px.
- **Tests.** Unit: tool-to-look mapping, badge restore and re-arm, setting off, unscriptable pages, router call order
  (touch before the action, hide/unhide around the capture, rectangle stripped from answers), recent list. e2e
  (`agent-activity.spec.ts`): overlay, mark and badge appear and fade; container prefix kept without doubling; page rewrites
  its title; pulse rectangle equals the element's; text/HTML/screenshots free of the overlay; setting off; chrome:// pages;
  the popup's list; `scrollHeight <= 600` with six containers, bridge on, five actions (light and dark), and the list
  scrolling alone with fifteen.

## Agent bridge: "full hands" through `chrome.debugger` (2026-10-10)
The user approved the `debugger` permission and asked for everything a Playwright-class agent can do, behind the same
single all-or-nothing switch (off by default, no per-site lists). Implemented and decided autonomously; this records why.

### Session manager (`src/background/bridge/cdp.ts`)
- **Attach on demand, then detach after an idle window** (5 s here; 60 s since 2026-10-10, see "a quieter debugger" below). A tool calls `CdpSessions.use(tabId, work)`; concurrent tools on
  one tab share one attach promise. The idle timer is re-armed by every action, so a burst of clicks is one session and
  one infobar episode. `watch` (≤ 30 min) and a viewport override (`pin`) keep the session; nothing else does.
- **Switch off = `detachAll()` first**, then the native port closes. A generation counter undoes an attach that was still
  in flight when the switch went off (it completes, sees the old generation, detaches, and the tool fails "switched
  off"). The router also checks the existing `AbortSignal` after the attach (`isLive`).
- **`canceled_by_user` is a revocation**: the user pressed Cancel on Chrome's infobar. That tab is not attached again for
  60 s (`REVOKE_MS`) and the agent is told to ask the user. Chrome detaches all of the extension's tabs on Cancel, so all
  of them are revoked, which matches the user's intent.
- **"Busy".** Chrome 156 lets several clients share a tab (verified: the extension attaches next to Playwright's own CDP
  connection). It refuses only a second attach *by the same extension*, which after a service-worker restart is our own
  forgotten session: Facet detaches it (an extension can only ever detach its own) and attaches again. Only if that fails
  is the tab reported "busy: another debugger is attached". Others are never force-detached (impossible anyway).
  `detachStale()` at worker start clears sessions a previous worker left behind (the infobar would otherwise stay).
- **Refused targets**: `chrome:`, `chrome-untrusted:`, `devtools:`, `view-source:` and other browser schemes, the Web
  Store, and every `chrome-extension:` page **including Facet's own** (the agent must not operate Facet's options/popup:
  strict mode, transfer, the bridge switch itself). Checked before attaching, so the agent gets a sentence, not a CDP code.
- **Domains**: `Page` (dialogs, frame navigation -> loader id for refs), `Network` (request list; small buffers, bodies
  never fetched), `Log` (browser messages), `Emulation.setFocusEmulationEnabled` (typing works in background tabs, as
  Playwright does). **`Runtime.enable` only during `watch`**: anti-bot scripts detect it (the console-serialisation trick),
  and the user's real accounts must not be flagged because an agent clicked a button. `Runtime.evaluate` and
  `callFunctionOn` need no enable.
- **Found while probing: `Page.enable` next to an already open dialog brought Chromium 156 down** (the browser connection
  closed; reproduced headless and headed, with Playwright holding the dialog). So every attach first sends a cheap
  `Runtime.evaluate("1")` with a 1.5 s limit; a page that does not answer (a modal dialog blocks its main thread) is
  detached again and reported ("a dialog may be open, ask the user"), never `Page.enable`d. Dialogs that open while Facet
  is attached arrive as `Page.javascriptDialogOpening`; input commands race that event, because Chrome holds e.g.
  `mouseReleased` until the dialog is answered, and the tool returns with a note instead of hanging.

### Tools (`src/background/bridge/cdp-tools.ts`, router)
- **`snapshot`**: `Accessibility.getFullAXTree` per frame, rendered by a pure function (`snapshot.ts`, unit-tested) in a
  Playwright-like format (`- button "Join" [ref=e12]`). Wrapper roles without names (`generic`, `none`, layout tables,
  `strong`...) are flattened, text runs merged, a field shows its value after a colon, links their URL (path only on the
  page's own origin). The main tree does not contain iframe documents: for each `Iframe` node, `DOM.describeNode` gives the
  child frame id; same-process frames are read with `getFullAXTree({frameId})`, out-of-process ones through flat child
  sessions (`Target.setAutoAttach`, `chrome.debugger` sessionId, Chrome 125+), enabled lazily only when a frame needs it.
  **Refs** are per document (keyed by the main frame's loader id): the same `(frame, backendNodeId)` keeps its ref across
  snapshots; a navigation starts a new table, so an old ref is refused rather than hitting something else. The activity
  overlay got `aria-hidden` so it never shows up in a snapshot.
- **Coordinates**: `DOM.scrollIntoViewIfNeeded` + `DOM.getContentQuads` (largest quad, its centre). Same-process frames
  report main-viewport coordinates; an out-of-process frame adds its `<iframe>` content box (recursively). Verified by the
  e2e click into a cross-site frame.
- **Input** is `Input.dispatchMouseEvent` / `dispatchKeyEvent` / `insertText` (trusted). `type` focuses and selects in a
  helper (`select()` / a range for contenteditable) and then `insertText`, which is what makes React-style controlled
  inputs update (their value tracker ignores script-set values); e2e has such an input. `press_key` parses shortcuts in a
  pure module (`keys.ts`); on macOS the editing shortcuts are sent with `commands` (`selectAll`, `copy`, `undo`...), since
  Chrome handles them in the menu, not the page. `drag` uses `Input.setInterceptDrags` so an HTML5 drag is completed with
  `dispatchDragEvent`; a plain mouse drag just works. `select_option` sets `option.selected` and fires `input`/`change`
  from a helper (as Playwright does). `upload_file` uses `DOM.setFileInputFiles`; the MCP server checks the paths exist.
- **Helpers run in a CDP isolated world** (`Page.createIsolatedWorld`, name `facet-agent`) so page scripts cannot
  interfere; they only look at the DOM. **Agent code (`run_js`) runs only in MAIN**: `world: "ISOLATED"` is now refused,
  because an isolated world sees the profile's real `document.cookie` of a container site (Facet's shim lives in MAIN).
  `Runtime.evaluate` is not subject to the page CSP (e2e: a `script-src 'self'` page whose own script cannot eval);
  `userGesture: true` like Playwright. The old `executeScript` path remains only as the fallback when the debugger cannot
  attach.
- **`screenshot_tab`**: `Page.captureScreenshot` in place, then a single `Page.startScreencast` frame, then (only if both
  look blank) brief activation + restore; the answer reports the path. "Blank" = every pixel of the full-size image is one
  colour while the page has text or images (a thumbnail test was wrong: a mostly white 3000 px page washed its text out
  and fell through to activation). The activity overlay is hidden for the capture as before. `fullPage` uses
  `captureBeyondViewport` with the CSS content size, capped at 16384 px.
- **History** goes to the exact entry (`Page.getNavigationHistory` + `Page.navigateToHistoryEntry`) after
  `prepareNavigation` of its URL for a container tab. `chrome.tabs.goBack` was the first version; it failed in e2e with
  "Cannot find a next page" because Chrome's back-button intervention skips entries without user activation, which an
  agent-opened page often has. `reload` prepares the current URL. No tool uses `Page.navigate`.
- **Records**: console (`Runtime.consoleAPICalled`, `exceptionThrown`, `Log.entryAdded`) and network
  (`requestWillBeSent`/`responseReceived`/`loadingFinished`/`loadingFailed`, never `...ExtraInfo`, whose
  `associatedCookies` would list the **profile's** cookies for a container tab's request). Headers are kept only with
  credential headers replaced, and returned only on `includeHeaders`. 500 entries per tab, `seq` cursor for `since`,
  dropped on tab close and switch-off.
- **Per-tool deadlines** (`ToolSpec.timeoutMs`; host and MCP server add 5 s / 7 s): `wait_for` 35 s (it waits up to 30),
  `snapshot` 25 s, `screenshot_tab`/`type`/`run_js` 30 s, the rest 15 s as before.
- **Validator** gained `array` (`items`, `minItems`, `maxItems`) and `pattern` (refs `^e\d+$`, absolute upload paths).

### Isolation checks
No tool exposes `Network.getCookies`/`getAllCookies`/`setCookie(s)`, `Storage.*`, `Network.setExtraHTTPHeaders`,
`Fetch.*`/request interception or `Page.navigate`; navigation tools go through `prepareNavigation`/`openInContainer`.
DNR session rules apply to requests of a debugger-attached tab (it is the same network stack): e2e keeps a container tab
attached (`watch`) and checks the **first request** of reload, navigate, back and forward on the server: the container's
`sid` and `vis=container`, never the profile's `sid` or `vis=profile`; `run_js` sees `document.cookie === "vis=container"`;
the request list (with headers) contains no cookie value at all.

### Visibility
- **Amber "ON" badge while the switch is on**, on every tab: plain tabs "ON", container tabs keep their initials but on
  amber (the container colour stays visible on the tab group and in the popup; the initials still say which account).
  The global badge and the button tooltip say it too. Chosen over a second icon set: badges are what the user already
  reads, and the "AI" activity badge still overrides for 2.6 s as before.
- **Animated tab-strip activity** (user request in the same task): the favicon becomes a canvas-drawn frame (the site's
  icon when drawable, else a grey dot, inside a pulsing ring in the container colour, 125 ms per frame) through the
  `href` of the page's own icon links (one appended `<link rel=icon data-facet-agent-icon>` on pages without one). (Redone the same day: drawn glyphs, slow breathing, a session-long glow, no title marks, see "Agent session" below.) `prefers-reduced-motion`: one
  static frame. `executeScript` of the activity code has a 1.2 s ceiling so a page blocked by a dialog cannot hold a
  tool up. (The first version detached the page's icon links and put them back, and marked the title for every tool;
  both were replaced, see "Review fixes".)

### Agent session: glow, drawn glyphs, no title marks, `run_js` expressions (2026-10-10)
User feedback on the favicon work: the animation was too fast, the emoji were ugly, and the page should glow for the whole
time the agent works with a tab, like Claude in Chrome.
- **No marks in `document.title`, ever.** All title code (marks, write budget, navigation listeners, quiet period) was
  removed from `overlay.ts`; `TOOL_LOOK` lost its `title` flag. `withoutAgentMark` stays only to clean titles that an
  older worker may have left behind (and in the action log, list_tabs and snapshots).
- **Glyphs are data in one module**, `src/ui/agent-glyphs.ts` (24 x 24 paths: eye = outline + pupil, pointer = filled
  arrow). `pageActivity` is injected with `Function.prototype.toString` and cannot import, so `activity.ts` hands the paths
  to it in every command. The favicon draws them with `Path2D` on a canvas (tile in the colour, white glyph, neon ring), the
  pill renders the same paths as inline SVG in the closed shadow root. Not SVG data-URL favicons: an `<img>` load is
  asynchronous and the PNG route had already been verified through `tab.favIconUrl`. Not the site's own icon any more
  (the previous design drew it inside the ring): one fewer image load, CORS case and tainted canvas; the title already says
  which site it is.
- **Calm motion.** Everything breathes on an eased sine (`cubic-bezier(.37,0,.63,1)`), no hard on/off: steady edge glow
  30 % to 100 % over 2.5 s, action layer 1.8 s, favicon ring 10 frames per 1.8 s (180 ms: 5.6 fps, under the 6 fps cap;
  the frames are cached per colour/glyph/state), click ring 1.6 s. Reduced motion: static glow, one frame.
  (Superseded 2026-10-10: gradient-only purple vignette and a ring of rotating dots at 10 fps, see "a quieter debugger".)
- **Agent session** (`activity.ts`): a tab is in a session while `CdpSessions.isHeld(tab)` (was `isAttached` until 2026-10-10: the idle minute must not count) or a tool touched it in the
  last 8 s (`SESSION_MS`). `touch` sends `show` (action: bright layer, pill, pulse) and starts a 2 s timer per tab; each
  tick sends `session` (a **lease**, 6 s, on the page side: if the worker dies the page lets go by itself) or, when the
  session is over, `end` (600 ms fade). `webNavigation.onCommitted` (top frame) re-sends `session` with
  `injectImmediately` so a full load does not wait for the next tick; an in-page navigation keeps the document and the
  glow. Setting or bridge off: `stopAll` sends `stop` (immediate teardown) to every session tab. Tab removal forgets it.
  Hide/unhide for screenshots only toggles `visibility` of the host, so renewals do not undo it.
- **Why the lease and polling** rather than attach/detach events: the session is "attached OR touched recently", both are
  cheap to read at a 2 s tick, and the page-side lease makes a dead worker harmless. Cost: up to 2 s of lateness at the
  end of a session.
- **`run_js` takes a bare expression too.** `document.title`, `({a: 1})` (also with a trailing `;`) return their value;
  code that is not one expression stays a function body (`return` for a value). The CDP path evaluates the expression form
  first; a *compile* error (no `stackTrace`, className SyntaxError, no stack lines in the description) means nothing ran,
  and the body form is evaluated; a SyntaxError that running code threw (`JSON.parse('x')`) is the result and is not
  retried. `Runtime.compileScript` would have been a cleaner probe but needs `Runtime.enable` (measured: "Runtime agent is
  not enabled"), which the bridge avoids. The injected fallback does the same with `new Function` (expression first,
  body when that throws a SyntaxError). The userScripts fallback (pages that forbid eval) keeps body-only.
- **Bug found on the way:** a same-value `setAttribute` on our own link is a mutation record, and the MutationObserver
  that watches `<head>` looped in a microtask loop that froze the page (the CDP attach probe timed out). Writes are guarded
  by a comparison. Tests that wait for a session to end now take up to ~11 s each (8 s + tick + fade).

### Smooth indicators: continuous glow, 30 fps favicon (2026-10-10)
Live feedback on real Chrome while the agent ran `watch` and a `screenshot_tab` every 3 s on the active tab: the edge glow
"disappears and starts again", and the favicon is not smooth.
- **What was and was not the cause of the glow.** Measured first (probe in the page's isolated world during `watch` + 6
  screenshots): the base animation was never restarted (same element, same `Animation`, same `startTime`; `visibility`
  toggled for the capture does not restart a Web Animation). The visible interruption was the action layer: its bright glow
  faded out 2.5 s after each action (600 ms fade) and the next screenshot came at 3 s, so every cycle went 0 -> 100 % -> 0
  on a breathing period of its own (2 s against 2.8 s) laid over the base, plus the unavoidable blink of the hide for the
  capture. Fixes: the action layer now stays 3.5 s (`ACTIVITY_TTL_MS`, longer than a 3 s polling cadence, so it stays on
  between such actions), and it breathes in the SAME phase as the base. The brief disappearance for the capture itself is
  accepted (screenshots must not contain the glow).
- **One animation per document, phase from the wall clock.** The base and the action glow are created once
  (`ensureBreathing`) with `delay: -(Date.now() mod 2800)`, so an overlay that is built again (the setting off and on, a new
  injection after a worker restart, a page that removed the element) joins the cycle where it would be, not at zero.
  Per-command work only checks `playState === 'running'` on the right element. If a page removes `<facet-agent-overlay>` from
  `<html>`, a MutationObserver puts the same node back at once (max 20 times in 10 s). The pulse ring and pill are other
  elements and never touch the base. Tests: `e2e/agent-activity.spec.ts` ("the base glow is one element...",
  "an overlay that is built again joins...").
- **Favicon: 48 frames a turn, 30 a second (1.6 s a turn), angle continuous.** Measured first: Chrome follows a changed icon
  `href` at 10, 15, 20, 30 and 60 writes a second (`tabs.onUpdated` favIconUrl 10.0, 15.0, 20.0, 30.3, 62.5 a second, active
  tab), so the old "6 fps cap" (and the 10 fps of the previous commit) was not Chrome's limit. The frame is chosen from the
  wall clock (`floor(Date.now() mod 1600 / 1600 * 48)`), never "the next one", so any number of drivers agree and a late timer
  skips a step instead of drifting. Frames are drawn once (64 px, canvas anti-aliasing, 8 dots, comet-tail opacity and size)
  and cached per colour for the life of the document; after the first turn a frame is a lookup. The page's MutationObserver
  ignores our own writes (it used to run a second sync for every frame).
- **Background tabs: driven by the service worker.** Measured headed: in a background tab a page `setInterval` runs 3-6 times
  a second whatever its delay; a Web Worker metronome holds 28-30 but a blob worker is refused under `script-src 'self'` CSP,
  even from the isolated world (measured on `/cdp-csp`); `tabs.sendMessage` ticks from the worker held 30.2 of 30 a second
  and work on every page we can script. So `AgentActivity` sends `{facetAgentTick: 1}` every 33 ms to session tabs that are
  scripted (the page answered a command) and not the active tab of their window (refreshed on tab activation and every 2 s),
  and the page's `chrome.runtime.onMessage` listener draws the frame the clock says. The page keeps its own 20 ms timer for
  the tab in front. Cost: ~30 small messages a second per background session tab, only while the session lasts. Measured
  result with the real overlay: 30.0 favicon updates a second for the active tab and 30.1 for a background tab (48 distinct
  frames in both). Unit tests: `activity.test.ts`; e2e: "a tab in the background is driven by the worker...".
- Not measurable here: how fast the tab strip repaints the favicon (Chrome UI); only the updates Chrome receives are.

### Review fixes: dialogs, title/favicon marks, viewport pins (2026-10-10)
Three findings from the independent review of the "full hands" commit.
- **An open JavaScript dialog is not lost to the idle timer.** `scheduleIdle` ignored `session.dialog`: 5 s after the
  click that opened an `alert` the session detached, `handle_dialog` then said "no dialog" and `snapshot` "page does not
  respond". Now the idle check keeps the session while a dialog is pending (cap `DIALOG_MAX_MS`, 10 min; it re-checks at
  most every minute and `Page.javascriptDialogClosed` re-arms the normal 5 s window). After the cap Facet detaches and
  remembers the dialog, so the next attach says "left open for more than 10 minutes, Facet let go" instead of the generic
  probe failure.
- **(Retired 2026-10-10: the title is never touched any more.)** **The title mark is for reads only, and written carefully.** The title is the page's own data: analytics reads
  `document.title` on SPA navigations that a `click` triggers, the browser records it in history, and apps that rebuild it
  (`"(1) " + document.title`) copy the mark, which a prefix-only removal then never found. Now `TOOL_LOOK` has a `title`
  flag, true only for `get_tab_text`, `get_tab_html`, `snapshot`, `screenshot_tab`, `console_messages`,
  `network_requests` and `wait_for` (not `watch`); every other tool removes a mark and writes none. The page side never
  writes while `readyState !== 'complete'` or within 1 s of an address change, learned from the Navigation API `navigate`
  event (fires before `pushState` returns, so the mark is removed before the page can read the title), `popstate`,
  `hashchange` and a polled `location.href`. Removal strips marks from any position (`strip`), idempotently, keeping as
  many marks as the page's own title already had at the start (a title that natively begins with an eye is not eaten),
  and never writes back an old title. Rejected: patching `history.pushState` (the isolated world's patch is invisible to
  the page), restoring the title saved at the start (clobbers legitimate rewrites).
- **The favicon is additive.** Detaching the page's `<link rel=icon>` nodes broke frameworks that own them. An extra
  Facet link was tried next (the page's nodes untouched, one appended link, moved back to the end), and then measured
  with Chromium 156: a later PNG link wins only over a PNG icon given as a `data:` URL or over no icon at all; it does
  **not** win over an icon Chrome already loaded for the address, whatever its type, size or position, and a page SVG
  icon always wins. So the animation was invisible on most sites.
- **The favicon is animated through the `href` attribute of the nodes the page already has (2026-10-10).** What Chrome
  does follow is a change of an icon link's `href` (that is how pages animate their own favicon, SVG pages too once
  `type` says PNG). So, during activity, each existing icon link (`rel` has the `icon` token, `shortcut icon` included,
  `apple-touch-icon` excluded) gets the current frame as `href` and `type="image/png"`; the original values are
  remembered per node. No node is removed, moved, reordered or replaced. The page keeps ownership: a MutationObserver
  (attributes `rel`/`href`/`type`, `childList` of `<head>` and `<html>`) treats a value the page sets meanwhile as the
  node's new original and puts our frame back on top; a node the page removes or retags is forgotten after getting its
  own values back; a new icon link is adopted. At the end, each node gets its latest page-owned value (an attribute the
  page changed after our write is left alone), then a final sweep removes any of our frames (kept in a set of the last
  64) from every `<link>`. A page with no icon link gets one appended link of ours (removed alone; it is also removed
  when the page adds an icon of its own). A page that keeps rewriting (more than 80 changes in one activity) gets its
  icons left alone. Same-value `setAttribute` is guarded: it is a mutation record and made the observer loop (a
  microtask loop that froze the page; found by the CDP attach probe timing out). End paths: the 2.5 s timer, a new
  `stop` op sent to every shown tab when "Show agent activity" or the bridge is switched off (`AgentActivity.stopAll`),
  `pagehide` (also bfcache), and an orphaned world (`chrome.runtime.id` gone: the next frame tears down).
  `get_tab_html` serialises the page's own values (it reads the tracked originals), not our frame. Rejected: the
  extra link (above) and detaching/replacing the page's nodes (breaks frameworks). Measured in e2e: `tab.favIconUrl` is our `data:image/png` frames during activity on a page with an SVG icon and on a
  page with PNG icons, and the page's icon URL again afterwards.
- **`resize_viewport` pins are capped and released.** Pins now expire after 30 min (`PIN_MAX_MS`, like `watch`: override
  cleared, session idles out). The bridge also needed to know when the agent is gone, but the MCP server opens a connection
  per tool call, so "the socket closed" says nothing. The MCP server now keeps one extra connection open while it runs
  (`__session`), the host counts these and tells the extension (`{type: 'clients', count}`) when the count changes; at 0
  the extension waits `RELEASE_GRACE_MS` (10 s, cancelled by a new client or request) and calls `CdpSessions.release()`:
  clear the override on pinned tabs, detach every tab, end watches. The user's Cancel memory (`revoked`) and the console
  buffers are kept (unlike the off switch, which is `detachAll`). The host's death also releases. Not detected: a frozen
  MCP process whose socket stays open (the caps still apply).

### Tests
Unit: key parsing and event sequences (incl. macOS commands), snapshot rendering (roles, flattening, text merge, values,
links, iframes, stable refs, truncation), validator arrays/patterns, the session manager with a fake `chrome.debugger`
(attach/reuse/idle, shared attach, refused URLs, own-session recovery and busy, the no-answer probe, Cancel revocation,
switch-off during attach, watch lifetime, records and redaction, dialogs, stale detach), router CDP paths (run_js,
ISOLATED refusal, fallback, click coordinates and modifiers, target validation, dialogs, snapshot -> click by ref, exact
history with container preparation, reload, console/network answers, viewport pin, abort), relay per-tool deadline.
e2e (`e2e/agent-cdp.spec.ts`, 11 tests; `agent-activity.spec.ts` +2): snapshot -> click by ref (`isTrusted`, double,
right, modifiers, coordinates), React-like controlled input, slow typing and shortcuts, Enter submits, hover/`:hover`,
select, upload, mouse drag and HTML5 drop, run_js under `script-src 'self'`, background and full-page screenshots with no
tab switch, alert/confirm/prompt, console and network while watching, the container-cookie check above, switch-off
detaches and own-session recovery, refused pages, wait_for/back/forward/reload/viewport/frames (same-site and cross-site
click by ref), animated favicon (Chrome's `tab.favIconUrl` shows the frames on an SVG-icon and a PNG-icon page and the page's icon afterwards,
the node is the same one, a framework-like page that rewrites/replaces its link ends with its own value, nothing `data:` left, icons back
at once on setting off / bridge off / `pagehide`, a page without an icon, reduced motion; the title is never touched, in plain and container tabs, also while the page rewrites it; favicon changes at most 6 times a second,
glyphs differ between read and action; the edge glow lasts while the debugger is attached (viewport pin), across a `pushState` and a full page load, and fades at
session end; `run_js` with bare expressions), a dialog
answered after a 7 s pause, `resize_viewport` released after the MCP client is killed. Playwright auto-dismisses dialogs nobody listens for, so the dialog test registers a no-op listener.

## Agent bridge: a quieter debugger and purple indicators (2026-10-10)
Live feedback on real Chrome (an agent session of 1 snapshot, a `get_tab_text` every 3 s for ~20 s, a background
screenshot): Chrome's "Facet started debugging this browser" bar kept appearing and disappearing, the page jumped each
time, the edge glow had a hard line, the favicon animation was choppy and the colours varied with the container.

- **The debugger is for what a script cannot do.** The bar is Chrome's and cannot be hidden, so the fix is attaching less.
  `snapshot` was the only read tool that used CDP (`get_tab_text` / `get_tab_html` already used `executeScript`); it now
  walks the DOM in the extension's isolated world (`page-dom.ts`, one self-contained injected function) and returns nodes in the
  shape of Chrome's AX nodes, so `snapshot.ts` renders them unchanged (same lines, same attributes, same refs). Finding an
  element, focusing it, scrolling to it, choosing an option and waiting are DOM work too. Trusted input still needs CDP; for
  `click` / `hover` / `drag` the page only reports *where* the element is (scrolled into view, centre of its largest box),
  and the debugger sends the mouse events at those coordinates, only after the lookup succeeded (a typo in a ref no longer
  attaches anything). `type` and `press_key` let the page focus the field (and select its text) from the page's side, then
  send keys; `upload_file` marks the input with one random attribute for the moment `DOM.setFileInputFiles` needs a node
  (the only mark ever left in a page; removed in a `finally`). The AX-tree path (`Accessibility.getFullAXTree`, backend node
  ids, `Target.setAutoAttach` for out-of-process frames) is gone rather than kept as a fallback: a page `executeScript` cannot
  reach is one the debugger could not attach to either (both refuse `chrome://`, the Web Store, extension pages).
- **Refs without CDP.** A per-frame registry in the isolated world (`id -> WeakRef`, `WeakMap` back; random per-document
  `token`). The background maps `(frameId, token, id)` to the `eN` the agent sees, so a navigated frame's old refs are refused
  (`unknown ref ...: the page has changed`) instead of resolving to a different element with the same number. Frames of another
  site are separate scripting targets (`webNavigation.getAllFrames`), matched to the `<iframe>` that holds them by address then
  order (same-origin frames are walked by their parent, so they are excluded first); the owner element is remembered so a point in
  such a frame becomes top-viewport coordinates (`owner` op: content-box origin of the iframe, recursively).
- **60 s idle window instead of 5 s.** The bar costs a layout shift each time it appears or goes, so one burst must be one
  attach. An agent's act-think-act gaps are seconds to tens of seconds; 60 s spans them. Detach is still immediate on
  switch-off, on "bridge client gone" (after the existing 10 s grace) and on tab close; watch, pins and dialogs keep their longer
  holds. Consequence for the glow: it must not last 60 s after the last action just because the session idles, so the activity
  module asks `CdpSessions.isHeld` (pin, watch, dialog, a tool running) instead of `isAttached`.
- **Screenshot of the tab on show without the debugger.** `captureVisibleTab` when the tab is the active one of a
  non-minimised window, not full-page, no viewport pin and no dialog; any failure falls through to the debugger path. The
  answer says `"path": "visible"`. (A minimised or hidden window cannot be captured that way; Chrome says so.)
- **Back/Forward stay on CDP.** Tried `tabs.goBack` / `goForward` for tabs that are not attached: Chrome's back skips
  entries without user activation, so after `open_tab` + `navigate` it answered "no previous page" (e2e caught it). The exact
  entry (`Page.getNavigationHistory`) is the only reliable way; it is a rare action, and within a burst the session exists
  anyway.
- **Look.** One purple (`#8b5cf6`, hue 258) for every agent indicator, independent of the container: "purple = the agent is
  here"; container colour stays on tab groups and the badge initials. The glow is four edge gradients in one element
  (`background-image` with eased stops, 26 px steady / 34 px on actions, alpha 0.30 / 0.55, no border, outline or box-shadow),
  breathing by opacity. The favicon is a 64 px canvas with 8 dots on a ring, 14 frames per turn at 100 ms (1.4 s), head
  opaque and the tail fading to 0.15; the rotation step (25.7 degrees) is not a divisor of the dot spacing (45 degrees), so
  all 14 frames differ. 64 px is downscaled by Chrome to 32 and 16 (the e2e checks the head dot stays solid at both). The
  eye/pointer glyph tile left the favicon (it was unreadable at 16 px); the pill keeps the glyphs. Reduced motion: static
  vignette, one frame of the ring.
- **Tests.** Unit: DOM snapshot through the router (refs, cross-origin frame placement, stale refs), no debugger for the
  read-only tools and `select_option` / `scroll` / `wait_for`, one attach for a burst, the 60 s window, screenshot paths. e2e: `chrome.debugger.attach` counted in the worker (0 for reads, 1 for five clicks 3 s apart), the idle
  window, the visible-tab screenshot, glow styles (gradients only), purple on a container tab, favicon frames (>= 12
  distinct, ~10 a second, hue 258 +-6, solid head dot at 64, 32 and 16 px), reduced motion.

## Container tabs that come back (2026-10-10)

Goal: a tab group with another profile's accounts that survives closing the group, restarting Chrome and the
computer. Before: jars persisted, but `tabId -> container` lives in `storage.session` and session rules, both wiped at a
browser start; restored, reopened (Ctrl/Cmd+Shift+T, History) and saved-group tabs came back as real-profile tabs. Code:
`src/core/restore.ts` (pure: records, matcher, gate rules, group marker), `src/background/restore.ts` (`TabRestore`,
owned by `Facet`), popup banner, setting `restoreTabs` (default on). Mode: full (isolation).

### Measured first (Chromium 156, Playwright, `--restore-last-session`)
- **Dynamic DNR rules are in force before the service worker runs at a browser start; session rules are empty.** A
  dynamic `block` for a restored background tab's address kept it from the network (`chrome-error://`, no request at
  the stand). So the only thing that can hold a restored tab before Facet's code runs is a dynamic rule.
- **But the active tab of each window and pinned tabs are loaded before the extension's rules apply** (they went out
  with the real profile's cookie although a dynamic block for them existed; background tabs of the same session were
  blocked). With the extension loaded from the command line; not verifiable for a normally installed extension in e2e.
  Accepted and documented (limits.md); Facet matches those tabs and reloads them in their container.
- **An `allow` rule cancels `modifyHeaders` rules of the same priority** (a session `allow` at 1 left a `set Cookie` at 1
  without effect, the one at 2 applied). Hence `CATCH_ALL_PRIORITY` moved from 1 to 2: every cookie rule sits above the
  gate's openers. The simulator now models allow (precedence allow > block > redirect at equal priority; modifyHeaders
  only above the deciding allow).
- Ctrl/Cmd+Shift+T: the restored tab's request leaves ~10 ms after `tabs.onCreated` reaches the worker, `sessions.onChanged`
  arrives right after. Session IDs are new at every browser start (old ones mean nothing); tab and window IDs are large
  random-looking numbers per session (a coincidental match across sessions is not a concern).
- Closing every tab of a group records one recently-closed entry per tab; `sessions.restore()` brings a tab back into a
  re-created group with the same title (zero-width characters included) and colour. Session restore keeps titles too.
  Chrome's saved-groups UI cannot be driven from e2e: "reopen a saved group" is simulated by creating the tabs and a
  group with the same title and colour.
- Chromium does not keep extensions loaded with `--load-extension` across a relaunch without the flag (so the e2e passes it
  again).

### Design
- **Records** (`storage.local`, `restoreState`): per container tab its container, address, tab/window ID, window
  signature (hash of its window's http(s) addresses in order) and position in it, whether it sat in its container's
  Facet group; when closed: when, with its window or not, whether its whole Facet group closed with it (Chrome then keeps
  a saved group), its recently-closed `sessionId`. Plus the signatures of live and recently closed windows. Rebuilt from
  `tabs.query` 0.3 s after any change (assignment, URL, move, group, pin), a close is recorded at once.
- **The gate.** Dynamic `block` rules (priority 1, `main_frame`, `|address|`, IDs 1000+, at most 500) for every address
  Facet may have to restore: open container tabs (needed at the next start) and restorable closed ones. Session `allow`
  rules at the same priority (key `@restore` of the session-rule manager, so they are swapped atomically with container
  rules): one for every tab Facet knows (all tabs at worker start, every tab once `tabs.onCreated` was seen, every
  container tab in the same batch as its cookie rules), and one per address that matters only at the next start (open
  container tabs that are not also restorable closed ones). Net effect: in normal browsing the gate holds only a tab that
  just appeared on the address of a closed container tab Chrome can reopen; at a start, everything on a remembered
  address. New addresses get their opener before their block (no tab is caught by surprise). The block is fail-closed:
  if the worker never runs, such tabs stay blocked rather than load as the real profile.
- **Matching** (`matchRestoredTab`), strongest evidence decides alone: same tab+window ID (extension update); the window's
  exact address list matching ONE remembered window (positions, so an ordinary twin on the same address stays ordinary,
  and this beats a group: a plain tab the user dragged into a Facet group stays plain); the recently-closed entry just
  restored (diff of `getRecentlyClosed` around `sessions.onChanged`; records are linked to entries by URL and time, or by
  window signature and position for closed windows); a group carrying the container marker plus a closed record of that
  container on that address. Several containers at the deciding level, or (at a start) only the address in common with
  a tab open in a container at the end of the previous session: the tab **waits**. Otherwise plain. A tab opened by a
  page (`onCreatedNavigationTarget`) is never a restore: it inherits (container parent) or becomes plain.
- **Group marker.** (Since 2026-10-13 titles start with the visible `⧉ `, see "Group titles: the ⧉ glyph and two-way sync" at the end.) Titles are `name + U+2063 + 3 zero-width digits (base 4) per ID character + U+2063`. Title alone is
  user-editable and a user group may have the same name; the marker cannot be typed. The projection takes over a group
  that carries its container's marker (restored or reopened) instead of making a second one. Not a secret: any extension
  with `tabGroups` can read it.
- **Browser start / update.** `storage.session` empty = session rules were wiped. Every live tab on a remembered address
  is held; the worker waits until the tab set is stable (0.4 s, at most 3 s), then matches all of them before `ready`
  (capped at 10 s); unmatched records of the previous session become closed (History can still reopen their windows) and stay
  gated for 5 minutes (late windows, "Restore pages?" after a crash, are matched like the rest). Records a waiting tab
  could be restored with are kept, and its address stays gated, until the user decides.
  The extension-update path by tab ID (`handleInstalled`) remains for installs without records. A worker restart restores
  the known/held sets from `storage.session`.
- **Applying a match**: `assign`, then reload with `prepareNavigation` (strict mode: the origin's workers go first) unless
  Chrome left the tab unloaded/discarded (then it loads in the container when opened). Plain: opener, then reload if the
  gate blocked it. Waiting: nothing; the popup banner offers "Restore N container tabs" (only tabs with one candidate and
  at least as many records of that container and address as such tabs), per-tab "Open in…" (`assignTab` with reload,
  which also releases the hold) and "Open as ordinary tabs". `assignTab` from anywhere releases a waiting tab.
- **sessionStorage marker: not used.** Chrome restores a tab's sessionStorage, but only a loaded document can read it;
  the decision must precede any request, and after the load a mismatch cannot be undone.
- **Permission `sessions` added** (recently-closed entries). With `tabs` already granted, Chrome may show a changed
  warning and ask the user to re-approve after the update.
- **e2e** (`e2e/restore.spec.ts`): reopen closed tab (no request carries the real cookie), closed Facet group reopened
  (both tabs back, no real cookie; the group is taken over) and a look-alike user group (ordinary), setting off, and a
  real browser restart in a separate profile: six windows; background container tabs come back in their containers with
  exactly one request each, the ordinary twin of a container tab stays ordinary, the restored group is taken over, the
  active-tab case ends in its container, look-alike windows wait without any request until the popup's "Restore 2
  container tabs" / "Open as ordinary tabs". The fixture forgets closed container tabs before each test and `plain()`
  waits until Facet has seen the new tab (a test can type faster than a person).

### Review fixes (2026-10-10)
- **Wrong account via window evidence (blocker).** The window evidence was just the address list, so with a single web
  page it was a URL match: a one-tab container window closed, later a link from another app or "open bookmark in new
  window" opened a new window with that address, and the tab was assigned to the container under another account
  (same within 5 minutes after a start without "Continue where you left off"). Now (`matchRestoredTab`, `MIN_WINDOW_TABS`):
  the window counts only with two or more http(s) tabs whose whole address sequence matches ONE remembered window, and
  outside a browser start (`startup`/`history` false) only when a record of that window (same signature, closed with it)
  has its recently-closed entry restored just now. A single-tab window never gets window evidence; ⌘⇧T (`session`) and the
  Facet group marker (`group`) still decide for it. At a start one that only shares the address with the previous
  session **waits** (the existing "ambiguous"), later it is plain: the gate still holds it for the ~0.4 s of matching,
  then it reloads as an ordinary tab, never held on the address alone. Residual: during the 5 minutes after a start,
  such an address in a new tab waits (safe, one click), because Facet cannot tell it from a late "Restore pages?" window.
- **Stale snapshot lockout.** Closing a plain tab did not refresh the window snapshot (only `sessions.onChanged`
  did, 0.3 s later), so quitting right after left a stale signature and the window's container tabs became ambiguous after the
  restart. Now `tabRemoved` schedules a snapshot for any tab unless the whole window is closing; the debounce is 100 ms
  (was 300), a burst is written at the latest 500 ms after its first change, and `runtime.onSuspend` flushes a pending
  write. Not added: a flush on `windows.onRemoved` (at browser quit it would snapshot windows mid-closure, where a close
  recorded without its event would lose `viaWindow`). e2e: close a plain tab, quit after 250 ms (shorter than the old
  300 ms), restart: the container tab comes back in its container, nothing waits (fails without the fix).
- **Waiting tabs are discoverable.** A tab that must wait now navigates (from the worker, `tabs.update`) to Facet's
  `held.html?u=<address>` right after the decision: no network request, same choices as the popup banner (candidate
  containers, "Open as an ordinary tab"), custom controls, 16/14 px. Chosen over a DNR `redirect` rule: the gate stays a
  plain `block` (fail-closed, nothing about the address leaves the rules, no web-accessible resource), the page needs the
  address only after the decision, and the matching code keeps seeing the original address. Cost: the tab sits on
  `held.html` (not its address) until chosen; `assignTab({reload})` and the popup's "Restore" send it to the address
  (`TabRestore.heldAddress` is read before the release). Badge: red "!" on the waiting tab (`BadgeIndicator.isHeld`),
  "!" and a tooltip with the count on the button for all other tabs (`restore-held` event). Tests: unit (matcher cases
  incl. the reviewer's probe, badge, `TabRestore` snapshot timing), e2e (one-tab window: no hold and real cookies; plain tab closed
  then quit; held page, badge, "Open in" on the page, global badge cleared after the last choice).

## Two editions: Lite and Full (2026-10-11)

One codebase, two builds. **Lite** (name "Facet") is multi-account containers only, for the Chrome Web Store and a GitHub
release. **Full** (name "Facet (Full)", the author's daily build, the default of `pnpm build`, `pnpm dev` and the e2e suite) is
everything. Both names are placeholders until the final one is picked; they live in the `EDITIONS` table of `wxt.config.ts`.

- **Why not a hidden setting.** A Web Store reviewer, and a user reading the permission prompt, judge what the package can
  do, not what it does by default. `debugger` and `nativeMessaging` read as "can drive every tab" regardless of a switch,
  and the page-name features (`data-ctr`, title prefix) exist for agents. So the agent side is not compiled into Lite.
- **What Lite leaves out**: the agent bridge (native messaging, MCP host protocol, command router, CDP sessions, `debugger`),
  the agent-activity overlay / favicon / glow / "AI" badge and their settings, `state.html`, "Show the container name to
  pages" with `data-ctr` and the title prefix, and the optional `userScripts` permission. **What it keeps**: containers, the
  isolation engine, strict mode, domain rules, the choose page, tab groups, the badge, `open.html` and `#ctr=` (useful for
  bookmarks and links), restore after restart (and `sessions`), the held page, export / import, options, popup.
- **Permissions.** Lite = Full minus `nativeMessaging` and `debugger`, and minus the optional `userScripts` (optional
  `cookies` stays). Everything else, `<all_urls>` included, is identical: the isolation engine needs it in both.
- **How the switch works.** `FACET_EDITION=lite` (read in `wxt.config.ts`) selects Lite; unset is Full. The config defines the
  compile-time constant `__FULL__`; every Full-only use sits behind `if (__FULL__)` (or `__FULL__ &&`), so the bundler removes
  the branch and the modules only it reaches. Chosen over separate repositories or a `lite/` fork (one fix reaches both) and
  over runtime flags (the code would still ship). Vitest defines `__FULL__ = true`: unit tests cover Full; Lite is covered by
  its own e2e and the bundle check.
- **Dead code is not enough, so it is checked.** `scripts/check-lite.mjs` (run by `build:lite`, `zip:lite` and CI) scans every
  Lite file for `connectNative`, `.debugger`, `Input.dispatch*`, `com.facet.bridge`, the settings and CSS of the bridge, and
  so on, and the manifest for the three permissions and a `key`. Its lists are written out in the script, not derived from the
  build config, so a mistake in the config cannot hide from it. The first Lite build did leak: `src/bridge/spec.ts` kept the
  whole tool list alive through `TOOLS.map(...)` (fixed with `/* @__PURE__ */`), and a side-effect-only `import './x.css'`
  in the bridge card survived tree-shaking (Lite resolves that one stylesheet to an empty module).
- **Settings schema.** Lite's `DEFAULT_SETTINGS` and `SETTING_KEYS` have four entries (`tabGroups`, `strictMode`,
  `restoreTabs`, `markOutsideGroup`). `updateSettings({ agentBridge: true })` is an error in Lite, not a silently stored flag. The `Settings` type
  stays the Full one; Lite code never reads the other keys.
- **Entrypoints.** `state` is dropped from the Lite build by the `entrypoints:found` hook: no file, no manifest entry, and
  no link to it (the popup's "More" menu, whose other item would have been alone and disabled, and so unopenable, becomes a
  plain "Re-group tabs" button in Lite).
- **Different extension IDs.** Full keeps the pinned `key` (`hapfikidacgfgnnajkgnaednpgnhmffk`: the author's install, the e2e
  suite and the bridge's native-host manifest depend on it). Lite has no `key`: the Web Store assigns its own ID on upload (a
  pinned key is of no use there), a local unpacked Lite gets a path-derived ID. So both install side by side. A pinned
  Lite key can still be added later (a separate pair, private half gitignored) if a stable local ID is ever needed.
- **Output paths.** Full stays in `.output/chrome-mv3` (the folder the author has loaded unpacked); Lite is in
  `.output/lite/chrome-mv3`. Zips: `.output/facet-full-<version>.zip`, `.output/lite/facet-lite-<version>.zip`. WXT empties only
  its own `chrome-mv3` folder, so building one edition does not delete the other.
- **Sizes** (unpacked, Chrome MV3): Full 641 kB, Lite 502 kB; zips 250 kB and 203 kB. Most of both is the Public Suffix List
  (`tldts`, 294 kB), which the isolation engine needs.
- **CI** (`.github/workflows/ci.yml`): typecheck, unit tests, `build:full`, `build:lite` with the check, both zips as
  artifacts; a tag `v<version>` also creates a GitHub Release with both zips. No e2e in CI for now.
- **Tests.** `e2e/lite.spec.ts` launches the Lite build in its own browser: manifest without the three permissions and `key`,
  the APIs Chrome does not define without them, no `state.html`, a three-key settings schema and no bridge API, two containers
  with a 302 HttpOnly-cookie login staying apart (and no `data-ctr` or title prefix), the popup and options pages without any
  agent text. The Full popup, options, indicators and agent-bridge specs were re-run after the refactor (35 passed).

### Minimal popup (2026-10-11)
- The popup was text-heavy (amber strict-mode banner, amber agent card with a sentence, big purple button, a "New tab" button per row). Now: header with icons only (settings, more) plus, while strict mode awaits consent, a shield with an amber dot (`StrictWarning`, opens the same consent dialog); the agent is one neutral row (dot, "Agent", counter, switch) whose last five actions unfold on press; "This tab" is one line with a swap icon; containers have a "+" in the section head, a row press opens a new tab in it, the tab count is a bare number and "⋯" (rename, recolour, delete) shows on hover and focus; waiting tabs are one line "N tabs waiting" with Restore and a menu. Icons live in `src/ui/icons.tsx`. The "Show agent activity" switch is only in Settings now.
- The host's `__session` and `__ping` calls are never run, counted or listed by the bridge (`isInternalTool` in `agent-bridge.ts`); they are answered with a pong.

### Strict mode as a plain setting (2026-10-11)
- **Decision:** never ask. The consent dialog (and the amber shield in the popup header) distracted at every
  popup opening. Strict mode is now an ordinary setting in Options -> General, changeable at any time; the popup says
  nothing about it.
- **Default off.** Off means the per-origin service-worker policy: workers are removed only on sites used in containers
  ("managed" sites, also refused in plain tabs there), and every navigation Facet starts still awaits the removal for
  the target origin. Why not on: silently removing every service worker of the profile would kill push notifications on
  all sites without the user knowing. The one cost line is shown next to the switch ("Sites can't send push
  notifications while it's on.") with a "Why we need this" disclosure (`WhyStrict`, a custom button with `aria-expanded`).
- **Turning it on** is the old "accept" path: `StrictMode.turnOn()` = `browsingData` removal of every worker, then the
  global guard (`ServiceWorkerPolicy.setGuard(true)`). The extras API's `updateSettings({strictMode: true})` runs it
  *before* storing the setting, so a failed removal leaves the setting off and the error reaches the switch (inline
  busy and error text; the switch moves only after success). **Turning it off** drops the global guard only; the
  per-origin policy stays. `applySettings` no longer poisons its queue after a failure.
- **Removed:** the persisted `{consentAt, prompt}` state, `grantStrictMode`, `dismissStrictModePrompt`,
  `StrictConsentDialog`, `StrictWarning`, `IconShield` and the `.fx-strict-*` CSS. `getStrictMode()` stays as
  `{enabled, active}` (tests).
- **Migration** (`migrateStrictMode`, once, before the settings are read; marker `storage.local.strictMode = {v: 2}`):
  an install that had consented keeps strict mode on (written as an explicit choice, since the default changed);
  every other install (prompt pending, "Not now", never asked) gets it off. Covered by unit tests.
- **Lite:** same behaviour (strict mode exists there).
- e2e: the leftover-worker test now lowers the guard by hand (`strictWithoutGuard`: the dynamic guard rule and the
  worker-script block removed through DNR), since "strict on but workers installable" can no longer happen through the
  setting. New: a fresh install shows no prompt in popup or options, and the switch removes an existing worker.
- Icons: `IconSettings` redrawn as a standard (Lucide-style) gear; all icons share the 24-unit grid, 1.5 stroke, round
  caps and joins through the one `Icon` wrapper.

## Rename: Facet -> SplitSession (2026-10-11)

The product is now **SplitSession** ("Same site, separate logins."). Chrome Web Store names: Lite
`SplitSession: Multiple Logins per Site` (38 characters), Full `SplitSession (Full)`; `short_name` is `SplitSession` for both
(the Full suffix is only needed where the two sit side by side, and `short_name` is shown where space is tight). Description:
"Use several accounts of the same site side by side in one Chrome profile." (Full adds the bridge sentence). The logo is unchanged.

**Renamed** (everything a person or an agent sees, plus the files they run): manifest name / description / action title, popup,
options, choose, held, open and state pages, badge and toolbar titles, error and bridge messages, MCP tool descriptions, export
file name (`splitsession-<date>.json`), README, docs, CI release asset names, zips (`splitsession-lite-<ver>.zip`,
`splitsession-full-<ver>.zip`), `package.json` name `splitsession`. Bridge: native host `com.splitsession.bridge`, data and
socket folder `~/Library/Application Support/SplitSession`, built file `bridge/dist/splitsession-bridge.mjs` and installed
launcher `splitsession-bridge-host`, MCP server name `splitsession` (tools appear as `mcp__splitsession__*`).

**Migration:** `pnpm bridge:install` and `pnpm bridge:uninstall` also remove the old `com.facet.bridge.json` manifest(s) and the
old host copy in `Application Support/Facet/host` (and the old folder once empty); install prints both
`claude mcp add --scope user splitsession -- …` and `claude mcp remove --scope user facet`. `scripts/check-lite.mjs` forbids
both the new and the old host name in the Lite bundle.

**Deliberately kept, for data compatibility:** the Full extension `key` / ID `hapfikidacgfgnnajkgnaednpgnhmffk` (installed
extension, containers and cookie jars survive an update); every storage key and page-storage prefix (`__facet:<key>:` in the shim,
`chrome.storage` keys, `facet-purge` / `facet-bridge-retry` alarms, content-script IDs `facet-beacon` / `facet-shim`,
`facet_defaults` DNR ruleset); CSS prefix `fx-`; DNR rule ID ranges; message type strings (`facet/api`, `facet/open-tab`, ...,
`facet:adopt`); the beacon's `<facet-bridge>` node and the agent overlay's `<facet-agent-overlay>` / `facet-agent` isolated
world; the export file `format` value `facet-export` (older exports must still import, and older builds must read new ones);
globals `globalThis.facet`, `__facetAgentActivity`, `facetCdp`; environment variables `FACET_EDITION`, `FACET_BRIDGE_SOCKET`,
`FACET_TEST_PORT`, ...; `keys/facet.pem`; TypeScript names `Facet`, `FacetApi`, `FacetEvent` (and `src/background/facet.ts`);
the local folder `facet/`. A later cleanup may rename the cheap ones, but none of them is visible to a person.

## Two UX fixes (2026-10-11)

### Creating a container in the popup opens a tab in it
- After "+ → name → Create / Enter" the popup calls `newTabInContainer` (the same call as clicking the row), refreshes and
  closes itself (`window.close()`; Chrome also closes it when the new tab takes focus). If opening the tab fails the
  container exists, the popup stays open and says "Created “x”, but could not open a tab: …" (error style).
- **Settings (options page) has no way to create a container**, so there is nothing to keep or change there. The choose page
  (domain rule "ask") creates a container as part of opening an address in it, as before.
- e2e: `popup.spec.ts` (creating by mouse and by keyboard opens a container tab and closes the popup; a failed Create keeps
  it open and opens nothing); `security.spec.ts` and the older popup tests re-open the popup after creating.

### Dragging a tab into a SplitSession group (supersedes "groups are a view" for drag-in)
- **Why.** A logged-in GitLab ordinary tab was dragged into the "reddit" group, logged out there, and that logged the real
  profile out everywhere: the group looks like the container, the tab was not in it. A group that wears a container's name
  and colour is read by people as "this tab is in that container", so now it is.
- **Rule.** `tabs.onUpdated` with a new `groupId` (>= 0): when the group carries SplitSession's invisible marker of an existing
  container (`decodeGroupMarker`, via `TabGroupProjection.containerOfGroup`, which also takes over a marked group Chrome brought
  back) and the tab's container is not that one (an ordinary tab included), the tab is reopened there through the existing safe
  path: `Facet.replaceTab` (fresh tab at the same window, index, pinned and active state, no opener, service workers of the
  address removed and the container's rules installed before its first request), then the old tab is closed. The new tab joins
  the group through the normal projection (tab-assigned), before the old one leaves. A group without the marker (the user's own,
  a retyped title, a deleted container) never decides anything. Works whether "Group tabs by container" is on or not; with it off the
  new tab is not grouped (the setting means no groups from SplitSession).
- **Notice.** No native notification and no text injected into pages: the tab's toolbar button shows an arrow before the
  container's initials ("→Re") and the tooltip "SplitSession — moved to “reddit”" for 4 s, then the usual badge returns
  (`BadgeIndicator.notice`; survives the re-application after navigation). The new tab's navigation is exempt from domain
  rules (`markSite`), as for the choose page: the user chose the container by dropping the tab there.
- **Guards** (`src/background/group-drag-in.ts`): moves SplitSession itself makes are no-ops by construction (it only groups a
  tab into its own container's group, so tab container == group container); a group change of a tab younger than 1 s is
  ignored (Chrome puts new tabs into their opener's group, SplitSession creates tabs at a group's index); tabs SplitSession is
  assigning (`activeSince` null) or the restore has not decided on (`TabRestore.isWaiting`: pending or held) are ignored, so a
  restored or reopened group is handled by the restore only; pages that are not http(s) (chrome://, extension pages incl. the
  held page, the `about:blank#facet-…` start of a popup child) are ignored; a tab being replaced is not handled twice; at most 10
  moves per 10 s. Changes are queued; the handler waits 0.3 s, then checks the live state again (tab still in that group?).
- **Dragging.** Chrome refuses tab edits while the user holds a dragged tab and may apply group changes live. Creating the
  new tab and closing the old one retry (every 0.25 s, up to ~20 s) on that refusal, and the state is re-read on every try, so a
  drag that ends elsewhere does nothing.
- **Out of a group** (to ungrouped or to a group that is not SplitSession's): the tab keeps its container and badge and is not
  regrouped. **From group A to group B** (two containers): reopened in B, same as from an ordinary tab. A tab navigating inside a
  group (typed address in a "New tab to the right" inside the group) is not a drag and is not handled. **(Superseded
  2026-10-13: such tabs are assigned when Chrome creates them, and the one-second age guard is gone; see the last section.)**
- **Costs** (limits.md): tab ID changes, history and scroll are not carried over, the old document's state is lost.
- e2e (`e2e/group-drag.spec.ts`): ordinary tab dragged into a container's group is replaced by a tab in the container whose
  every request carried the container's cookie and none the real profile's (real cookie untouched), the notice shows and clears;
  A group to B group ends in B; out of the group / into a user's group keeps the container and the badge; blank pages stay;
  re-group and a new container tab are not touched. `indicators.spec.ts` now moves a tab into a user's group instead of a foreign
  container's.

## Colour-dot badge and "go to the container" rows (2026-10-11)

- **Toolbar badge is a dot, not letters.** A container named "123" showed "12" and looked like a count. Container tabs now get
  badge text `' '` (one space) on the container's colour: Chrome keeps whitespace-only badge text (the e2e reads back `' '`; only
  the empty string clears the badge) and draws a small coloured rounded pill. A bullet glyph (`●`, `•`) in the badge colour would draw the same pill
  (invisible glyph), and in a contrasting colour a dot inside a pill, so the blank was kept. With the bridge on the text is
  `ON` on the container colour (amber is for plain tabs), and the move notice is `→`. `badgeText` (initials) was removed from
  `src/core/indicators.ts` with its tests. Not measurable headless (toolbar pixels are not in a page screenshot): the e2e checks
  text and colour as Chrome reports them (`' '`, `[r,g,b]`).
- **A container row goes to the container.** With open tabs the popup (`goTo` in `Popup.tsx`) takes the container's tab with the
  lowest index in the current window (else the first in any window), expands its tab group if collapsed
  (`tabGroups.update(id, {collapsed: false})`), activates the tab and focuses its window, then closes. With no tabs it opens a new
  tab as before. Label and tooltip: "Go to <name>" / "New tab in <name>"; the row's "⋯" menu has "New tab in <name>" first, so a
  new tab is always one step away. The "+" create flow still opens the new container's first tab. e2e in `popup.spec.ts`.
- **Container row icons instead of the "⋯" menu.** A row shows its tab count; on hover or focus-within the count gives way (same
  place, the name always stops before them, no layout jump) to icon buttons of 28px: "+" (`New tab in <name>`), move-in (`Move this
  tab to <name>`, only when the current tab is a web page outside that container), pencil (`Edit <name>`, the inline form without a
  delete button) and trash (`Delete <name>`, red on hover, opens the confirmation dialog). The icons are hidden with `opacity`, so
  Tab reaches them without hover. The row button is `Go to <name>` (has tabs) or `Open <name>` (none), so it no longer shares a name
  with the "+" icon. After a move, focus goes to the row's main button (`rowId`). e2e in `popup.spec.ts`.

## Tabs inside a SplitSession group: the group tells the truth (2026-10-13)
- **Found on the real Chrome.** The "talonbot" group held Vercel and Cloudflare tabs in the container and a `threads.com` tab
  with no container (a newer tab ID than the others). Two reports: a logged-in Threads tab put into the group was still logged in
  after a refresh, and logging in outside the group logged the tab in the group in too (it was an ordinary tab of the real profile).
- **Causes (measured in e2e, Chromium 156).**
  1. A tab Chrome creates inside a group ("New tab to the right" of a grouped tab, the group's "New tab in group", an address or
     link opened next to a grouped tab, `tabs.create` at an index inside the group) arrives in `tabs.onCreated` with its
     `groupId` already set, and **no** `tabs.onUpdated` with a `groupId` follows. The drag handler listened to `onUpdated` only,
     so such a tab stayed an ordinary tab in the group, and whatever the user typed in it loaded as the real profile. This is
     the most likely origin of the Threads tab (new tab ID, plain, inside the group).
  2. The one-second age guard dropped a group change of a tab younger than 1 s for good (the old drag tests only passed because
     they waited 1.2 s; without the wait they fail on the old code). Other silent drops: a tab the restore had not decided yet
     (`isWaiting`) or that was being assigned was skipped with no later look; a failure other than Chrome's "user may be
     dragging" refusal was logged once and never retried; a tab dropped in from another window is attached with its group (only
     `tabs.onAttached`; not verifiable in e2e: `tabs.move` refuses to put another window's tab inside a group). Nothing ever
     looked again at a tab that got past these.
- **Rule (invariant).** Every tab whose `groupId` is a group carrying the marker of an existing container is in that container.
  `src/background/group-guard.ts` (`GroupGuard`, replaces `group-drag-in.ts`) enforces it from three inputs: `tabs.onCreated`
  with a `groupId` (no settle for a page that made no request, 150 ms for a website so a link's inheritance goes first),
  `tabs.onUpdated` with a `groupId` (300 ms settle: the user may still be dragging), and a **sweep** over all grouped tabs, 1 s
  after `tabs.onAttached` / `tabGroups.onCreated` / `tabGroups.onUpdated` / a container renamed or deleted, 1.5 s after the
  worker starts (after `Facet.settled()`: rehydration, the restore's start pass and an update's `handleInstalled`), and every 30 s
  by the alarm `splitsession-group-sweep` while some group stands for a container (created only when missing, so events do not
  restart its period; cleared when no such group is left). One check per tab at a time; a request arriving meanwhile runs once
  more afterwards. Every action is logged: `group guard: tab <id> <from or "no container"> -> <to> (<reason>): <action>`, with the
  same as data.
- **Actions.** A tab that has loaded nothing of another identity is assigned **in place** (`Facet.assignInPlace`): a page that is
  not a website (the new tab page, about:blank, chrome:// and extension pages), a tab Chrome has not loaded (`status:
  'unloaded'`) or has discarded, and a tab the restore holds back (its request blocked by the gate, or on `held.html`, which then
  goes to its address in the container). The group decides for those instead of the restore matcher: a group with the marker is
  the strongest evidence there is. A loaded website (or one with a navigation in flight) is **reopened** through
  `Facet.replaceTab` as for the drag (fresh tab, no opener, the container's rules and service-worker removal before its first
  request, then the old tab is closed), retried every 0.25 s for up to ~20 s while Chrome refuses edits during a drag, with the
  state re-read on every try. At most 10 actions per 10 s; the rest wait for the next sweep (logged once per window).
- **SplitSession's own tabs.** The age guard is replaced by an explicit record: `Facet.trackOwnCreation` wraps every
  `tabs.create` of SplitSession's (`createBlankTab`, the popup's "New tab in"), and the tab is "busy" until its creation flow
  ends (`ownTabDone`) and "own" for 5 s after. The guard waits for SplitSession's `tabs.create` calls still under way before it
  decides, so a tab it is creating is never taken for one the user made. Chrome puts such a tab into a group when SplitSession
  creates it at a grouped tab's index (`replaceTab` keeps the old tab's place): when it lands in the group of another container
  (a domain rule moving a grouped tab, the choose page's "no container"), the guard fixes the **group**, not the container
  (`TabGroupProjection.placeOwn`: into its own container's group, or out of the group). Tabs being assigned (`Facet.isAssigning`:
  an assignment under way, a popup child inheriting) are waited for; two assignments of one tab to the same container now share
  one (`Facet.assign` joins the running one), and `inherit` waits for an assignment someone else started before it reports the
  child ready to the shim.
- **The projection never lets a group lie either.** With "Group tabs by container" off, a tab assigned to another container (the
  popup's "Move here", `assignTab`) leaves a group that carries a different container's marker, and a tab that leaves its container
  leaves a group with that container's marker even when SplitSession does not keep the group (`tabUnassigned`). Before, with the
  setting off, such a tab stayed in the other container's group, and the guard would have moved it back.
- **Unchanged.** Taking a tab out of a group, or into a group without the marker, keeps its container (the "groups are a view"
  question stays open); SplitSession's own regroup and restore moves are no-ops by construction (tab container == group
  container); a group the user made has no marker and never decides anything.
- **Not guaranteed (limits.md).** A website Chrome opens directly inside a container's group (an address opened next to a
  grouped tab, a bookmark, a link from an ordinary tab) sends its first request **before** any extension hears of the tab
  (measured: `tabs.onCreated` 26 ms, the request with the real profile's cookie 28 ms after the call). Unless the restore gate
  blocks that address, that first request goes out as the real profile; the tab is then reopened in the container. A rule that
  held every unknown tab's first request would cost every new tab in the browser a blocked load and a reload; not done without
  a decision. The new tab page (what "New tab to the right" and "New tab in group" open) makes no request, so what is typed there
  is always isolated.
- **The state found on the real Chrome** (a loaded ordinary Threads tab inside the talonbot group) is fixed by the sweep 1.5 s
  after the updated worker starts: the tab is reopened in talonbot (logged out there unless talonbot has its own Threads login);
  the real profile's cookies are not touched.
- e2e (`e2e/group-drag.spec.ts`): a new tab page Chrome creates inside the group is in the container within 1 s, before
  anything is typed, and every request it then makes carries the container's cookie only (the real profile is logged in on the
  same site); a website Chrome creates inside the group ends up reopened in the container; a loaded logged-in ordinary tab dragged
  in right after loading (younger than the old guard's second) is logged out in the container, also after a reload, and nothing
  carried the real login; an ordinary tab sitting in a group that becomes the container's (title with the marker set directly, no
  tab event) is fixed by the sweep and the alarm exists; a page that is not a website dragged in is assigned in place. The drag
  tests no longer wait 1.2 s. Unit: `group-guard.test.ts` (replaces `group-drag-in.test.ts`), `tab-groups.test.ts` (`placeOwn`,
  groups off). The new e2e tests fail on the previous code (verified by running them against it).

## Content scripts only while containers are in use (2026-10-13)
- **Why.** "In my work browser I may not have containers at all": every frame of every tab still made a
  synchronous XHR to `http://ctr.localhost/whoami` (answered by DNR with a `data:` URL, never on the network), visible as
  noise in DevTools' Network panel, and parsed both scripts.
- **Three scopes** (`ContentScriptLifecycle`, `src/engine/content-scripts.ts`, owned by `Facet` as `facet.scripts`):
  - `all` (`<all_urls>`, as before) while containers are **in use**: a tab is in the tab registry, the restore is matching
    or holding tabs (`TabRestore.waitingCount()` = pending + held, `isStarting()`), or an assignment is under way (`hold()`).
    The dependency is `usage(): { tabs, waiting, starting }`; `reason()` names the first that applies;
  - `managed` (only `*://site/*` and `*://*.site/*` of the managed sites, i.e. sites containers have used) when none is in
    use but such sites exist. Kept on purpose: the shim's managed mode is what hides the containers' `__facet:<key>:`
    storage from the real profile's pages on those origins (and keeps their `localStorage.clear()` /
    `indexedDB.deleteDatabase` away from it). Dropping it would have broken "plain tabs keep their own" in limits.md as
    soon as the last container tab closed. A site that cannot be written as a match pattern (an IPv6 literal) keeps `all`;
  - `off` when there is neither: nothing registered, the static `{}` ruleset disabled
    (`updateEnabledRulesets`), the dynamic `{m:1}` / `{g:1}` beacon answers removed (`ServiceWorkerPolicy.setBeacon`).
    No page makes the request, and the beacon URL does not even tell a page that SplitSession is installed. A profile
    that never used a container stays here.
- **Order.** Up: the beacon answers first, then the scripts (no frame that gets the scripts can reach the network). Down:
  the scripts first; the answers 2 s later (a document that started just before may still ask). `all <-> managed` uses
  `scripting.updateContentScripts` (no gap); an unknown registration found at start (an older version's) is registered
  afresh. All changes run in one queue; a queued downgrade re-reads what is wanted when its turn comes, so it never
  lowers what an `ensure()` behind it asked for.
- **Registration before the first container navigation.** Every way into a container goes through `Facet.assignNow`, which
  now holds the scope and awaits `scripts.ensure()` before anything else: `openInContainer` (popup, API, agents, `facet/open-tab`
  children, `replaceTab` for domain rules, the choose page, the group guard's reopen), `assignTab` with reload (popup "Move
  this tab here", held page, `open.html`, which assigns its own tab before `location.replace`), `assignInPlace` (group guard,
  restore), `#ctr=` (assign, then navigate), popup children (`inherit`), the restore's matches (assign, then reload).
  `handleInstalled` (update: tabs put back without `assign`) calls `ensure()` before its reloads. `ensure()` is free once
  `all` is registered (no Chrome call).
- **Grace and worker restarts.** Down waits 30 s after the last change (cancelled by any container tab or assignment). A
  worker start derives the scope from the tab registry and the restore state at the end of rehydration and applies it at
  once, also downwards (nothing used the scripts while the worker was stopped; the static ruleset is set explicitly, an update
  may have re-enabled it). The per-minute purge alarm re-checks, for a grace period the worker did not live to see and for
  restore decisions that emitted no event. Scripts keep `persistAcrossSessions: true`: a browser closed with container
  tabs open starts with `all` registered (restored tabs need it before the worker runs).
- **Plain-tab duties that relied on the shim in every tab:**
  - Managed-site service-worker refusal (no strict mode): new session rule in the no-tab set
    (`compileManagedWorkerScriptRule`): `tabIds: [-1]`, `resourceTypes: ['script']`, `requestDomains` and
    `initiatorDomains` = managed sites, `block`. Measured (e2e control): from a CDP isolated world on a managed site in a
    plain tab, `register()` is refused with the rule and succeeds once the rule is removed; the registering page's site is
    the initiator. `initiatorDomains` leaves other sites' workers free to import scripts from a managed site (a CDN). Cost:
    shared workers of managed sites cannot `importScripts` from their own site. Replaced by the global block in strict mode.
  - Strict mode: the existing global no-tab `script` block refuses registration from a plain tab with no script
    registered (e2e, `TypeError` instead of the shim's `SecurityError`). What is lost while no container is in use: the
    shim's guard in plain tabs on unmanaged sites (one layer of two). Residual: at a browser start, until the worker has
    reinstalled the session rules, such a tab could register a worker; the startup sweep removes it, and every restored
    container tab is reloaded only after `prepareNavigation` removed its origin's workers.
  - FrameGuard in plain tabs exists to patch realms with the shim's view; a plain tab without a script has no patched view
    to protect (unmanaged sites have no container data). `data-ctr`, the title prefix and the page name are container-only.
    The agent's overlay and DOM tools use `scripting.executeScript`, independent of the registration.
- **Honest about the noise.** While containers are in use, plain tabs still make the request (and get `{}` or `{g:1}`),
  exactly as before; on managed sites, plain tabs make it while those sites exist.
- **Tests.** Unit (`content-scripts.test.ts`): scopes, order of calls, grace and its cancellation, worker start, stale
  registration, queued downgrade vs. `ensure()`, patterns. e2e (`content-scripts.spec.ts`, own profile): a fresh profile
  has nothing registered, no enabled ruleset and no request from a page (seen over CDP `Network`); strict mode refuses a
  worker from a plain tab and page scripts load; the first container tab is isolated from its first document (cookie view,
  localStorage, no real cookie sent); plain pages make the request while it is open; after it closes (`flushContentScripts`
  skips the grace) only the managed site is matched, a page elsewhere makes no request and registers a worker, a plain tab
  on the managed site hides `__facet:` keys and refuses workers (shim, and the network rule for an unpatched realm, with a
  control); reopening the closed tab registers first and isolates. The fixture now flushes to the "no container tab"
  state before each test, so every suite's first container tab exercises the registration; the strict-mode bypass test
  checks both scopes.

### Closed groups and restorable records never keep `all` (2026-10-13)
- **Report (real profile).** Container created from the popup, group closed with Chrome's "Close group" (saved tab
  group), no container tab left, yet pages kept making the beacon request. The first guess was that the restore's
  restorable records (saved groups, recently closed, 30 days) hold `all`. **Checked in code: they cannot** (`busy()` read
  `starting`, `pending`, `held` only, never `state.records`), and not reproducible in e2e: a group closed with
  `tabs.remove` (records `savedGroup`) goes to `managed` after the grace period, also across a stopped worker, and a plain page
  elsewhere makes no request. So the cause in the real profile is not proven. What was tightened so that nothing but open
  things can hold `all` for long, and so the next report names the cause:
  - The contract is explicit: `all` only for tabs in containers, tabs the restore waits on (matching or held for the user),
    an in-flight move (`hold()`) and the start pass. Restorable-but-absent records are not an input. Unit test covers it.
  - The restore had decisions that emitted no event (a pending tab decided, a held one resolved or closed, the start pass
    over): the scope came down only at the next per-minute alarm. It now calls `changed()` (`RestoreDeps.waitingChanged`).
  - A registration change that fails (Chrome refusing a call) used to leave the scope where it was until the next event. It is
    retried after 10 s, and `status().error` shows the failure.
  - Diagnostics (Settings): "Page scripts: All sites | Container sites only (N) | Off" with the reason ("2 container tabs open",
    "1 tab waiting to be restored", "no containers in use"; "changing in a moment" or the error while the scope differs from
    what is wanted). From `getContentScripts` (`scope`, `wanted`, `reason`, `sites`, `error`).
  - Note for reading reports: on a managed site (one a container used) plain tabs make the request by design
    (`Container sites only`); a profile where the user's test pages are on the same site as the container looks like "all pages".
- **Reopening is still safe** (unchanged mechanism, now tested for a group): the reopened tabs' addresses are blocked by the gate
  until the restore decides; the decision goes through `Facet.assign`, which awaits `scripts.ensure()` (all frames, beacon answers
  first) before the tab reloads. e2e (`content-scripts.spec.ts`): group closed (records `savedGroup`), `flushContentScripts` ->
  `managed`, a page on an unused site makes no request and has no shim; the group reopened -> both tabs in the container, container
  cookies on every request the stand saw, the shim in the first document, scope `all`.

## Group titles: the ⧉ glyph and two-way sync (2026-10-13)
Goal: SplitSession's tab groups must be recognisable at a glance among the user's own, and the Chrome group menu (rename,
recolour) must not fight the container.
- **Title** = `⧉ ` + container name + invisible marker (`groupTitle`, `src/core/restore.ts`), e.g. `⧉ 123`. The name never
  contains the glyph (it is the prefix; only ONE leading glyph is read as the prefix, so a name that itself starts with "⧉"
  would still round-trip).
- **Recognition (decision).** The visible glyph is cosmetic and is NOT evidence: a user group titled "⧉ fake" decides nothing
  (group guard, restore matcher, projection all read `decodeGroupMarker`, the trailing invisible marker). Identity = the
  marker, or the `ownedGroups` map (groupId -> container, `storage.session`) for a group whose marker the user's retyping
  removed. Reason: the marker survived session restore and saved groups before; the glyph can be typed by anyone. Titles of
  earlier versions (name + marker, no glyph) are recognised the same way and rewritten with the glyph: when a restored
  group is taken over (`containerOfGroup`, `ensureGrouped`) and, at worker start, for every marked group Chrome kept
  (`adoptExisting`, which also takes them over). On a takeover the container is the truth (name, colour).
- **Chrome's group editor -> container** (`TabGroupProjection.groupUpdated`, fed by `tabGroups.onUpdated`). Only groups
  SplitSession keeps (`ownedGroups`) are synced; a restored group is taken over and shown as the container is, never the
  reverse (a saved group may hold a name the container had before). The container follows `settle` = 700 ms after the last
  edit (Chrome reports every keystroke; an empty field mid-typing must not be reverted at once):
  - name = title without the marker and the leading "⧉ " (trimmed, collapsed). Empty, longer than 32 or equal to another
    container's name (`checkContainerName`) -> refused: the group's title is set back and a `warn` is logged;
  - colour = inverse of `GROUP_COLOR` (`containerColorOfGroup`); the current container colour wins when it maps to the same
    group colour (the map is one-to-one today, the rule keeps it safe if that changes); grey (no container has it) is refused;
  - whatever the user deleted (glyph, marker) is re-applied; collapsing/expanding changes neither title nor colour, so it is
    not an edit;
  - the change goes through `Facet.updateContainer`, which emits `container-updated`; the container's groups in every window
    follow, so do the popup, badges and the page-name echo.
- **Our own updates** are remembered per group (`expected`: title + colour, 10 s) and their `onUpdated` echo is dropped; any
  other state is judged from the group as Chrome has it when the pause ends, so an echo that arrives late cannot undo a newer
  change. Popup / options edits keep updating the groups as before.
- e2e (`indicators.spec.ts`): titles start with "⧉ "; an outside `tabGroups.update` renames/recolours the container and the
  group of another window; a plain name typed over the title gets glyph and marker back; empty / duplicate names are refused;
  "⧉ fake" without a marker is ignored (its plain tab stays plain); a legacy title is migrated. `restore.spec.ts` (saved
  group reopened with the new title) and `group-drag.spec.ts` pass unchanged. Run alone, `popup.spec.ts` "swap menu never
  scrolls" passes; in one run after the group specs it fails with or without this change (containers left by other specs).

## Removed: the state page and the `run_js` userScripts fallback (2026-10-13)

Two agent features that the MCP bridge made obsolete (2026-10-13). Earlier entries above describe them as they were.

- **`state.html` is gone** (entrypoint, `src/ui/state`, the "Open state page" button in Settings, its e2e and the Lite
  "no state page" probes). Agents use `list_tabs`, `list_containers` and `bridge_info`. `scripts/check-lite.mjs` no longer
  tests for a state file: no edition has one, so the check had nothing left to catch; the `entrypoints:found` hook that
  dropped it from Lite went too.
- **`run_js` has no fallback.** It is `Runtime.evaluate` through the debugger, which works under any page CSP. When the
  debugger cannot attach (a tab SplitSession may not debug, or one that is busy) the tool returns that error. Removed:
  `runViaUserScripts`, the injected `pageRun` / `pageTakeSlot` (and `inject.test.ts`), the options button, and the optional
  `userScripts` permission from the Full manifest (so Full and Lite now differ by `nativeMessaging` and `debugger` only).
  `check-lite.mjs` keeps `userScripts` as a forbidden permission and marker; it is cheap and guards against it coming back.
- Kept: "Profile name" under Advanced.

## Lint and format (2026-10-13)

ESLint 8.57 (classic `.eslintrc.json`) and Prettier 3 (defaults, `.prettierrc.json` is `{}`). `pnpm lint`, `pnpm lint:fix`, `pnpm format`, `pnpm format:check`; CI runs lint and the format check before the typecheck. Phase 1 changed no behaviour: formatting, import order, autofixes, removed unused declarations, narrow `eslint-disable` comments.

- **Stack:** `eslint:recommended`, `airbnb` (+ hooks), `airbnb-typescript`, `@typescript-eslint/recommended`, `import` (+ typescript), `prettier` last; `simple-import-sort` with groups side-effect, external (`node:` and packages), relative, styles. Type-aware (`parserOptions.project` lists the root, `e2e` and `bridge` tsconfigs).
- **Private TypeScript 5.9 for the linter.** TypeScript 7 (the native compiler) has no JavaScript compiler API, so typescript-eslint cannot use it. `.pnpmfile.cjs` gives the lint packages their own `typescript@5.9.3`; `tsc`, the typecheck and the build stay on 7. Drop the hook when typescript-eslint supports TypeScript 7.
- **`import/no-relative-parent-imports` is not enabled.** The layout is `src/{core,engine,background,ui,...}` with 2 to 3 levels of `../`; path aliases would have to be wired into WXT/Vite, Vitest, the esbuild bridge build, Playwright and three tsconfigs, which is a refactor, not a lint setup. Revisit as its own change.
- **Rules turned off, and why:** `no-await-in-loop` (sequential awaits are deliberate), `no-plusplus`, `no-continue`, `no-bitwise` (hashing, flags), `no-underscore-dangle`, `no-nested-ternary` (Prettier formats them), `no-promise-executor-return` (the `new Promise((r) => setTimeout(r, ms))` sleep), `prefer-destructuring`, `no-void` (`void promise` marks a promise left on purpose; there is no floating-promise rule), `consistent-return` (`return;` early exits in async functions), `func-names` (the page shim patches natives with anonymous functions), `no-sequences` (`(await ready, call())` idiom), `class-methods-use-this`, `max-classes-per-file`, `default-case` (switches over unions are checked by `tsc`), `no-multi-assign`, `react/no-unknown-property` (Preact uses `class`, `for`, `onInput`), `no-restricted-globals` (browser-only code; `isNaN` and `isFinite` stay banned). Relaxed: `no-restricted-syntax` keeps for-in, labels and `with` but allows `for...of`; `no-return-assign` and `no-cond-assign` use `except-parens`; `@typescript-eslint/no-use-before-define` ignores functions, classes, variables and types; `lines-between-class-members` ignores single-line members; unused names starting with `_` are fine; `import/no-extraneous-dependencies` allows devDependencies (the extension is bundled); `import/no-unresolved` skips `@modelcontextprotocol/sdk/*` (subpath exports the resolver does not follow; `tsc` checks them).
- **Overrides:** e2e and unit tests may use `any` (page-context evaluate code), `javascript:` URLs and shadowed names; scripts, `bridge`, `test-server` and e2e run in Node and may log.
- **`no-explicit-any` stays an error in `src`** except in seven files with a file-level disable and a reason: `page-dom.ts` and `overlay.ts` (injected, self-contained, duck-typed across realms), `cdp.ts`, `dom-tools.ts`, `router.ts` (protocol JSON and pass-through tool arguments) and the two `listeners` files (the handler types are inferred through `any`).
- **Prettier ignores** `*.md` and `docs/` (prose stays hand-formatted), build output, `public/`, `assets/`, the lockfile and `bridge/dist`.

## Modules by responsibility (2026-10-13)

Phase 2 of the repo cleanup (goal: declarative, easy to read, KISS, DRY). No behaviour change: wire values (storage keys,
`__facet:` prefixes, DNR rule IDs and priorities, message types, `globalThis.facet`) are untouched.

- **Split by responsibility.** `background/facet.ts` keeps the wiring, rehydration and the engine API; its parts moved to
  `background/isolation/`. `background/restore.ts` keeps the state machine; gate, snapshot builder, session state and held
  status moved to `background/restore/`. `core/restore.ts` re-exports its sections from `core/restore/`. The shim is
  `content/shim/` (one module per patched API); `shim/install.ts` lists each mode's patches in their original order. The
  bridge router dispatches through one table; the tools live in `background/bridge/tools/`. The popup is composed of small
  components and two hooks.
- **Shim constraints kept.** Natives are captured when the bundle is evaluated (before any page script), patch order per
  mode is unchanged, and the install loop over the patch table is an indexed loop: a realm can be adopted after page
  scripts ran, and a page may have replaced `Array.prototype[Symbol.iterator]` by then. `beacon.js` behaves identically (not byte-identical: the settings key list is now derived from `DEFAULT_SETTINGS`, same keys and order; independent review 2026-10-13).
- **Lite stays clean.** A module-level table of the bridge tools built with object spread was kept by the bundler in Lite
  (spread may run getters); the table is now built in the router's constructor, so Lite drops every tool.
  `check-lite.mjs` did not catch it (its markers do not include CDP method names).
- **DRY.** `core/async.ts` (`sleep`, `Wakeups`, `Debounced`, `deleteWhere`), one `isHttpUrl` (`core/site.ts`),
  `logFailure` (`background/log.ts`), `on()` for listener registration (`background/on-event.ts`; the listener files no
  longer need `any`), `SETTING_KEYS` derived from `DEFAULT_SETTINGS`, `e2e/extension.ts` for the e2e helpers the specs
  with their own browser had copied.
- **Not renamed:** the `Facet` class and the `facet` variables. Tests construct the router with a `facet` dependency and
  e2e calls `globalThis.facet`; a partial rename would leave two names for one thing.
- **Left as they are:** `core/dnr/rule-compiler.ts` (already constants and per-rule builders, covered by 1,160 lines of
  tests), `bridge/page-dom.ts` and `overlay.ts` (injected with `executeScript`: each must stay one self-contained
  function), `cdp.ts`, `cdp-tools.ts`, `tab-groups.ts`, `group-guard.ts`, `content-scripts.ts` (cohesive, one purpose each).

## Mark on container tabs outside their group (2026-10-14)

Goal: a container tab that is not in its container's tab group (dragged out, or groups off) looks like an ordinary tab.

- **Mark.** `⧉ ` (the glyph of the group titles) at the start of `document.title`, **no container name**. Privacy: the page can read its title, and the name would be the same on every site; with the mark it learns only "this is a container tab". Setting `markOutsideGroup` ("Mark container tabs outside their group", General), default on, **both editions**, schema key in Lite too. The page still learns that fact even with `showNameToPages` off; that is why the switch exists and its text says sites can read titles.
- **When.** Outside = in a container and not in a group that stands for that same container; with `tabGroups` off every container tab (a user group titled like ours but without the container marker does not count as ours). Pinned tabs cannot be grouped, so they carry it too. A tab told "outside" while it is on its way into its group would flash; the background answers only after the group projection's queue is idle (`GroupMark.isOutside`, `refresh`).
- **Channel.** The content script (`src/content/group-mark.ts`, top frame of container tabs, started by the beacon in both editions) asks once (`facet/outside-group`, answered through `Facet.addContentHandler`, which lets the extras answer a content message without the engine knowing them) and the background pushes every change with `tabs.sendMessage(tabId, {type: "facet/outside-group", outside}, {frameId: 0})`: `tabs.onUpdated` with a `groupId`, tab assigned / unassigned, tab attached, `tabGroups` switched. Unassigning sends "not outside" even to a tab never told, so a page that outlives its container loses the mark. The setting itself is read by the content script from `storage.local` and followed live, like the title prefix.
- **One writer for the title.** The name prefix and the mark would have fought ("[Work] ⧉ [Work] Title"), so both are layers of `src/content/title-layers.ts` (mutation observers, 25 writes in 3 s then give up, empty title stays empty: unchanged from the title-prefix script, which now only sets its layer). Layers are written together as `⧉ [name] Title`; `prefixedTitle` now tries the previous prefix first, since the new one may be a prefix or an extension of it. Nothing is observed until some layer has text, so a tab in its group costs nothing.
- **Agents never see it.** `withoutAgentMark` strips a leading `⧉ ` (tab lists, action log, snapshot titles); the injected `pageText` / `pageHtml` strip it from `title` and the `<title>` text. A page that really starts its title with `⧉ ` loses it in agent output; accepted.
- **Tests.** Unit: `indicators`, `title-layers`, `group-mark`; e2e: `indicators.spec` (out / in / setting / groups off / SPA changes / leaving the container / late title), `lite.spec`, `options.spec`, `agent-activity.spec` (list_tabs and get_tab_text exclude it).

## npm-installable bridge, privacy policy (2026-10-14)

- **The bridge is the npm package `splitsession-bridge`** (`bridge/package.json`, `bin` -> `dist/splitsession-bridge.mjs`, the same
  esbuild bundle, no runtime dependencies, Node >= 20, macOS and Linux). One entry point, subcommands: `install`, `uninstall`,
  `status` (people), `host` (Chrome), `mcp` (the AI client). The installer logic moved from `scripts/bridge-install.mjs` into
  `bridge/src/cli.ts` (unit-tested: manifest, launcher, per-browser paths on macOS and Linux, client snippets, the `claude` flow with a
  fake runner); the script is now a wrapper that builds and delegates, so `pnpm bridge:install` and `npx splitsession-bridge install`
  are the same code. `bridge/dist/paths.mjs` is gone (nothing imports it).
- **Client registration.** `--client claude` (the default of the package) runs `claude mcp remove` then `claude mcp add --scope user`
  when `claude` is on PATH, so a re-install replaces a registration that pinned another Node; otherwise it prints. Codex (TOML) and
  Cursor (JSON) are printed, never written: their configs are the user's files. The checkout wrapper defaults to `--client none`, as
  the old script never touched Claude's configuration.
- **`--extension-id`** sets `allowed_origins` (default: the Full extension). The launcher also passes each origin to the host as
  `--allow-origin=...`, because the host used to refuse every origin but the built-in one; the built-in ID stays allowed.
- **Linux** uses `$XDG_CONFIG_HOME` (else `~/.config`) for the host folder and the browsers' `NativeMessagingHosts`; Arc is macOS only
  (`Arc/User Data`, the Chromium convention, not verified). Windows: `install` prints "not supported yet".
- **Publishing** is by hand from the owner's npm account: `docs/release/npm.md`. Not published yet; until it is, `npx
  splitsession-bridge install` in the Settings text does not resolve.
- **Privacy policy** in `docs/privacy.md` (both editions, effective 2026-10-14); `docs/_config.yml` and `docs/index.md` let GitHub Pages
  (from `/docs`) serve it at `/privacy` once the repository is public.

## Split view: two accounts side by side (2026-10-14)

- **Found on the real Chrome.** Joining a tab into a split view with a tab of a SplitSession group "reset" the joined tab
  (logged out, or the wrong account). Chrome keeps both tabs of a split view in one group, so the joined tab lands in the
  container's group, and the group guard reopened it in that container. The point of a split view here is the opposite: two
  accounts of one site side by side.
- **API (Chrome extension docs, `chrome.tabs`).** `Tab.splitViewId` (Chrome 140+, `tabs.SPLIT_VIEW_ID_NONE` = -1 for none),
  `tabs.onUpdated` `changeInfo.splitViewId` (140+), `tabs.query({splitViewId})` (140+); `tabs.createSplit([a, b])`,
  `tabs.unsplit(id)` and `tabs.create({splitWithTabId})` are 155+. `tabGroups` has nothing about split views. Chrome before
  140 has no `splitViewId` and no split view for extensions to see: there the guard behaves as before. No heuristic.
- **Measured (Chromium 156, Playwright).** Grouping or ungrouping one tab of a split view does it to both (each gets its own
  `onUpdated` with `groupId`). `createSplit` needs adjacent tabs with the same `windowId`, `pinned` and `groupId`.
  `tabs.create({splitWithTabId: grouped})` reports `onCreated` with `groupId: -1, splitViewId: -1`, then `onUpdated` with the
  `groupId`, then `splitViewId` for both tabs: the group comes **before** the split view.
- **Rule.** A split view whose tabs are not all in one container (two containers, or a container tab and an ordinary one) is
  never in a SplitSession group: both tabs leave the group and keep their containers; a container tab among them carries the
  "⧉ outside group" title mark (an ordinary tab has no mark, as everywhere). A split view of two tabs of one container stays
  in that container's group. A split view of one container that ends up in **another** container's group also leaves it: the
  guard never reopens or assigns a tab that is in a split view (reopening would also break the split view). When the split view
  is dissolved the tabs stay where they are; "Re-group tabs now" puts each into its own container's group.
- **Group guard** (`group-guard.ts`): after the settle (300 ms for a group change; a tab Chrome creates inside a group now
  waits at least `SPLIT_TICK_MS` = 50 ms, as its split view may be reported after its group) the live tab is read; when it has
  a `splitViewId`, the pair is read (`tabs.query({splitViewId})`) and, unless every tab of it is in the group's container,
  `TabGroupProjection.ungroupSplit` takes both out (retried after a drag like `placeOwn`). This is decided before the
  own-tab, assign-in-place and reopen branches; a partner still being assigned is waited for. Logged as `group guard: tab
  <id> <from> -> <group's container> (<reason>): in a split view not all of this container: the split view taken out of the
  group, containers kept`, with the split view, its tabs and their containers as data. `tabs.onUpdated` with a `splitViewId`
  schedules a sweep, which picks up a mixed pair sitting in a group however it got there.
- **Projection** (`tab-groups.ts`): `ensureGrouped` (assignment, window move, "Re-group", groups switched on, `placeOwn`)
  skips a tab in a mixed split view and takes it out of a container group, since grouping one tab of the pair would pull the
  other in and the guard would take them out again.
- **Tests.** Unit: `group-guard.test.ts` ("split view": plain + container, two containers, same container stays, one
  container in another's group, group reported before the split view, a new tab created into a split view, `-1` / no
  `splitViewId`, drag refusal, sweep, partner being assigned), `tab-groups.test.ts` (never grouped, taken out, regrouped after
  the split view is gone, one container grouped together, `ungroupSplit` refusal). e2e (`group-drag.spec.ts`, skipped where
  `tabs.createSplit` is missing): an ordinary logged-in tab joined into a split view with a container tab: neither reopened,
  both ungrouped, each keeps its login after a reload, the container tab gets `⧉ `; two containers stay out of groups also
  after "Re-group"; a split view of one container stays in its group. Both fail on the previous code (the joined tab was
  reopened). The e2e joins with `tabs.group` + `tabs.createSplit`, not Chrome's own UI (drag onto a tab, "Add tab to split
  view"), whose event order is not measurable from tests: manual check in the release gate (`docs/development.md`).

## Agent dot instead of the amber "ON" and the "AI" badge (2026-10-14)

- **Idle, bridge on:** plain tabs get a one-space badge on the agent purple (`#8b5cf6`, `AGENT_COLOR` moved to
  `src/core/indicators.ts`, so `badges.ts` does not import the Full-only overlay module); container tabs keep their container
  dot, with no letters. Bridge off: no purple dot. Held `!` and the move notice (`→`) keep priority over the dot and the blink.
- **Blink instead of "AI":** while the agent works with a tab the dot of that tab blinks, four steps of 125 ms (a 0.5 s
  cycle): purple and `#c4b5fd` on plain tabs, the container colour and purple on container tabs (the light purple when the
  container is purple itself). Colours between are opaque mixes (`mixHex`), since badge colours take no reliable alpha.
  `AgentActivity` still decides start and end (each touch re-arms an end timer `ACTIVITY_TTL_MS + 150` ms long); `BadgeIndicator`
  owns the interval (`startBlink` / `stopBlink` / `stopAllBlinks` / `forget`) and repaints through `apply`, so a navigation in
  the middle of a blink, a notice or a held tab cannot be overwritten. The interval exists only while a tab blinks; it ends on the
  end timer, "Show agent activity" off or bridge off (`stopAll`, and `apply` ends it when the bridge is off), and tab removal. A
  sleeping worker loses its timers, and the idle dot is what a restarted worker paints. Setting off: `touch` returns before the blink.
- Tests: `badges.test.ts` (state machine, no leaked timers), `activity.test.ts` (start, re-arm, end, stop), `mixHex`; e2e samples the
  badge colour a dozen times during a tool call and checks the idle dot before and after (`agent-activity.spec.ts`).

## Restoring containers from leftover tab groups after a reinstall (2026-10-19)

- **Incident.** The user removed and reinstalled the extension. Chrome wiped `chrome.storage` (containers, cookie jars), the
  popup said "No containers yet", and the tab groups "⧉ main", "⧉ secondline", ... stayed in the window with their tabs,
  orphaned. Cookies are not recoverable (they lived only in the wiped storage). The structure is: every SplitSession group
  title still carries the invisible marker naming its container.
- **Offer, not automatic.** `getGroupRestoreOffer` returns the plan only when there is **no container at all**, the user has
  not dismissed it (`groupRestoreDismissed` in `storage.local`, so a flag is per install and a reinstall starts clean), and a
  group with a marker exists (`decodeGroupMarker`: the visible `⧉` is not evidence, a user group titled "⧉ fake" is never
  offered). The popup shows one quiet row above the list ("Found N tab groups from an earlier install. Restore them as
  containers?", Restore, x). Nothing is done without the click: creating containers also turns on isolation for those tabs.
- **Same ID.** The container comes back under the ID the marker names (`ContainerStore.createWithId`, `Facet.restoreContainer`;
  the public `createContainer` still cannot choose an ID). So (1) the group is already the container's group: no retitle, no
  regroup, no second group, nothing for the group guard to "fix", `TabGroupProjection` adopts it by its marker as it does for
  a group Chrome restored; (2) the page storage prefix `__facet:<id>:` of the old tabs matches again, so storage-based sessions
  can survive. Groups with one marker in several windows are one container; the name is the title without glyph and marker
  (cut to 32 characters, "Container" when empty, ` 2` for a clash); the colour is `containerColorOfGroup` (Chrome cyan is
  turquoise; grey, which no container has, gets the first unused colour). Pure part: `src/core/group-restore.ts`.
- **Tabs.** The tabs of each marked group are handled as the group guard does (`src/background/group-restore.ts`). A loaded
  website (http(s), loaded by Chrome, not discarded) is **reopened in a fresh tab** of the container (`Extras.reopenInContainer`,
  the guard's `move`: `Facet.replaceTab` -> `TabOpener.replaceTab`, same window and index, no opener; it joins the group, then
  the old tab is closed). A first version reloaded the old tab, which keeps its browsing context: a window that held a
  reference to it (`window.opener` of a popup the tab had opened) could still script the container's page and storage after
  the restore (found in review). The groups are adopted right after each container is created, so the new tab joins the old
  group and no second group is made. A tab that has loaded nothing (discarded, unloaded, `chrome://`) is assigned where it
  stands (`Facet.assignInPlace`), keeps its ID and loads nothing: it has no live document for anything to hold a reference to,
  and what it loads later is already the container's. A tab that cannot be handled is counted ("N tabs could not be moved
  in") and the group guard fixes it at its next sweep.
- **Races (second review).** (1) The restore awaits every tab in turn, so a tab list taken earlier goes stale. Each tab is read
  again right before it is handled (`tabs.get`): gone, or no longer in that group (the user dragged it away) -> skipped and left
  to the group guard; loaded or loading -> reopened. A tab that loaded nothing is assigned in place and then read once more: a
  navigation that began before the container's rules were active shows as a tab that is no longer unloaded or discarded (or has a
  pending website address), and such a tab holds a live plain document, so it is reopened too (`handleTab`). A navigation that
  begins after the assignment is the container's own. In-place assignment of http(s) tabs was kept (no reopen of every unloaded
  tab) because the check should close the window: a navigation's start (`pendingUrl`, `status`) is browser-side state set before its first
  request, so a state change is not expected to hide from the second read (an assumption, not measured). Reopening a never-loaded tab would instead have to load it once
  in the new tab (Chrome offers no create-discarded for a given URL), which sends requests the user never asked for.
  (2) Two callers moving one original tab (the guard's sweep, the restore) each created a fresh tab and each closed the
  original: two survivors. `TabReopener` (`tab-reopener.ts`, behind `Extras.reopenInContainer`) keeps one in-flight move per
  original tab ID; a second caller gets the first one's result, and the entry is dropped when the move ends, failed or not.
- **Accepted residual risk (third review).** Between the in-place assignment of an unloaded or discarded tab and its re-read,
  Chrome may resume the tab's plain document; in that instant the document can send requests under the just-created
  container's rules before `handleTab` replaces it. Accepted: restore runs only with zero containers (the guard in
  `src/core/group-restore.ts`) and each container starts with an empty cookie jar (`ContainerStore.createWithId`), so the
  worst case is a few requests without cookies, or a cookie set by them landing in a jar that tabs restored earlier in the
  same run may have started filling. Closing it would mean reopening every unloaded tab, which loads pages the user never
  asked for (see Races above).
- **After.** One line in the popup: "Restored N containers. Sign in again: a reinstall removes saved logins." The dismissed flag
  is set on a successful restore too, so leftovers are not offered again.
- **Warning before it happens.** Settings, Advanced, Export and import: "Removing SplitSession deletes its containers and their
  sign-ins. Export first if you plan to reinstall." in the secondary text next to Export. `runtime.setUninstallURL` and any
  popup or nag were considered and rejected.
- **Tests.** Unit: `core/group-restore.test.ts` (title -> name, colour, ID, dedupe, only marked groups, only with zero
  containers and no dismissal), `background/group-restore.test.ts` (offer, dismiss, reopen / assign-in-place split, failed tab, refusal),
  `stores.test.ts` (`createWithId`). e2e: `restore-from-groups.spec.ts` (storage wiped and the worker stopped, as a reinstall
  leaves it: the offer counts only the marked groups, Restore keeps the same group IDs, no group appears or empties,
  loaded tabs are replaced (new ID, same window, index, group and address, no opener, old tab closed, a plain popup that had
  `window.opener` to it has none to the new tab), the discarded one keeps its ID, the user's plain and look-alike groups
  are untouched, the guard logs nothing; dismiss is remembered).

## Saved tabs: an automatic snapshot of the last batch, not a "save tabs" button (2026-10-20)

- **The user story.** "I delete a container's tab group so it does not take space on the bookmarks bar, but when I click the
  container in the popup I want all its tabs back." A container is an account (cookies and storage), so deleting its group
  closed the tabs and lost them.
- **Why automatic, and why the last batch.** A manual "save these tabs" button asks the user to remember to press it before
  deleting the group, which is exactly the step they want to skip; people forget it and find out when the tabs are gone.
  So the extension snapshots by itself, but not on every change: when a container goes from open tabs to none, the set is the
  tabs that closed in the last **batch** (closures within 1.5 s of each other, chained: one group delete, one window close or
  Cmd+W on a group closes its tabs at once). If the user closed tabs one by one over time, the saved set is only the last
  batch: those they closed deliberately earlier are not wanted back. Saving the whole history of a container or a continuously
  updated "session" was rejected: it grows without bound, brings back tabs the user closed on purpose, and keeps more
  addresses than the feature needs.
- **What is kept.** Address and title, in order (window, then position), http(s) only, at most 50 per container, in
  `chrome.storage.local` under `savedTabs` (`SavedTabsStore`); the container's record does not change. Pinned state is not
  kept (tabs come back unpinned). Tabs the container still has open are not touched, and when the container has tabs again the
  saved set stays until the next close-to-zero replaces it (a set whose batch would hold no web page is not written, the old one
  stays). Deleting the container deletes its set.
- **Where it is judged.** `SavedTabsRecorder` (`background/saved-tabs-recorder.ts`): the last known address, title and position
  of every container tab (from `tabs.onUpdated` and a refresh after layout changes, also kept in `storage.session` so a tab that
  closes while the worker sleeps is still known), and on each `tabs.onRemoved` of such a tab a closure goes into a per-container
  log (`ClosureLog`, `core/saved-tabs.ts`). Whether the container has any tab left is decided from the engine's registry minus the
  tabs closed lately, because the registry drops a closed tab asynchronously. Positions are frozen while a batch is closing,
  so the order is the one before the closing started. Tabs SplitSession closes itself while moving a page to another container
  (domain rule, group guard, the choose page) are not closures.
- **Browser shutdown must not overwrite the set** (Chrome puts those tabs back itself, and the restore feature puts them in their
  containers). `tabs.onRemoved` reports `isWindowClosing` for a window close as well as for the browser quitting, and the two
  cannot be told apart at that moment. A batch that includes tabs closed with their window is therefore **not saved at once**:
  it is saved 2.5 s later, and only if some browser window still exists then (and no tab came back). A worker that dies with
  the browser never reaches that point. Closing the **last** window is treated like quitting (no window is left at that
  moment), so on macOS, where Chrome stays running, closing the last window saves nothing; Chrome's own "Reopen closed window"
  covers it. Closing one of several windows saves normally.
- **Popup.** A container with no open tab and a saved set shows "N saved" (muted) in place of the tab count; its main button
  says "Reopen N saved tabs". Clicking it calls `openSavedTabs` (`SavedTabsReopener`, `background/saved-tabs-reopen.ts`): each tab is opened with the same path as the "+" button and `open_in_container` (`Facet.openInContainer`: created at `about:blank`, assigned to the container, then navigated), one after the other so the order and the group follow, the first one active, in the window the popup belongs to. Progress is durable: an entry leaves the stored set only after its tab is open, so a worker or browser that dies half way leaves the rest saved (a first version cleared the whole set up front and lost up to 50 addresses). One reopening per container at a time; a second request (double click, two popups) gets the first one's result. A tab that fails to open stays saved. A tab assigned to the container begins a new open cycle and clears the closure log, so a set reopened and closed again within 1.5 s is not merged with the closures of the first cycle; a set lists an address once. A tab opened for a saved entry is seeded into the recorder with that entry's address and title before the entry leaves the store (until its navigation commits it shows `about:blank`), and the recorder prefers a loading address (`pendingUrl`) to `about:blank`, so closing tabs that are still loading loses nothing. When a batch is saved and the container still has an unopened remainder, the batch goes first and the remainder follows (one entry per address, at most 50): closing a partly reopened set does not delete the rest. With nothing saved the row
  behaves as before. "Forget saved tabs" is in the edit form (the pencil); no `confirm()`.
- **Setting.** Settings, General: "Remember tabs when a container's last tab closes" (`rememberTabs`, on by default, both
  editions). Off forgets every saved set at once (the other choice, keeping the sets until forgotten, would leave addresses on
  disk that the user just said not to keep).
- **Export / import.** "Also include tabs (open and saved)" writes a `tabs` field (`{ containerId: [{url, title}] }`, like
  `jars`): the container's open tabs in order, then its saved ones not already among them, at most 50. An import stores them as
  the container's saved set (replacing what it has) and opens nothing. The format version stays 1: the field is optional, old
  files import unchanged, and a SplitSession that does not know the field ignores it. An import into a profile with the setting
  off stores the tabs anyway (the user asked for it in the file).
- **Tests.** Unit: `core/saved-tabs.test.ts` (batching, ordering, cap, non-web skipped), `background/saved-tabs-recorder.test.ts`
  (group close, one by one, gap, shutdown cases, a worker that slept, setting off, moved tabs), `engine/storage/saved-tabs-store.test.ts`,
  `core/transfer.test.ts` (round trip, old file). e2e: `saved-tabs.spec.ts`.

## A Drupal login failed the first time in a container (2026-10-20)

- **Report.** Lite 0.1.1 from the Store, a Drupal 10 Commerce site: logging in inside a container tab showed Drupal's "To
  log in to this site, your browser must accept cookies from the domain …"; the second try worked (as reported, not
  reproduced by us). Other cookies (consent) of that site persist in the container.
- **Drupal's flow, measured on the site** (curl, anonymous): the login form POSTs and is answered with an immediate redirect
  carrying `Set-Cookie: SSESS…=<session>; domain=.<host>; secure; HttpOnly` to `/user/<id>?check_logged_in=1`. That page, asked
  without a valid session (no cookie, or an unknown one), answers `302` to `/user/login?destination=…` **with a new anonymous
  session cookie** that holds the error message.
- **Root cause (stand, Chromium 156).** Chrome follows the redirect before the container's rules carry the new session: the
  server log shows the hop to `?check_logged_in=1` going out with no cookie (or the old anonymous one) 3 ms after the POST,
  every run. The stale-hop detector already repeats such a GET once it completes, but the stale hop's own answer had been
  imported first: its anonymous `SSESS…` replaced the login session in the jar, so the repeated navigation went out
  anonymous too and ended on the error. So the race was not the bug; importing the stale answer was. (Not a domain-scoping
  problem: the stand sets `domain=.<host>` like Drupal and the repeated hop carries it; a parent `Domain` reaching
  subdomains is covered by the existing "Domain cookies reach subdomains" e2e.) A login within
  1 s of the tab's assignment happened to be protected by the assignment check (`headerFromJar`), which is why the stand's
  "anonymous session first" variant needs a 1.2 s pause to fail.
- **Fix** (`CookieCapture.harvest`, `src/background/isolation/cookie-capture.ts`; decision in
  `src/engine/capture/stale-response.ts`). Every jar change is remembered with its window `[from, rules resolved + 1 s)`
  (`RecentCookieChanges`, opened synchronously in `afterJarChange`, so a stale answer that arrives before the rules resolve
  is covered). For a **main-frame GET** sent inside a window whose `Cookie` header does not reflect a change that applies to it
  (host, path, Secure, not Strict, not partitioned; same test as the detector plus RFC 6265 path-match), a `Set-Cookie` with
  that change's jar identity (name, domain, host-only, path, partition) is **not imported**; its other cookies are. The
  detector then repeats the navigation with the login session, as before. In a plain browser that request would have carried
  the new value, so the server could not have meant to replace it.
- **Rejected.** Re-issuing the redirect ourselves (`tabs.update` to the `Location` after the rules update): the detector
  already does exactly that for GET hops; the missing piece was the jar, and a second re-navigation path would race the first.
  Dropping **every** `Set-Cookie` of a stale answer: the repeat would usually bring them back, but not when the detector's
  per-tab budget is spent or the tab moved on, and unrelated cookies would be lost. Delaying the redirect (a blocking
  `webRequest` listener) is not available to MV3 extensions outside policy installs.
- **Not covered (limits.md).** 307/308 login redirects (the next hop is a POST: never repeated, its answer imported; POSTs
  are excluded from the rule because a cross-site POST legitimately goes without Lax cookies), redirects followed inside
  fetch/XHR (the barrier waits only for the final response), logins inside iframes.
- **Tests.** e2e `cookies.spec.ts` "a Drupal-style form login … succeeds on the first try" (stand: `/drupal/user/login`,
  `/drupal/user/1`, modelled on the measured flow): 303, 303 over an anonymous session, 302. All three failed before the fix
  (the page ended on the login form with the error) and pass with it. Unit `stale-response.test.ts` (window bounds, per
  container, GET only, path/host/Secure/Strict/partitioned exclusions, identity match, deletions).
- **Review follow-up (GPT-6.1 Sol via Codex, same day).** Two false matches, both fixed in a second commit:
  (1) every retained change was checked on its own, so after `sid=A` then `sid=B` a normal GET carrying `B` still "missed"
  `A`, and its rotation or logout (`Max-Age=0`) was dropped; the detector had the same false match. Now only the **latest
  change per cookie identity at the request's send time** is an expectation (`latestAt`, `stale-detector.ts`, used by both
  `RecentCookieChanges.missedBy` and the detector's window check). (2) A deletion was judged by name only, so with a host-only
  `sid` deleted beside a surviving Domain `sid`, a correct request carrying the Domain one looked stale. A deletion now
  carries the deleted cookie's last value (`previousValue`, read from the jar before the write, also for `document.cookie`
  deletions) and only `name=previousValue` in the header is evidence; without it the deletion is no expectation (importing
  beats dropping). Tests: `background/isolation/cookie-capture.test.ts` (CookieCapture with a real jar and detector: the
  Drupal hop, A->B->C rotation, logout carrying B, the host-only/Domain pair; the last three failed on `8eddce7`), plus unit
  cases in `stale-response.test.ts` and `stale-detector.test.ts`.

## Two copies of SplitSession in one profile (2026-10-21)

- **Incident.** A user had two copies enabled in one Chrome profile (Lite and Full; the same happens with the Store Lite
  beside a GitHub or unpacked one). Both rewrite `Cookie` headers, both capture `Set-Cookie` into their own jars and both run
  the tab-group guard: logins did not stick and tabs reloaded without end. Nothing told the user why.
- **Decision.** Warn, do not fix. Each copy answers one ping from the other known copies and pings them itself
  (`src/core/copies.ts`, `src/background/copies.ts`): `runtime.onMessageExternal` answers exactly `{ type:
  "splitsession.ping" }` from the Chrome Web Store Lite (`hhodioekcdmhpocjbkjnblmbmchddphf`) or Full
  (`hapfikidacgfgnnajkgnaednpgnhmffk`) with `{ type: "splitsession.pong", edition, version }`, and nothing else (no other
  data, no actions). The popup and Settings > General show a warning with an "Open extensions" button (`tabs.create` of
  `chrome://extensions/?id=<other>`; an extension may open that, a web page may not). Detection runs at install and browser
  start and when the popup or settings open; a found copy is remembered for a minute, "none" for ten seconds (a failed ping
  costs nothing, and a copy enabled a moment later should show up soon).
- **Why `externally_connectable`, not the `management` permission.** `management` would list every extension and show
  "Manage your apps, extensions and themes" at install (a warning for every user, in a store review where we already ask for
  all sites). `externally_connectable` with `ids` and no `matches` is not a permission: no install warning, no web page can
  connect, and only the two named IDs can message the extension. `scripts/check-lite.mjs`, which used to forbid the key,
  now requires exactly that list in Lite.
- **Limits** (docs/limits.md). An unpacked extension's ID is derived from its folder's path, so two unpacked Lites cannot
  find each other (an unpacked Lite finds the Store Lite and Full, and they find it only when it is one of the two IDs).
  A copy that predates this check does not answer. The other copy is never turned off by SplitSession.
- **Rejected.** `management` (above). Detecting a rival by its effects (a cookie written by someone else, a second
  `declarativeNetRequest` rule set): no API names the other extension, and the symptoms are the ones users already saw.
  Making the second copy stand down by itself: it needs a shared lock across two service workers that die at any time, and
  a copy that disables itself surprises the person who chose it.
- **Tests.** Unit `core/copies.test.ts` (the ping answered only from known IDs and only in its exact shape, no receiver means
  none, a pong means found, the cache), `background/copies.test.ts` (the listener and detection through a stub browser). e2e
  `duplicate-copies.spec.ts`: Lite and Full in one profile, each popup and Settings warn about the other with edition and
  version, "Open extensions" opens `chrome://extensions/?id=<other>`, a copy alone shows nothing. The spec builds its own Full
  with the Lite's path-derived ID added by the build-time variable `FACET_TEST_COPY_IDS` (no runtime setting).

## Agent activity mark on the tab group's title (2026-10-22)

- **Need.** The glow, the favicon ring and the blinking dot show the agent in a tab, but a collapsed tab group hides its
  tabs, and the group is where the user keeps the container. They want to see "the agent is in this account" on the group.
- **Decision.** While the agent acts in any tab of a SplitSession group (a group that carries a container's marker), the
  group's title leads with `◉ ` instead of `⧉ `: `⧉ main` becomes `◉ main`, name and invisible marker untouched; visible when
  collapsed. Full only, behind `__FULL__` and the existing "Show agent activity" setting (no new setting).
- **No second clock.** `AgentActivity.blink` already owns the toolbar dot's timer (re-armed by every action, ends
  `ACTIVITY_TTL_MS + 150` ms after the last one). `GroupActivityMark` (`bridge/group-activity.ts`) is started from `blink` and
  stopped from the same timer's end, from `stopAll` (setting or bridge off) and from `forget` (tab closed). It counts active
  tabs per group (the group is looked up once per tab per activity, so a burst is one lookup), and a tab that joins, leaves or
  changes group meanwhile moves the count (`tabs.onUpdated` with `groupId`).
- **Where the title is written.** `TabGroupProjection.setActivity(groupId, on)` (Full), serialised in the projection's queue
  with every other group write. It keeps `activity` (a memory set of marked groups) and swaps only the glyph of the live title
  (`groupTitleWithGlyph`), so a half-typed edit is not lost. A change that does not change the state writes nothing: one
  update per transition. Only groups the projection keeps, only titles that still carry the container's marker; a retyped
  title is put right by the sync, which now builds the wanted title with the glyph for the group's state (`wantedFor`).
- **Sync ignores it.** The write goes through `applyGroup` like every projection write: it registers an expected
  `(title)` entry (colour optional, so a title-only update matches), marked `quiet`. `tabGroups.onUpdated` goes to
  `Extras.handleGroupUpdated`, which first asks `takeMarkEcho` (consumes only quiet entries) and drops the echo: no sync and
  no guard sweep. A reached `groupUpdated` consumes any expected entry as before. As a second line, `groupNameOf` strips
  a leading `◉` like `⧉`, and `normalise`/`containerUpdated` use `wantedFor`, so even an unrecognised echo could neither rename
  the container nor remove the mark. A user rename while marked is not an echo: the container follows, and
  `applyToGroups` writes the new name with `◉` (while marked) and later `⧉`. Lite keeps `⧉` only: the regex, the `◉` prefix and
  the method bodies are under `__FULL__`; `check-lite` passes and the Lite bundle has no `◉`.
- **Clean-up.** The mark lives in memory only. `adoptExisting` (every worker start) rewrites any `◉ ` title of a group that
  carries a container's marker and is not marked now (also with groups off or for a deleted container); user groups
  without the marker, even titled `◉ …`, are never touched. Bridge or setting off restores at once.
- **Rejected.** A new timer for the group (a second clock would drift from the dot). Writing the title from the container
  name every time (it would overwrite a pending edit; the glyph swap on the live title does not). Marking per tab (Chrome has
  no tab-level title in a group). Persisting the active set (a stale `◉` after a crash is worse than a missed one).
- **Tests.** Unit: `restore.test.ts` (glyph swap with and without marker, idempotence, `◉` name stripping),
  `tab-groups.test.ts` (set/restore, one update per change, echo dropped, user rename and container rename while marked, plain
  and retyped groups, groups off, removed group, clean-up at start incl. groups off), `group-activity.test.ts` (counting,
  plain group, group moves, `stopAll`), `activity.test.ts` (the mark rides the dot's clock). e2e (`agent-activity.spec.ts`):
  mark on a collapsed group, one change each way, container name unchanged, fade; rename while marked; setting and bridge off;
  plain group and a tab leaving the group; leftover `◉` cleaned after a worker restart.
- **Review fixes (2026-10-22).** (1) The glyph swap uses the same whitespace-aware prefix as `groupNameOf` (`" ◉ Job"`, `"◉Job"`
  get one glyph, not two), and the sync refuses a name that still starts with `⧉`/`◉` (a second glyph typed by the user): a container
  name never starts with a group glyph through this path. (2) Chrome has no compare-and-set for a group title, so a mark write
  can still land on top of a rename in the instant between our read and write. Two defences: `showActivity` reads the title again
  right before the write and works the swap out from the new title when it changed; and the sync takes the typed name from
  the title the user's `onUpdated` event reported (`syncEdited(groupId, seen)`), not from a re-read of the group, so an
  overwritten edit is still applied (the container is renamed and the mark is written on the new name). Tests: both races
  (`tab-groups.test.ts`), the whitespace and second-glyph cases (`restore.test.ts`, `tab-groups.test.ts`).

## The agent group mark gets the agent's colour and a pulse (2026-10-22)

- **Request.** The `◉` alone was easy to miss. While the mark is on, the group takes the agent's colour and the glyph pulses.
- **Decision.** (1) The group's colour becomes **purple**, or **red** when the container is purple (`agentGroupColor`,
  `core/indicators.ts`), and the container's colour comes back at the end. (2) The glyph alternates `◉` and `○` once a second
  (`PULSE_MS`), one title-only `tabGroups.update` per tick per marked group; the colour does not change during the pulse. The
  start is one write (glyph and colour together), the end is one write (`⧉` and the colour). One `setInterval` in the
  projection runs while some group is marked and is cleared when the last mark goes (also on group removal, container deletion
  and "groups off"). Nothing is written when nothing differs.
- **Echoes, now for the colour too.** A write is registered with the full state its echo must report (`applyGroup`'s `after`):
  a title-only tick expects the colour the group had, so a recolour by the user between two ticks is not taken for our echo.
  The quiet entries are consumed by `takeMarkEcho` (before the sync and the guard sweep), as before.
- **User edits while marked.** The sync reads the colour from the user's event, like the title. An event that reports the
  agent's colour is ours, not a choice (a colour the user picks that equals the mark colour cannot be told apart and is
  ignored while marked; a purple container's mark is red, so picking red there is ignored the same way). Any other colour
  recolours the container, `applyToGroups` writes the mark on top of it (the agent's colour is recomputed for the new container
  colour), and the restore at the end uses the new container colour.
- **Same race handling as the title.** Title and colour are read again right before the write; when either changed, the values
  are worked out again from the new state. A user edit that slips in after that is not lost: the sync takes it from the event.
- **Names.** `○` is a group glyph like `◉` and `⧉`: `groupNameOf`, the whitespace-aware glyph swap and `hasActiveGlyph` know it,
  and the sync refuses a name that starts with any of the three.
- **Clean-up at the worker's start.** `adoptExisting` puts `⧉` and the container's colour back on any of our groups (marker
  present) that shows `◉` / `○`, also with groups off; for a deleted container only the title. User groups without the marker
  stay as they are.
- **Lite.** The `○` prefix, the pulse timer and the regexes are under `__FULL__`; the Lite bundle has neither glyph.
- **Tests.** Unit: colour choice (purple / red), colour echo, title-only tick echo, user recolour while marked and the restore
  colour, both races for the colour, the pulse (alternation, one title-only write per tick, timer stops), `○` in names, clean-up
  of title and colour. e2e (`agent-activity.spec.ts`): purple and alternating glyph on a collapsed group, container name
  and colour unchanged, restore after the fade; red for a purple container and bridge off restores at once; setting off;
  leftover `○` and purple cleaned after a worker restart.
- **Review fix (2026-10-22).** The mark context is captured when the user's edit event arrives (`groupUpdated`: marked or not, and
  the agent's colour then) and travels with the pending edit; settling no longer asks whether the group is marked now. A rename
  made while marked whose pause ends after the mark did could otherwise save the agent's purple into the container. An event
  received while unmarked keeps its colour even if the mark starts before the pause is over. Both are unit tests.

## The group glyph breathes in four frames (2026-10-22)

- **Request.** Two frames at one second looked jerky. The glyph now cycles **◉ → ◎ → ○ → ◎** and starts again, one frame every
  `PULSE_MS` = 400 ms (a breath of 1.6 s).
- **Decision.** `GROUP_PULSE` (`core/restore/group-marker.ts`, empty in Lite) lists the frames; the projection keeps the frame
  index per marked group (`activity: Map<groupId, frame>`), one title-only write per tick per marked group, nothing when the
  title is unchanged, title and colour re-read before the write as before. The start is still ◉ with the agent's colour, the
  end ⧉ with the container's colour. `◎` is a group glyph like `◉`, `○` and `⧉` for `groupNameOf`, the whitespace-aware swap,
  `hasActiveGlyph` (start-up clean-up) and the sync refusal: a container name never starts with any of the four. The Lite bundle
  has none of ◉ ◎ ○ (checked after `build:lite`).
- **Cost.** 2.5 title writes a second per marked group instead of 1 (each also reads the group twice). Only while the agent
  works; the timer stops with the last mark.
- **Tests.** Unit: frame order over two breaths, no write before the first tick, ◎ in titles, names, refusals and clean-up.
  e2e asserts timing-robustly: only frames of the pulse appear, at least three distinct, every change differs, colour constant,
  restore to ⧉ and the container's colour.

## The agent group mark pulses the colour, not the title (2026-10-22)

- **Feedback.** Changing the glyph (◉ ◎ ○) changed the width of the group chip, and the tabs next to it jumped on every frame.
- **Decision.** The title is never written by the mark: it is always `⧉ name` + the invisible marker. While the agent works in a
  group, only its **colour** changes: purple and pink alternate every `PULSE_MS` = 600 ms (`agentGroupColors`,
  `core/indicators.ts`); for a purple or pink container the pair is red and orange. The end restores the container's colour.
  One colour-only `tabGroups.update` for the start, one per tick per marked group, one for the end; nothing is written when the
  colour is already the wanted one. The glyph frames, `GROUP_PULSE` and the title swap are gone.
- **Kept from the earlier design.** The writes are quiet echoes: `applyGroup` registers the full state its echo must report
  (title as read, the new colour), so a rename or a recolour by the user between two ticks is not taken for ours; the sync and the
  guard sweep ignore ours (`takeMarkEcho`). The decoration context is captured when a user's edit event arrives (`markColors`:
  the pair the group pulsed between): a colour equal to either of them from an event received while marked is never synced,
  also when the mark ended before the pause; any other colour recolours the container, the pair is recomputed for the new
  colour, and the end restores it. Title and colour are read again right before the write; a user edit that slips in after
  that is applied from their event. A user pick equal to a pulse colour cannot be told from the mark and is ignored while marked.
- **Clean-up at the worker's start (only groups with our marker).** Any group that is not marked now and wears one of its
  container's pulse colours while the container's own colour is different goes back to the container's colour, with groups on
  (`normalise`, as for every taken-over group) or off (`clearLeftoverMark`). The glyphs `◉ ◎ ○` that 0.1.5-dev builds wrote are
  still recognised for one release (`groupNameOf`, the whitespace-aware prefix, `hasLegacyMarkGlyph`, the sync refusal, so a container
  name never starts with ⧉ ◉ ◎ ○) and are replaced by `⧉`; remove that after the release that follows 0.1.5. Lite never had
  them: the regexes are under `__FULL__` and the Lite bundle contains none of ◉ ◎ ○.
- **Tests.** Unit (`tab-groups.test.ts`, `restore.test.ts`): the pair choice, colour-only writes, alternation and timer,
  echoes, rename and recolour while marked, the context captured at the event, both races, clean-up (colour and legacy glyph, with
  groups on and off), `agentGroupColors`. e2e (`agent-activity.spec.ts`): the colour alternates between the pair on a collapsed
  group with the title constant `⧉ name` throughout and the container unchanged, restore after the fade; red/orange for a
  purple container and bridge off restores at once; a user recolour and a user rename while marked; setting off; clean-up after a
  worker restart.

## The agent group mark blinks an emoji in the title; the colour is left alone (2026-10-23)

- **Feedback on 0.1.6.** The purple/pink colour pulse looked like a traffic light. The earlier glyph frames (◉ ◎ ○) had made the
  group chip change width and the tabs jump.
- **Decision.** The group's colour is never written by the mark. The title glyph becomes a coloured emoji that blinks:
  `⧉ name` → `🟣 name` ↔ `⚪ name` every `BLINK_MS` = 600 ms while the agent acts, `⧉ name` after the fade. The two emoji are
  equally wide, so a blink should not move the tabs; only the start and the end change the width (not measurable from the
  extension: the chip's box is not exposed; the e2e suite checks the sequence of titles and that the colour is constant).
- **Reused from the first title mark (ae20c42, b39cb45), reviewed there.** `TabGroupProjection.setActivity` / `showActivity`:
  a swap of the leading glyph on the live title (name and marker kept), one title-only write per transition and per tick, none
  when unchanged; quiet echoes (`applyGroup`'s `after` pins the colour the echo must carry; `takeMarkEcho` before the sync and
  the guard sweep); title and colour re-read right before the write; a user rename while marked syncs from the event's title
  and the mark stays on the new name; only groups with our marker are marked. The colour work of 0.1.6 is removed: the pulse
  pair, the pulse-colour exclusion in the sync and its doubt (a user pick equal to a pulse colour was ignored) are gone, a user
  recolour simply syncs. `markColors` (event-time context) is gone with it.
- **Emoji in the prefix matcher.** `🟣` is a surrogate pair and `⚪` may arrive with U+FE0F, so the matcher is a `u` regex with
  an optional `\uFE0F`: `^\s*(?:(?:[⧉◉◎○⚪]|🟣)\uFE0F? ?)?`. `groupNameOf`, the glyph swap, `hasMarkGlyph` and the sync refusal use
  it, so a container name never starts with ⧉ 🟣 ⚪ ◉ ◎ ○. Everything but `⧉` sits behind `__FULL__`: the Lite bundle has none of
  them (checked after `build:lite`).
- **Clean-up at the worker's start (groups with our marker).** A blink emoji or a `◉ ◎ ○` (0.1.5-dev) goes back to `⧉` (groups on:
  `normalise`; groups off or a deleted container: `clearLeftoverMark`). The colour: see the scope fix below.
- **Tests.** Unit: emoji prefix matching incl. U+FE0F and spaces, frames and wrap, blink order and timer, one title-only write per
  tick, echoes, rename and recolour while marked (recolours, purple and pink included, simply sync), both races, clean-up of
  legacy glyphs and stuck colours with groups on and off. e2e (`agent-activity.spec.ts`): the title alternates 🟣/⚪ on a collapsed
  group with the colour constant and the container unchanged, ⧉ after the fade; user recolour and rename while marked; a purple
  container keeps its colour; bridge or setting off restores at once; plain groups; clean-up after a worker restart.

## Colour clean-up scope: never with groups off (2026-10-23)

- **Review finding.** The clean-up that put the container's colour back on a group wearing one of the 0.1.6 pulse colours ran on
  every worker start, also with groups off, and judged by palette membership. A palette colour cannot prove that 0.1.6's pulse
  left it: a blue container with a purple group that the user chose was reset to blue on every start.
- **Decision.** `clearLeftoverMark` (the path for groups SplitSession does not keep: groups off, or a deleted container) now only
  turns a mark glyph back to `⧉`; it never writes a colour, and `agentGroupColors` is gone. The glyph cleanup stays on every
  start (unambiguous).
- **What about a group left in a pulse colour by 0.1.6?** With groups on, the take-over at the worker's start
  (`adoptExisting` -> `normalise`) already sets every marker-bearing group to its container's colour (the container is the
  truth: since the groups feature exists, a restored group is shown in the container's current form, and while the worker lives the
  two-way sync keeps group and container equal). That puts a stuck pulse colour back, with no palette guess and no migration to
  persist, so no `runtime.onInstalled` migration or done-flag was added: with groups on, a group's colour that differs from its
  container's is reset at a worker start, whatever the colour (pre-existing behaviour, tested). With groups off nothing is
  written to a colour, so a stuck 0.1.6 colour there stays until the user sets groups on (then it is set by the take-over) or
  recolours it.
- **Tests.** `tab-groups.test.ts`: a deliberate purple or pink on a marker-bearing group with groups off is untouched start after
  start (only the glyph changes); with groups on a purple container's purple group is untouched start after start and a stuck
  colour on a blue container is set to the container's colour by the take-over; groups without our marker are never touched.

## The agent group mark blinks ✦ / ✧ slowly: glyphs as wide as ⧉ (2026-10-23)

- **Feedback on the emoji blink.** The tabs next to the group chip still jumped, and the blink was too fast. Measured with canvas
  `measureText` at `12px system-ui` in Chrome: `⧉` is 9.55 px wide and the emoji `🟣` / `⚪` are 15 px, so every start, end and
  (with different widths) blink moved the neighbours. This is a measurement of the font, not something the extension or the
  e2e suite can check (the chip's box is not exposed to extensions; Node has no text metrics), so there is no test for the
  width: the numbers are recorded here and in the comment on `AGENT_MARK_GLYPHS`.
- **Candidates measured against `⧉`.** `✦` (U+2726): -0.04 px; `✧` (U+2727): -0.02 px. Both are within a hundredth of a pixel
  of `⧉`, so neither the start, the end nor a blink changes the chip's width. They also read as "sparkle", the usual sign of
  an AI at work, which a plain dot or ring did not.
- **Decision.** Frames `✦ name` ↔ `✧ name` every `BLINK_MS` = 1200 ms (it was 600), starting at `✦`, `⧉ name` after the fade.
  The colour is never written. Everything else is the machinery of the previous entries: one title-only write per transition and per
  tick, none when unchanged, quiet echoes, title and colour re-read before the write, a user rename or recolour while marked syncs,
  glyph clean-up at every start for groups with our marker.
- **Recognition.** Prefix glyphs, with an optional U+FE0F and the whitespace before them: `⧉`, the mark glyphs `✦` `✧`, and for one
  release the legacy `🟣` `⚪` (the blink emoji of the previous dev builds) and `◉` `◎` `○` (0.1.5-dev). `groupNameOf` strips one,
  the swap replaces one, `hasMarkGlyph` finds any non-`⧉` one (start-up clean-up back to `⧉`) and `startsWithGroupGlyph` makes the
  sync refuse a container name that starts with any of them. All but `⧉` is under `__FULL__`: the Lite bundle has none of `✦ ✧ 🟣 ⚪
  ◉ ◎ ○` (checked, also as escapes). Remove the legacy ones after the next release.
- **Tests.** Unit: frames `✦`/`✧` and wrap, 1200 ms, one title-only write per tick, the glyph set incl. FE0F and spaces, legacy
  emoji and `◉ ◎ ○` cleaned to `⧉` with groups on and off, names never starting with any glyph. e2e (`agent-activity.spec.ts`): the
  title alternates ✦/✧ on a collapsed group with the colour constant and the container unchanged, ⧉ after the fade; recolour and
  rename while marked; bridge or setting off restores at once; clean-up after a worker restart (sparkle and legacy 🟣).

## Several Chrome profiles on the agent bridge at once (2026-10-23)

- **Need.** The owner runs three Chrome profiles and wants the bridge on in all of them, with one MCP server (one entry in the
  AI client) seeing every tab. Until now one shared socket (`bridge.sock`) meant one profile at a time; a second one waited
  ("busy").
- **Decision: one socket per profile.** Chrome starts one host per profile anyway. The extension keeps a random profile key
  (10 characters a-z0-9, `chrome.storage.local` `bridgeProfileKey`) and opens every connection with
  `{type: "hello", version: 2, profileKey}`; the host listens on `<SplitSession>/bridges/<key>.sock` (0700 / 0600, removed on
  exit, never a successor's: inode check) and answers `ready` v2. Protocol is now 2 (`PROTOCOL_VERSION`); npm package 0.2.0
  (minor: protocol change; not published).
  - *Why a key and not the label:* the label can change while connected and two profiles may share one (or none). The label
    is read live (see below), not carried in the handshake: a deviation from the brief, which had the label in `hello`.
  - *Why 10 characters:* a Unix socket path is at most 104 bytes on macOS; `~/Library/Application Support/SplitSession/bridges/`
    is already about 70. The host refuses a path over 103 bytes with a clear error.
  - *A copied profile directory* copies the key. The host for an already-served key says `busy` with `code: "same-profile"`;
    the extension looks again after 1 s (normally the previous host leaving after a quick off/on) and, refused twice in a row,
    makes a new key.
- **MCP server: discovery per call.** Every tool call lists `bridges/*.sock` plus the legacy `bridge.sock` (a `readdir` and a
  `stat` each: cheap), and keeps one presence connection per socket (re-synced every 5 s), so "agent present" still works per
  profile. No `fs.watch`: a scan is cheaper to reason about and survives the directory being created later. A socket that
  refuses connections and is older than 5 s is removed (younger ones may be a host between bind and listen).
- **Routing.**
  - `bridge_info`, `list_tabs`, `list_containers`: every profile (or `profile`), each item tagged `profile: {key, label}`.
    `bridge_info` keeps its old top-level fields when exactly one profile is connected, so single-profile agents and scripts
    see what they saw before, plus `profiles`.
  - Tab tools: by `tabId`. Chrome's tab IDs come from one counter per browser process (`SessionID`), shared by all profiles of
    that process, so within one Chrome a tab ID names one tab. Across processes (two browsers, a second `--user-data-dir`, and
    the e2e suite, whose two profiles are two Chromium processes) they collide. So no composite ID: plain `tabId` stays (no
    agent or doc changes for the normal case), the MCP server finds the owner (cache from the latest list, keyed by profile key
    and socket inode so a restarted host never inherits stale entries; else ask every profile), an ID found in two profiles is
    refused with a clear error, and an optional `profile` on every tool disambiguates. A cached route answered with "no tab" is
    looked up once more (the tool did nothing).
  - Opening tools (`open_tab`, `open_in_container`): `profile`, or the profile owning `windowId`, or the only profile.
    Several profiles and no `profile`: an error that lists them. Never a guess: the wrong profile means the wrong account.
  - `profile` is added to the schemas by the MCP server only and stripped before forwarding: the extension's schemas (which
    refuse unknown arguments) are unchanged, so an extension of 0.1.x keeps working.
- **Bookkeeping is not an agent action.** The first e2e run showed the popup counter at 4 for 2 agent calls: labels came from
  `bridge_info` and lookups from `list_tabs`, which the extension counts and lists. Now the MCP server asks `__profile` (key,
  label) and `__tabs` (tab and window IDs), which the extension answers itself (its `__` tools were already internal), never
  counted, listed or logged. An extension of 0.1.x answers "pong" to them; the MCP server then falls back to `bridge_info` /
  `list_tabs` for that profile.
- **Compatibility.** Host and MCP server are one installed program (the AI client runs `<host copy> mcp`), so they always
  match except while an old MCP process is still running (restart the AI client after updating).
  - Old extension + new host: no `hello` within 1.5 s, so the host takes the shared `bridge.sock` with protocol 1 and the old
    single-holder rules; the MCP server shows it with the key `legacy`. New-extension profiles keep their own sockets.
  - New extension + old host: the old host ignores `hello` and answers `ready` v1; the extension connects (works for one
    profile), sets `hostOutdated`, and the switch card shows "One Chrome profile at a time" with
    `npx splitsession-bridge@latest install`. A code-less `busy` (only an old host sends one) is shown the same way.
- **UI.** The "only one profile can hold the bridge" texts are gone. The status says "Connected as “<name>”"; the host
  reports how many profiles are on (`profiles`, counted from the socket files every 3 s), and with two or more and no name the
  card says so and has **Name this profile** (opens Advanced, focuses the field). The name stays under Advanced.
- **Security.** Unchanged trust model: same macOS user only (0700 directories, 0600 sockets), the host's origin check, one
  switch per profile, no network port. New input is the profile key from the extension: the host accepts only 6-16 letters
  a-z/digits (never `legacy`), so it cannot name a path outside `bridges/`.
- **Tests.** Unit: protocol and key (format, CSPRNG rejection sampling, stored once, malformed replaced, renewed), the
  extension (hello on every connection, v1 host flagged, code-less busy, profile count, same-profile retry then new key,
  `__profile`/`__tabs` uncounted), discovery and stale cleanup, the dispatcher (aggregation and tags, `profile` filter by
  name/key, unknown and duplicate names, routing from cache and by lookup, restarted host, colliding IDs, ambiguous open,
  windowId routing, a profile vanishing, old-extension fallbacks), the MCP tool schemas. Integration (`host.test.ts`): the real
  host bundle with the test as the extension: per-profile socket and permissions, profile count, same-key busy, bad key, no
  hello = shared socket and old busy, and the MCP dispatcher against two live hosts (route, refuse, switch off,
  legacy + new together). e2e (`agent-bridge.spec.ts`): two Chromium profiles connected at once (both listed with names,
  ambiguous open refused, a click on the second profile's tab lands there, name hint and button, switching one off removes
  it), and a protocol-1 host stand-in (connects; Settings asks for the update).

### Review fix: tab routing checks live and refuses stale IDs (2026-10-23)

- **Review (Codex, GPT-6.1 Sol): two P1 routing blockers**, both reproduced against the dispatcher. (1) The cache was an
  authority: after `list_tabs {profile: A}` with tab 7 in A and B, `close_tab {tabId: 7}` closed A's tab instead of refusing
  as ambiguous; collisions that appeared later were missed too. (2) Stale IDs were redirected: A's tab 7 seen, A disconnected,
  B got a tab 7, and `close_tab 7` closed B's unrelated tab (the one-profile shortcut skipped any check, and the "no tab" retry
  looked for the ID elsewhere). A new socket inode likewise led to acting on a reused ID.
- **Decision.** No routing cache any more. Every tool on a tab, with or without `profile`, with one profile or many, asks the
  profiles live which tab IDs they have (`__tabs`; uncounted, `list_tabs` for an extension of 0.1.x) and acts only on exactly
  one owner (with `profile`: that profile, which must have the tab). On top of that, an **affinity**: for each tab ID, where the
  agent saw it (profile key + host session). Each host has a random session ID (`crypto.randomBytes(8)`) and stamps it on every
  answer to the MCP server (`ClientResponse.session`; also in `ready`); a host of 0.1.x has none, so the socket inode stands in.
  If the live owner is not a place where the agent saw the ID, the call is refused as stale and nothing is done. A full
  `list_tabs` replaces the sightings (all of them, or that profile's with `profile`), a filtered one and ordinary answers add to
  them, a tab the agent opens replaces them. The "no tab" retry is gone.
- **Cost.** One more local round trip per profile per tab tool (the extension answers `__tabs` from `tabs.query`), also with a
  single profile. And an ID listed before the bridge restarted is refused once even if it is the same tab (a worker restart
  restarts the host): the agent lists again. Both are the price of never acting on the wrong tab.
- **Tests.** Unit regressions for both repros (profile-filtered list then close; a later collision; disconnect and reuse),
  same profile with a new session, a new inode without a session, explicit `profile` (must have the tab; stale until that
  profile is listed), a tab moved between windows of one profile (fine), an ID never seen, one profile (same checks). Host
  integration: every answer carries the session, the profile's next host has a new one, and a click on an ID seen under the
  old host is refused until `list_tabs`.
- **Second review: one gap left.** Work and Home both had tab 7; a full `list_tabs`, then `list_tabs {profile: Work}`, then Work
  disconnected: an unqualified `close_tab 7` went to Home, because Home's older sighting still matched. Now an ID seen in more
  than one profile since the last **complete** `list_tabs` (every connected profile answered an unfiltered list) is marked
  colliding, and an unqualified call for it is refused ("exists in several Chrome profiles; pass profile") even when only one
  profile has it now. `profile` (checked live and against the sightings of that profile and session) acts on it; only a
  complete list that shows one owner clears the mark. A list of one profile, a filtered list, or a list some connected
  profile did not answer never clears it. Regressions: the exact repro, a complete list after the disconnect (then the call
  works), explicit `profile: Home` (works), scoped/filtered/incomplete lists (still refused), and an ID that becomes
  colliding through a later filtered list.


## Tab leases: several agent sessions in one profile (2026-10-26)

- **The incident.** Two agent sessions worked through the bridge at the same time. One navigated in the tab where the other was
  running a publishing queue, and its actions landed between the other's steps. Nothing marked a tab as busy.
- **Decision.** The host keeps a lease per tab (bridge 0.3.0, Full only): the session that opened a tab or last changed it holds
  it; another session's changing action on it is refused with the holder's name and idle time, unless it passes `takeOver: true`.
  Reads, `hover`, `scroll` and the list tools are never refused and take nothing. A lease ends when the holder's MCP server
  disconnects, the tab is closed, or after 120 s without an action by the holder. Unleased tabs (the user's own) stay free; the
  first changing action takes them. `list_tabs` gets `inUseBy` / `yours`. Details: `docs/agents.md`, "Several agents at once".
- **Why in the host.** Every MCP server is a separate process per AI-client session, so they cannot see each other; the only
  place all sessions of one Chrome profile meet is the host (`bridge/src/relay.ts`), and that covers every client, including ones
  we do not know. Doing it in the extension would have meant a protocol bump and an extension release for a guard that has
  nothing to do with the browser; in the host it also works with the 0.1.8 extension. In memory because a lease older than two
  minutes is worth nothing anyway, and a restarted host starts with no sessions.
- **Identity.** The MCP server puts its session name in the request envelope (`session`, `takeOver` next to `tool` and
  `args`), never in `args`: the extension never sees them. Tool calls use a short connection each, so the name cannot come from
  the connection; the long-lived presence connection (`__session`) carries the name too, and its closing is what releases the
  leases. The name is `CLAUDE_SESSION_NAME`, else the MCP client's name, else `agent`, plus 4 random hex digits; `takeOver` is
  a field of the MCP tool schemas (and stripped like `profile`).
- **hover / scroll are free.** They do not change the page's state in a way that breaks another session's step, and a hover
  often is how an agent reads a tooltip. `activate_tab` is treated as changing (it moves the user's window and, in a queue,
  focus matters).
- **Degrades.** Old host + new MCP: the host ignores the extra fields, no leases. New host + old MCP: no session name, so no
  leases for it, and it is never refused. Not covered: two sessions that are not in the same profile (different hosts), or a
  session that does everything with its own tabs (fine, nothing to guard).
- **Not done.** Putting the session name into the extension's activity log / the page pill (needs a protocol change); a
  lease-aware `wait` for a tab to come free.


## Agents' window, per-site pacing, session name on the pill (2026-10-26)

Three additions on top of the tab leases (bridge 0.3.0, together with the leases; the window and the pill need the next extension release).

- **Agents' window (extension).** Tabs an agent opens itself (`open_tab`, `open_in_container`) go to one ordinary window per
  profile, made on demand with `focused: false`, reused while it exists, rebuilt after the user closes it. The window is told
  apart by its ID in `storage.session` (Chrome has no window title). Setting `agentWindow` (Full only, default on, "Open agent
  tabs in a separate window"); an explicit `windowId` always wins; off = the current window as before. The blank first tab of
  the new window is closed once the agent's own tab is in it. Why: the user's window was getting agent tabs between their
  own, and "this tab" was ambiguous. Agents are told in the tool descriptions: "this tab" = the `active: true` tab of the
  user's last-focused window. Not done: `list_tabs` does not say which window is the last focused one.
- **Per-site pacing (host).** After the 2026-10-22 Reddit 429 (about 80 parallel requests from an agent, both accounts limited)
  the host spaces the actions that reach a site's server, per registrable domain (`tldts`, already in the extension), over all
  sessions of the profile: FIFO queue, 1500 ms apart, the host waits rather than refuses, 30 s cap then "site busy". Paced:
  navigate, back, forward, reload, open (with a URL), click, select_option, upload_file, press_key Enter. Not paced: reads,
  hover, scroll, type, run_js. Done in the host because it is the one place all sessions of a profile meet (as for leases) and
  it needs no extension release for the URL tools; the tab-based tools ask the extension for the tab's address with a new
  internal `__tab_url` (unknown to an older extension, which answers "pong": those actions are then not paced). Slots are
  reserved on arrival (a start time per site), so a queue needs no timers of its own beyond one `setTimeout` per waiter, and
  the cap is checked up front instead of after 30 s of waiting. `SPLITSESSION_SITE_GAP_MS` sets the gap (0 = off) and exists
  for tests; the e2e fixtures run with 0 and the pacing spec uses a second profile with the default. The MCP server's own
  deadline grows by the cap for changing tools so it never gives up before the host does.
- **Session name to the extension.** The request envelope host -> extension gets an optional `session` (cleaned to letters,
  digits, space, `-_.`, at most 64 characters; the extension cleans it again). No `PROTOCOL_VERSION` bump: an older extension
  ignores the field, an older host sends none. The pill reads "<session>: reading" (24 characters, ellipsis), "Agent: reading"
  without a name; the Diagnostics "agent action" entries have a `session` field. This is the item that the lease entry listed as
  "not done". The existing e2e checks of the pill text now expect the `facet-e2e-xxxx: ` prefix.

## "Duplicate" of a container tab reopens at the address it was created with (2026-10-26)

- **Report.** Threads in a container group, right-click the tab, "Duplicate": the copy stayed in the group but showed the
  site logged out, while the original was logged in.
- **Reproduced** (`e2e/duplicate-tab.spec.ts`, stand page `/private`: needs the `who` cookie, otherwise 302 to
  `/signin?next=...`). `chrome.tabs.duplicate` gives what the UI gives: index + 1, the original's group, the original as
  `openerTabId`, `pendingUrl` = the original's address. Its first request left without any cookie (the real profile is not
  logged in there), the site answered with the redirect, and the guard, 150 ms later, reopened the container tab at the
  tab's *current* address: the sign-in page. The container tab was in the right container and group, on the wrong page.
- **Cause.** The guard read the address from the live tab when it reopened it (`pendingUrl`, else `url`), by which time the
  unisolated copy had followed the site's redirect.
- **Fix.** `GroupGuard.tabCreated` remembers the website address the tab was created with (`pendingUrl`, else `url`); the
  reopening uses it (`chooseAddress`), and forgets it when the tab's check ends. A tab dragged into the group has no such
  record and is reopened where it stands, as before. Applies to every website Chrome creates in a group (a duplicate, an
  address or link opened next to a grouped tab). A POST is still never repeated (the address is a plain GET). Not done: a
  shorter settle for an obvious duplicate. The 150 ms also lets a link inherit from its opener first, and the unisolated
  request is out within ~2 ms regardless, so a shorter wait would shrink the exposure only a little.
- **Left as it was.** The copy's first request and its scripts still run as the real profile for a moment (limits.md).
  When the reopen limit holds the tab back, the sweep that follows reopens it at where it stands.

## The agents' window is off by default (2026-10-26)

- **Decision (product owner).** The owner prefers agents' tabs in the window they work in, as background tabs, as before 0.1.9.
  `agentWindow` now defaults to off; the switch stays (Settings, For AI agents) for whoever wants a separate window.
- **Existing installs.** No migration: settings store an `explicit` list, and a key never set follows the current default, so
  installs that never touched the switch go to off on update. Whoever set it on 0.1.9 keeps their choice.

## Session rules scale with containers, not with the sites their tabs are on (2026-10-26)

- **Incident** (owner's Chrome, business profile, 16 container tabs in 6 containers on threads.com, supabase, vercel,
  northflank; read with the bridge's `extension_log`):
  `warn session rules at 4965, above the soft limit of 4000`, then
  `error refusing to install 5063 session rules (Chrome's limit is 5000)` and
  `error group guard: tab 1174928102 could not be reopened in 8ike4ctlwf (created in the group); ... "could not install the
  container rules (declarativeNetRequest limit?)"`. No new container tab could be isolated: a duplicate stayed a plain,
  logged-out tab in the container's group.
- **Measured first** (`src/core/dnr/rule-budget.test.ts`, a probe over synthetic jars shaped like those sites: threads with
  its instagram and facebook cookies, the dashboards and the widgets they embed; ~54 cookie hosts). One container tab:
  556 rules. Breakdown: host rules dominate, up to 12 per cookie host (WIDE and EXACT, each split by SameSite into
  first-party / third-party / cross-site navigation, and the same again in the plain-http band for hosts with Secure
  cookies: 498 rules), per-site beacon answers 18, catch-all and generic beacon 1 each. A second tab on the **same** site:
  +0 (rules already carried `tabIds: [all tabs]`). A second tab on **another** site: +556. The cause: while a jar holds
  any partitioned (CHIPS) cookie (an embedded Stripe, Intercom or Cloudflare widget is enough), tabs were grouped by
  top-level site and **every group got a full copy of the container's rules**; a tab that is still loading
  (top-level site unknown) was a group of its own too. So the count grew with tabs × cookie hosts, as the log showed.
  The incident's mix in the probe: 8896 rules before.
- **Design.** `compileContainerRules` compiles all groups of a container in one pass and merges rules that are identical
  apart from `tabIds` (same priority, same condition, same action) into one rule with the union of the groups' tabs.
  `tabIds` is an "any of" condition, so the set of rules that matches a given tab is exactly the set its group would get on
  its own: same priorities, same actions, nothing from another group (unit test compares, per tab, the rule shapes and
  the simulated `Cookie` header of the merged and the separate compiles). Only rules that really depend on the top-level
  site stay per group: hosts whose cookie list includes a partitioned cookie of that site, and their beacon answers. A
  beacon answer now carries the group's site (`s`) only when its snapshot holds partitioned cookies; otherwise the shim's
  own estimate stands in, as it always did for jars without partitioned cookies, and the answer merges. Regex budget is
  spent once per merged rule. Different containers never share a rule: each compiles separately with its own tabs.
- **Not done: stable rule IDs per container, kind and domain with in-place `tabIds` edits.** The manager already swaps a
  container's whole rule set in one `updateSessionRules` call (remove old IDs + add new rules), so a tab joining or
  leaving is never without rules or under another container's rules in between; a tab joining changes the rules'
  `tabIds`, not their number (unit test). Stable IDs would save nothing on the limit.
- **Numbers after.** Probe: the incident's 16 tabs in 6 containers 3426 rules (was 8896); 30 tabs in 3 containers on 4
  sites 1776 (3 single-tab containers: 1668). Each extra top-level site of a container now costs only its partitioned
  variants (~9 rules here) instead of a full copy.
- **Budget guard.** The soft-limit warning stays. `SessionRuleManager.stats()` now also reports the limits and `refusedAt`:
  when a batch was last refused for the rule limit (ours, or Chrome's own refusal), cleared once a batch installs with the
  total at or under the soft limit. The popup shows "Too many container cookie rules (N of 5000): close some container
  tabs" (warning above the soft limit; error, plus "a tab could not be put in its container", after a refusal), so a tab
  left plain in a container group is no longer silent. The group guard still logs and retries on its next sweep.
- **Tests.** Unit: probe and merge (`rule-budget.test.ts`), join/leave and refusal stats (`session-rules.test.ts`). E2e:
  `rule-budget.spec.ts` opens 30 container tabs in 3 containers on 4 cookie-heavy stand sites (`/heavy`, with widgets that
  set partitioned cookies): one catch-all per container covering all its tabs (the old compile installs 12), no new rules
  for more tabs on the same sites, every tab sends only its container's cookies.
