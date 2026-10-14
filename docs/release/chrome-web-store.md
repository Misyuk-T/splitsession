# Releasing SplitSession on the Chrome Web Store (research, 2026-10-14)

Scope: v0.1.0 of the two editions as two separate store items, **Lite** ("SplitSession: Multiple Logins per Site") and
**Full** ("SplitSession (Full)"). Draft store texts: [listing-draft.md](listing-draft.md).

How to read this: every non-obvious claim has a source link. **UNVERIFIED** marks what could not be confirmed from an
official page (third-party report, inference, or memory). Official pages were fetched on 2026-10-14; most
`developer.chrome.com` pages carry no date, so re-check anything a decision depends on.

Facts about our builds (from `pnpm build` and `pnpm build:lite` on 2026-10-14, `.output/*/chrome-mv3/manifest.json`):

| | Lite | Full |
| --- | --- | --- |
| `permissions` | declarativeNetRequest, webRequest, scripting, tabs, tabGroups, storage, webNavigation, browsingData, alarms, sessions | the same + `nativeMessaging`, `debugger` |
| `host_permissions` | `<all_urls>` | `<all_urls>` |
| `optional_permissions` | `cookies` | `cookies` |
| `key` | none | yes (fixed ID `hapfikidacgfgnnajkgnaednpgnhmffk`) |
| `eval` / `new Function` in the bundle | none | none (agent JS goes only through `chrome.debugger` `Runtime.evaluate`) |
| Package size | 848 KB unzipped | 980 KB unzipped |

Two findings from the repository that matter before any submission:

- **`cookies` is requested but never used.** No `chrome.cookies` call and no `permissions.request` exist in `src/`.
  Unused permissions are the textbook trigger of rejection code Purple Potassium (section 3). Remove it from
  `wxt.config.ts` before the first upload.
- **The GitHub repository `Misyuk-T/splitsession` is private** (`gh repo view`, 2026-10-14). The listings and the
  privacy policy point to it as "open source", and a GitHub Pages privacy policy on a private repository needs a paid
  GitHub plan. Make the repository public before submitting, or change the texts.

---

## 1. Process and prerequisites

### 1.1 Developer account

- **Registration**: Google account, accept the developer agreement, pay a **one-time registration fee**
  ([register](https://developer.chrome.com/docs/webstore/register)). The official page gives no amount; **US$5** is
  what it has been since 2009 ([Computerworld, 2009](https://www.computerworld.com/article/1554628/google-makes-chrome-devs-dig-into-pockets.html)),
  **UNVERIFIED** for today: check the amount on the payment screen. **Ukraine is on the supported-countries list**
  (same page).
- **The developer e-mail cannot be changed later**: use an address you will keep and read
  ([register](https://developer.chrome.com/docs/webstore/register)).
- **2-Step Verification is required** to publish and to update
  ([2SV policy](https://developer.chrome.com/docs/webstore/program-policies/two-step-verification)).
- **Contact e-mail verification and publisher name** are required; the publisher name shows under the title. A
  physical address is needed only for items that sell something
  ([set up account](https://developer.chrome.com/docs/webstore/set-up-account)).
- **Group publisher vs personal**: the old distinction is retired; any publisher can now have members with roles
  Viewer, Item Manager, Editor, Admin ([group publishers](https://developer.chrome.com/docs/webstore/group-publishers)).
  The same page warns to create only one publisher per account. **Recommendation**: one personal publisher
  ("SplitSession" or "Taras Misiuk") for both items; add members later if needed.

### 1.2 Trader / non-trader (EU Digital Services Act)

- Every developer must self-declare
  ([trader disclosure](https://developer.chrome.com/docs/webstore/program-policies/trader-disclosure),
  [FAQ](https://developer.chrome.com/docs/webstore/program-policies/trader-verification-faq)). The test is acting for
  "trade, business, craft or profession".
- **Trader**: legal name, address and phone are verified and **shown publicly** on the listing.
- **Non-trader**: EU users are told consumer-protection law does not apply to contracts with you; no other change
  ([announcement, Feb 2024](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/ZI9R_KAA3BQ)).
- **Recommendation: non-trader.** A free, MIT-licensed hobby project with no payments, ads or paid tier fits it, and it
  keeps your address and phone off the page. Google does not rule on individual cases (inference, not an official
  ruling). Re-declare if donations or a paid tier appear.

### 1.3 Privacy policy

- **Required** for any item that handles user data, **even if the data is only stored locally**
  ([privacy policy](https://developer.chrome.com/docs/webstore/program-policies/privacy),
  [user-data FAQ, Q3 and Q14](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)).
  SplitSession stores cookies, which the FAQ counts both as *authentication information* and as *web browsing
  activity*. So both editions need a policy.
- **GitHub Pages is fine as far as the policy says**: it only asks for a working link in the dashboard; no hosting
  rule was found (**UNVERIFIED** that reviewers never object, low risk). Use a stable URL on the project's Pages site,
  e.g. `https://misyuk-t.github.io/splitsession/privacy`. The repository must be public for free Pages (see above).
- **Content**: what is handled, how it is used and shared, who receives it, plus the Limited Use statement (on the
  homepage or one click away) ([user-data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)).
  Draft outline: [listing-draft.md, section 3](listing-draft.md#3-privacy-policy-draft-summary-both-editions).
- **The policy is written:** [../privacy.md](../privacy.md) (English, effective 2026-10-14, both editions). Its public URL is
  `https://misyuk-t.github.io/splitsession/privacy` **once the repository is public and Pages is set to deploy from the
  `main` branch, `/docs` folder** (Settings > Pages). `docs/_config.yml`, `docs/index.md` and the `permalink: /privacy`
  front matter of `privacy.md` are what make that URL work. Open the URL in a private window before pasting it in the
  dashboard (the first build takes a minute or two).

### 1.4 Privacy practices tab (data usage)

- The form has two parts: data types handled, and certifications. It must be complete to publish or update, and it
  must **match the privacy policy and the real behaviour**: a mismatch is grounds for removal
  ([privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy),
  [listing requirements](https://developer.chrome.com/docs/webstore/program-policies/listing-requirements)).
- Data types (dashboard labels, per the 2020 launch coverage; **UNVERIFIED** against today's form): personally
  identifiable information, health, financial and payment, authentication information, personal communications,
  location, web history, user activity, website content
  ([9to5Google](https://9to5google.com/2020/11/18/chrome-web-store-disclosure/)).
- Certifications: not sold to third parties; not used or transferred for purposes unrelated to the single purpose;
  not used for creditworthiness or lending (same source).
- **Since 1 August 2026** data collection must be "strictly necessary" for the disclosed single purpose, must be
  prominently disclosed even when it is clearly related to it, and later changes in data handling must be announced to
  users ([CWS policy updates 2026](https://developer.chrome.com/blog/cws-policy-updates-2026)).
- **What to tick**:
  - Lite: **Authentication information** (container cookies) and **Web history** (the FAQ defines browsing activity to
    include cookies in browser storage and HTTP request and response content, and the extension reads tab addresses
    for domain rules). Nothing else.
  - Full: the same, plus **Website content** (page text, HTML, screenshots go to the local agent) and **User activity**
    (the agent's input and the console and network capture). Say in the policy that the recipient is a program on the
    user's own computer; transmissions to a native program on the same computer are exempt from the secure-transport
    rule ([user-data FAQ, Q16](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)).
- Over-declaring is safer than under-declaring here: a declaration that is narrower than what the code visibly does is
  the mismatch the policy punishes.

### 1.5 Permission justifications and single purpose

- One justification box per permission, plus a single-purpose field and a remote-code question
  ([privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)). Each box holds **at most 1,000
  characters** (developer report: [Otto on dev.to](https://dev.to/mykola-bielousov/otto-is-live-what-it-took-to-ship-an-ai-browser-agent-to-the-chrome-web-store-1pgl);
  **UNVERIFIED** officially).
- Request the narrowest permissions, nothing for future features; broader than necessary "may cause your extension to
  be rejected" ([permissions policy](https://developer.chrome.com/docs/webstore/program-policies/permissions)).
- What to write: say what the permission does **for the user**, which feature uses it, and what it is **not** used for.
  Paste-ready texts: [listing-draft.md](listing-draft.md).
- Single purpose: "narrow and easy to understand"; no "bundles of unrelated functionality"; clearly separate features
  belong in separate extensions ([quality guidelines](https://developer.chrome.com/docs/webstore/program-policies/quality-guidelines)).

### 1.6 Listing assets

From [images](https://developer.chrome.com/docs/webstore/images) and
[listing](https://developer.chrome.com/docs/webstore/cws-dashboard-listing) unless noted:

| Asset | Requirement | Our status |
| --- | --- | --- |
| Icon | 128x128 PNG, artwork 96x96 with 16 px transparent padding | `public/icons/icon-128.png` exists; check the padding |
| Screenshots | 1 to 5, **1280x800** (preferred) or 640x400, square corners, full bleed | missing: `docs/screenshots/` are popup crops (280 px wide); make 1280x800 compositions |
| Small promo tile | 440x280, listed as **required**; items without one rank lower | missing |
| Marquee | 1400x560, optional, only for featuring | skip for v0.1 |
| Promo video | YouTube link, optional | useful for Full's review (section 2.4) |

- A developer reports screenshots **with an alpha channel were refused**; export JPEG or flatten PNGs
  ([Otto](https://dev.to/mykola-bielousov/otto-is-live-what-it-took-to-ship-an-ai-browser-agent-to-the-chrome-web-store-1pgl), **UNVERIFIED**).
- Missing icon, screenshots or description means rejection
  ([listing requirements](https://developer.chrome.com/docs/webstore/program-policies/listing-requirements)).

### 1.7 Title, descriptions, keywords

- **Summary** (manifest `description`): **132 characters max**, plain text
  ([best listing](https://developer.chrome.com/docs/webstore/best-listing)); a longer one fails the whole upload
  (Otto report). Ours: Lite 72, Full 125.
- **Title**: the manifest `name` (Chrome allows 75 characters; keep it ≤45 so the store card does not truncate it).
  Ours: Lite 38, Full 19. No official store limit was found (**UNVERIFIED**).
- **Keyword spam** (rejection code Yellow Argon): no repetition of one keyword **more than 5 times** "unnaturally", no
  lists of sites or brands without added value, no anonymous testimonials
  ([listing requirements](https://developer.chrome.com/docs/webstore/program-policies/listing-requirements)).
  Precedent: an AI agent extension was rejected for naming the AI providers it supports, accurate as that list was
  ([Otto](https://dev.to/mykola-bielousov/otto-is-live-what-it-took-to-ship-an-ai-browser-agent-to-the-chrome-web-store-1pgl)).
- **Trademarks**: no implied endorsement, no impersonation
  ([impersonation and IP](https://developer.chrome.com/docs/webstore/program-policies/impersonation-and-intellectual-property)).
  **Do not put Google, Gmail, Meta, Facebook, Instagram, Reddit, Threads, Supabase or Claude in the title, summary or
  a list in the description.** One plain comparison ("Firefox-style containers") is nominative use and low risk; the
  README can keep the site examples.

### 1.8 Category and language

- Pick a primary category and language in the dashboard
  ([listing](https://developer.chrome.com/docs/webstore/cws-dashboard-listing)). The 2024 taxonomy splits
  Productivity into sub-categories such as Tools, Workflow & Planning, Privacy & Security
  ([third-party](https://blog.crosexperts.com/google-reveals-the-new-chrome-web-store-51f2c6293102), **UNVERIFIED**).
- Lite: **Productivity > Tools**. Full: **Developer Tools**. English only for v0.1.

### 1.9 Visibility and staged release

- **Public**, **Unlisted** (installable by URL, not searchable), **Private** (trusted testers or Google Groups). All
  three get **the same review** ([distribution](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution)).
  Private/unlisted first therefore does not shorten review; it only limits who installs.
- **Deferred ("staged") publishing**: untick "publish automatically after review"; once approved you have **30 days**
  to press Publish, then the submission falls back to draft
  ([publish](https://developer.chrome.com/docs/webstore/publish), [update](https://developer.chrome.com/docs/webstore/update)).
- **Percentage rollout** exists only for published items with **more than 10,000 seven-day active users**; not
  available for v0.1 ([update](https://developer.chrome.com/docs/webstore/update)).
- **Recommendation**: Lite **Public with deferred publishing** (you choose the launch moment after approval, and can
  install the store build yourself first via the item link once it is approved; **UNVERIFIED** that a staged item is
  installable before publishing, so plan on a Private trusted-tester pass if you need to test the store-signed build).
  Full (if it ever goes to the store): **Unlisted** first.

### 1.10 Review times

- Official: most reviews take "a few days", some "a few weeks"; contact support after **3 weeks**
  ([review process](https://developer.chrome.com/docs/webstore/review-process)).
- Longer review is triggered by: new developer, new extension, broad host permissions such as `<all_urls>`, sensitive
  execution permissions, large or hard-to-read code, a previous rejection (same page). Lite hits four of these, Full
  five.
- The dashboard shows a notice that a host permission "may require an in-depth review"
  ([macarthur.me](https://macarthur.me/posts/chrome-extension-host-permission)).
- A chromium-extensions post of 2026-04-24 reports queues of **28 to 30 days**
  ([thread](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/VJ6DcpEn51Y), **UNVERIFIED** as typical).
  A `debugger` agent extension went "the slow, in-depth track"; its resubmission after a fix was approved in about a day
  ([Otto](https://dev.to/mykola-bielousov/otto-is-live-what-it-took-to-ship-an-ai-browser-agent-to-the-chrome-web-store-1pgl)).
- **Plan for Lite: 1 to 4 weeks for the first review.** Updates without new permissions are usually faster
  (**UNVERIFIED**).
- Rejection notices go to the publisher e-mail; whitelist it (Otto lost a week to a Gmail filter). Appeals and
  resubmission: [review process](https://developer.chrome.com/docs/webstore/review-process).

---

## 2. Policy risks per edition

### 2.1 Lite: `<all_urls>` + webRequest + cookie header rewriting (medium risk)

- **Why it is looked at closely**: broad host access is an explicit in-depth-review trigger (1.10), and cookie handling
  is exactly what session-stealing extensions do. In January 2026 five fake enterprise extensions that stole and
  injected session cookies were removed ([The Hacker News](https://thehackernews.com/2026/01/five-malicious-chrome-extensions.html)).
  Expect a reviewer to read our code for any network egress.
- **Why it is defensible**: cookie tooling as such is allowed (Cookie-Editor, 2M users, imports and exports cookies:
  [store](https://chromewebstore.google.com/detail/cookie-editor/hlkenndednhfkekhgcdicdfddnkalmdm)); no rejection of a
  container or multi-login extension for header rewriting was found (**UNVERIFIED** either way).
- **Can `<all_urls>` be narrowed?** Not usefully: a container tab's requests go to any host (CDNs, SSO domains,
  iframes), and DNR `modifyHeaders` needs host access to each of them. Per-site optional grants would break logins
  mid-flow. Keep `<all_urls>`, justify it precisely (listing-draft), and show that only container tabs are touched.
- **Mitigations**: no network code at all (true today; say it in the listing and the reviewer notes); remove the unused
  `cookies` permission; a link to the public source; justifications that name the feature; privacy disclosures that tick
  authentication information and web history (1.4).

### 2.2 Lite: `browsingData` (low to medium risk)

- No install warning of its own ([permissions list](https://developer.chrome.com/docs/extensions/reference/permissions-list)),
  but "deletes user data" invites the question "why?". Our use is narrow: `browsingData.remove` with the
  `serviceWorkers` type only (`src/engine/sw-policy.ts`). The justification must say "service workers only, because
  their requests bypass per-tab isolation; no history or cookies are removed".

### 2.3 Remote code (Blue Argon): Lite none, Full `run_js`

- Rule: code "loaded from someplace other than the extension's own files" is forbidden, except through a documented API
  that permits it: the **Debugger API** and the **User Scripts API**; the exemption covers "solely" the code those APIs
  handle and the use must be "inline with the documented purpose of the API"
  ([MV3 requirements](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements),
  [remote hosted code](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code)).
  Violations named: `eval()` of fetched strings, external `<script>`, an interpreter for fetched commands.
- **Full's `run_js`** sends a string from the local agent to `chrome.debugger` → `Runtime.evaluate`. That is inside the
  Debugger API exemption. The other agent tools inject **bundled functions** via `scripting.executeScript({func})`
  (`src/background/bridge/inject.ts`), not strings, so they are not remote code. Neither policy page mentions native
  messaging; a local program is a weaker "remote" case than a server (inference).
- **Residual risk**: the "documented purpose" condition. CDP is documented for instrumenting and debugging pages;
  driving a page for an agent is how Claude, Playwright Extension and Browser MCP use it (2.4), so the reading is
  accepted in practice, but no official statement about agent use exists.
- **Dashboard answer for Full**: answer **"Yes"** to remote code and explain it is limited to `Runtime.evaluate` through
  the Debugger API with expressions from the user's local agent. Answering "No" while the code visibly evaluates
  external strings risks a "deceptive" reading (Red Nickel family). This is a judgement call (**UNVERIFIED** how
  reviewers score either answer); the draft in listing-draft.md has both texts.
- Lite: answer "No". Bundle has no `eval`/`new Function` (checked on the build output).

### 2.4 Full: `debugger` (accepted on the store, slow review)

- Install warnings: "Access the page debugger backend" and "Read and change all your data on all websites"
  ([permissions list](https://developer.chrome.com/docs/extensions/reference/permissions-list)).
- **Listed precedents that drive pages through CDP**:
  - **Claude** (Anthropic), about 18M users, declares `debugger` and `nativeMessaging`
    ([store](https://chromewebstore.google.com/detail/claude/fcoeoabgfenejglbffodgkkbkcdhcgfn),
    [permission list](https://support.claude.com/en/articles/12012173-using-claude-in-chrome-safely)).
  - **Playwright Extension** (Microsoft), about 100K users
    ([store](https://chromewebstore.google.com/detail/playwright-mcp-bridge/mmlmfjhmonkocbjadbfplnigmagldckm));
    `debugger` per secondary sources (**UNVERIFIED**).
  - **Browser MCP**, about 100K users ([store](https://chromewebstore.google.com/detail/browser-mcp-automate-your/bjfgambnhccakkhmkepdoekmckoijdlc));
    `debugger` per a third-party auditor (**UNVERIFIED**).
  - Not on the store: Chrome DevTools MCP uses Chrome's own remote debugging
    ([auto-connect](https://developer.chrome.com/docs/devtools/agents/use-cases/auto-connect)); BrowserTools MCP ships
    a zip from GitHub.
- No rejection of an agent extension *for* `debugger` was found; one went the in-depth track and was rejected for
  keyword spam instead (1.10). A WebAuthn tool dropped `debugger` to avoid the banner and the elevated review
  ([PR](https://github.com/agektmr/webauthn-devtools/pull/4)).
- `debugger` **cannot be an optional permission** ([permissions API](https://developer.chrome.com/docs/extensions/reference/api/permissions)),
  so the warning is shown to every Full user at install.
- **Chrome 155 (stable 2026-10-06)**: on *managed* browsers with `runtime_blocked_hosts` or screenshot restrictions,
  `chrome.debugger.attach()` fails ("Host access is restricted by policy")
  ([blog](https://developer.chrome.com/blog/debugger-enterprise-policy-restrictions)). Personal profiles are unaffected;
  the bridge should show that error text as is.

### 2.5 Full: `nativeMessaging` and a host the reviewer does not have (high risk: Yellow Magnesium)

- Warning: "Communicate with cooperating native applications"
  ([permissions list](https://developer.chrome.com/docs/extensions/reference/permissions-list)). No policy requires a
  specific disclosure of the companion app; popular items (KeePassXC-Browser, Video DownloadHelper, Claude) do not spell
  it out in the visible summary (store pages, see the research notes).
- The real risk is **"functionality not working" (Yellow Magnesium)**: a reviewer who switches on "Agent bridge" sees
  "not connected". Our host used to be installed with `pnpm bridge:install` **from a source checkout** (macOS only); since 2026-10-14 it is `npx splitsession-bridge install` (macOS and Linux, once the package is published; [npm.md](npm.md)), so a store
  user needs Node.js and a terminal, but no clone of the repository.
- Mitigations: the listing says plainly that the bridge needs a separately installed companion program and that the
  extension works as a container extension without it; reviewer notes with a link to a short video of the bridge in use;
  set-up steps reachable from Settings (they are, "How to connect").

### 2.6 Full: single purpose (high risk: Red Magnesium/Copper/Lithium/Argon)

- Policy: one narrow purpose, no "bundles of unrelated functionality", separate features belong in separate extensions
  ([quality guidelines](https://developer.chrome.com/docs/webstore/program-policies/quality-guidelines)).
- "Containers" and "let a local AI agent drive every tab" are two purposes on their face, and Lite existing as a
  separate item shows they *can* be separated, which is the policy's own test.
- The best framing: one purpose, "account-aware browser access for the user's own local agent", where containers are
  what lets the agent act as a chosen account. That is honest (`open_in_container`, `list_tabs` with containers) but
  arguable. No precedent either way was found.

### 2.7 Limited Use and disclosure (both editions)

- Limited Use: use data only for the single purpose; transfer only for that, legal reasons, security or a merger; never
  for ads; no human reading without consent ([user-data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)).
- Since August 2026 also: collection "strictly necessary" for the single purpose, prominent disclosure even for related
  collection, notice of later changes ([policy updates 2026](https://developer.chrome.com/blog/cws-policy-updates-2026)).
- **Prominent disclosure and consent** is a separate rule (code **Purple Nickel**); the policy asks for "affirmative and
  informed consent" when the product handles user data but does not say where the disclosure must appear
  ([disclosure requirements](https://developer.chrome.com/docs/webstore/program-policies/disclosure-requirements)).
  Lite handles authentication cookies only locally and only after the user creates a container, which is the action the
  listing describes. A one-line notice on first container creation ("cookies of this container are kept on this device
  only") would close the gap cheaply (code change; not in v0.1 today). Full needs it more: the bridge switch should say
  in the UI what the agent can read and where it goes (it does: "Agent connected — full access", docs/agents.md).

### 2.8 Names, trademarks and keyword stuffing

Covered in 1.7. The rule of thumb: brand names only in the README; in the listing at most one nominative comparison.

---

## 3. Rejection codes that apply to us

Official table: [troubleshooting](https://developer.chrome.com/docs/webstore/troubleshooting). Note: Red Titanium is
obfuscation and Grey Silicon is crypto mining; neither is about cookies.

| Code | Meaning | Our trigger | How to avoid |
| --- | --- | --- | --- |
| **Purple Potassium** | Excessive or unused permissions | unused optional `cookies`; `browsingData`, `<all_urls>`, `debugger` without a clear use | remove `cookies`; a feature-specific justification for every permission (listing-draft) |
| **Yellow Magnesium** | Functionality not working as described | Full's bridge without the host; any site that breaks in review | Full: say the host is separate, give a video; Lite: the reviewer can test with any two logins, keep the description honest about limits |
| **Red Magnesium / Copper / Lithium / Argon** | Single purpose | Full: containers + agent | the framing in 2.6, or keep Full off the store |
| **Blue Argon** | Remotely hosted code | Full `run_js` | only through `chrome.debugger` (as now), never `eval`/`new Function`; disclose (2.3) |
| **Purple Lithium** | Privacy policy missing or incomplete | none yet: no policy exists | publish the policy before submitting; cover cookies, tab addresses, Full's agent data |
| **Purple Nickel** | Prominent disclosure and consent missing | cookie handling without an in-product notice | first-run notice (2.7); clear listing text |
| **Purple Magnesium** | Other user-data handling (e.g. browsing data without a user-facing feature) | reading tab URLs | tie each to a feature in the justification |
| **Red Nickel / Potassium / Silicon** | Deceptive behaviour, listing differs from function | claims like "works on every site", or "no remote code" for Full | honest limits section; Full remote-code answer (2.3) |
| **Yellow Argon** | Keyword stuffing | site or AI-product lists, repeating "container" | 1.7; long description uses the word naturally |
| **Yellow Zinc** | Missing metadata | missing screenshots or promo tile | 1.6 |
| **Red Titanium** | Obfuscation | none: Vite minification is allowed ([code readability](https://developer.chrome.com/docs/webstore/program-policies/code-readability)) | keep minify-only; link the source |
| **Yellow Potassium** | Minimum functionality | unlikely | n/a |

---

## 4. What users complain about, and what to pre-empt

Sources are thin: store review pages need sign-in and did not render; most evidence is from Firefox Multi-Account
Containers (MAC) issues on GitHub, AlternativeTo and competitor blogs (marked as biased).

| Complaint | Evidence | What to put in the listing, FAQ or onboarding |
| --- | --- | --- |
| **Google sign-in loops** in a container | MAC [#2896](https://github.com/mozilla/multi-account-containers/issues/2896) (2026, open): assigning `accounts.google.com` to a container switches containers mid-login; YouTube [#2532](https://github.com/mozilla/multi-account-containers/issues/2532); Figma SSO [#2425](https://github.com/mozilla/multi-account-containers/issues/2425) | FAQ "Google sign-in": never put a domain rule on accounts.google.com; start the sign-in from the site, inside the container tab. Our popups stay in the container by design; **test a real Google account before launch** (docs/limits.md marks it not verified) |
| **Microsoft 365 / Entra loops** | MAC [#2844](https://github.com/mozilla/multi-account-containers/issues/2844), [#2887](https://github.com/mozilla/multi-account-containers/issues/2887), device-ID conditional access [#2670](https://github.com/mozilla/multi-account-containers/issues/2670) | FAQ: "clear this container's data and sign in again"; conditional-access tenants may refuse a container |
| **Lost logins / containers after restart or update** | MAC [#2830](https://github.com/mozilla/multi-account-containers/issues/2830), [#2703](https://github.com/mozilla/multi-account-containers/issues/2703), [#2941](https://github.com/mozilla/multi-account-containers/issues/2941); SessionBox blank tabs after restart ([DICloak](https://dicloak.com/blog-detail/session-box-extension-for-chrome-honest-review-2024), biased) | say what survives a restart ("Restore after restart", held tabs in the popup); recommend Export; never break the storage format between versions without migration |
| **Bans / checkpoints / captchas** for multi-accounting | no first-hand reports found; competitors stress that cookie isolation does not change IP or fingerprint ([Pixelscan](https://pixelscan.net/blog/sessionbox-review/), biased) | "not an anti-detect tool": same IP, same fingerprint; do not use it against a site's rules |
| **Which tab is which** | colour dots blend with favicons (Pixelscan, DICloak; biased) | our tab groups with names and the badge; show it in screenshot 1 |
| **Paywall / cloud lock-in** | SessionBox moved to paid cloud plans ([Vivaldi forum](https://forum.vivaldi.net/topic/25289/multi-account-containers/458), [Pixelscan](https://pixelscan.net/blog/sessionbox-review/)); SessionBox One needs a desktop app ([store](https://chromewebstore.google.com/detail/gmechnknnhcmhlciielglhgodjlcbien), 3.0 stars) | "free, open source, no account, no cloud" up front |
| **Privacy fear** of cookie extensions | cookie-stealing clones removed ([The Hacker News](https://thehackernews.com/2026/01/five-malicious-chrome-extensions.html)) | "nothing leaves your device", link to source and privacy policy, no analytics |
| **Conflicts with other extensions** | Gmail blank page with MetaMask, MAC [#2733](https://github.com/mozilla/multi-account-containers/issues/2733) | FAQ: disable others one by one; issues link |
| **Push notifications / offline** missing in containers | our own limit (service workers off) | in "Good to know" (listing-draft) |

Signal to watch (**UNVERIFIED**): a small competitor says "recent Chrome versions require a small desktop agent"
without saying why ([EazySessions](https://chromewebstore.google.com/detail/eazysessions-multilogin-t/oapglnlmpalfndoddlcefkjnccjomhlg)).
Our e2e passes on current Chromium; re-run Lite against **Chrome stable** before submitting.

---

## 5. Distribution of Full outside the store

- **Load unpacked from a GitHub Release zip** (what the README already describes). Since Chrome 134 unpacked extensions
  are disabled while the Developer mode switch is off ([PSA](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/cTdMVtxxooY));
  they **never auto-update** (the user replaces the folder and reloads). The old "Disable developer mode extensions"
  start-up nag: current status **UNVERIFIED**.
- **`--load-extension` is ignored by branded Chrome since 137** (Chromium and Chrome for Testing keep it)
  ([PSA](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/1-g8EFx2BBY/m/S0ET5wPjCAAJ)); docs/agents.md
  already says so for Playwright.
- **Self-hosted CRX**: on Windows and macOS Chrome stable a user **cannot** install an off-store CRX; only Linux allows
  off-store hosting ([install extensions](https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions),
  [Linux hosting](https://developer.chrome.com/docs/extensions/how-to/distribute/host-on-linux)). Verified by docs, not
  by trying.
- **Enterprise policy**: `ExtensionInstallForcelist` / `ExtensionSettings` with an `update_url` can force-install a
  self-hosted CRX; on Windows the machine must be domain-joined or enrolled
  ([Windows](https://support.google.com/chrome/a/answer/7532015), [Chromium issue](https://issues.chromium.org/issues/331061788)),
  on macOS via a configuration profile ([Mac](https://support.google.com/chrome/a/answer/7517624); managed-machine
  requirement **UNVERIFIED**). Not a path for individual users.
- **Precedents for zip + load unpacked**: uBlock Origin (MV2) via GitHub Releases
  ([Tom's Guide](https://www.tomsguide.com/computing/how-to-bring-back-ublock-origin-in-chrome-whether-youre-re-enabling-or-installing-it));
  BrowserTools MCP; testomatio ships a keyed GitHub zip and a keyless store zip
  ([issue](https://github.com/testomatio/browser-extension/issues/391)).
- **Fit for Full**: Full's users used to need the source checkout for `pnpm bridge:install` (now `npx splitsession-bridge install`), so load unpacked costs
  them one more step, and the fixed key (and the host's `allowed_origins`) keeps working. Off-store distribution loses
  auto-update and the store's trust signal.

---

## 6. Release mechanics

### 6.1 Versions

- `version`: 1 to 4 dot-separated integers 0 to 65535, no leading zeros; `version_name` is a free display string
  ([version](https://developer.chrome.com/docs/extensions/reference/manifest/version)). Every upload must be higher
  than the last ([prepare](https://developer.chrome.com/docs/webstore/prepare)).
- **Recommendation**: both items share `package.json` `version` (0.1.0 now), so a tag `v0.1.0` releases both. An
  edition-only fix still bumps the shared version (the other item simply skips that version). Optional `version_name`
  `0.1.0 beta` while the README says beta.
- Cadence: small, batched updates (every review can take days). Anything that adds a **required** permission goes in a
  release of its own with release notes.

### 6.2 Store ID vs our `key`

- **The store rejects a manifest with `key`**: "key field is not allowed in manifest" on a new item (testomatio,
  2026-09-25, [issue](https://github.com/testomatio/browser-extension/issues/391)) and on uploads in general (CrossPaste,
  2026-10, [issue](https://github.com/CrossPaste/crosspaste-desktop/issues/5182)). The documented flow is the other way
  round: upload first, copy the store's public key from Package > View public key, and put *that* in a dev manifest so
  local builds share the store ID ([manifest key](https://developer.chrome.com/docs/extensions/reference/manifest/key)).
  You cannot choose a store ID; the old key.pem-in-zip trick is undocumented (**UNVERIFIED**, do not rely on it).
- **Lite**: no `key` today, nothing to do. The store assigns the ID. Optionally adopt the store key later for local
  Lite builds (not needed).
- **Full on the store** (if ever): the store item gets a **new ID**. Consequences: (1) the store zip must be built
  without `key`; (2) the native host manifest's `allowed_origins` must list both IDs (it accepts a list; from the
  native-messaging docs, **UNVERIFIED** here) and `scripts/bridge-install.mjs` must write both; (3) docs/agents.md's
  fixed `EXT` address differs per install; (4) containers do not move between IDs (storage is per extension), so
  switching a user from the keyed build to the store build needs Export then Import.
- **Full off the store**: keep the key; nothing changes.

### 6.3 Permission increases

- Adding a permission with a warning **disables the extension until the user accepts** it
  ([permission warnings](https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings)). For a
  container extension that means container tabs fall back to the regular profile until the user re-enables: treat any
  new required permission as a breaking release.
- Optional permissions do not disable; `debugger` and `declarativeNetRequest` cannot be optional
  ([permissions API](https://developer.chrome.com/docs/extensions/reference/api/permissions)).
- **Lite must never grow into Full's permissions by update**: that is exactly why Full is a separate item.
- Removing `cookies` (optional) has no user-visible effect.

### 6.4 Rollback

- Dashboard rollback exists: "Roll back to previous version" republishes the previous package under a **new version
  number**, without review, in about a minute; pending and staged submissions are discarded
  ([rollback](https://developer.chrome.com/docs/webstore/rollback),
  [announcement](https://developer.chrome.com/blog/chrome-webstore-rollback)).
- The previous code must read the newer storage format: never change the stored format without a reader that tolerates
  the next version.

### 6.5 Publishing from GitHub Actions

- **Chrome Web Store API v2** (announced 2025-10-15). **API v1 stops working on 2026-10-15** (tomorrow from this
  document's date) ([blog](https://developer.chrome.com/blog/cws-api-v2)). Use v2 only.
- v2 endpoints at `https://chromewebstore.googleapis.com`: `…/upload/v2/publishers/{publisherId}/items/{itemId}:upload`,
  `…:publish` (`publishType` `DEFAULT_PUBLISH` or `STAGED_PUBLISH`), `…:fetchStatus`, `…:setPublishedDeployPercentage`,
  `…:cancelSubmission` ([using the API](https://developer.chrome.com/docs/webstore/using-api),
  [publish reference](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/publish)).
  `skipReview` only applies to static-ruleset-only DNR changes ([skip review](https://developer.chrome.com/docs/webstore/skip-review)).
- **v2 cannot create items**: the first upload, listing, privacy tab and visibility changes are manual in the dashboard
  ([blog](https://developer.chrome.com/blog/cws-api-v2)).
- **Auth**: preferred is a **service account** (create one with no roles, add its e-mail in the dashboard's Account
  section, one per publisher) ([service accounts](https://developer.chrome.com/docs/webstore/service-accounts)); the
  alternative is an OAuth client plus a refresh token from the OAuth Playground with scope
  `https://www.googleapis.com/auth/chromewebstore` ([using the API](https://developer.chrome.com/docs/webstore/using-api)).
- **Tooling**: `wxt submit` supports v2 (`--chrome-api-version v2`, `--chrome-publisher-id`,
  `--chrome-publish-type STAGED_PUBLISH`, service-account flags) ([wxt submit](https://wxt.dev/api/cli/wxt-submit));
  set the version explicitly, the guide page still shows v1-style secrets. Alternative: `mnao305/chrome-extension-upload`
  v7 ([repo](https://github.com/mnao305/chrome-extension-upload)).
- Suggested job (after the first manual upload): on tag `v*`, after `release`, run `wxt submit` for the Lite zip with
  `STAGED_PUBLISH`, secrets `CWS_PUBLISHER_ID`, `CWS_LITE_ITEM_ID`, service-account e-mail and key in GitHub secrets;
  press Publish in the dashboard after approval. Keep it manual-approval (`environment` with required reviewers).
- **Package**: zip with `manifest.json` at the root (`wxt zip` does this); no size limit is documented
  ([prepare](https://developer.chrome.com/docs/webstore/prepare)). Minified code is allowed, obfuscation is not; no
  source maps are required. Add the GitHub link in the reviewer notes so the reviewer can read unminified source.
- **Signing**: the store signs; nothing to do. Optional **Verified CRX uploads** (since 2025-05) make the store accept
  only CRX files signed with your key; losing the key means up to a week of support
  ([blog](https://developer.chrome.com/blog/verified-uploads-cws)). **Skip for v0.1** (CI tooling support for CRX upload
  unverified).

---

## 7. Checklists for v0.1.0

### 7.1 Lite (store item: "SplitSession: Multiple Logins per Site")

1. Code: remove `optional_permissions: ["cookies"]` from `wxt.config.ts` (and the decisions note), rebuild, `pnpm build:lite`.
2. Code (recommended): one-line in-product notice on first container creation that its cookies stay on this device (2.7).
3. Verify by hand on **Chrome stable** with real accounts: one Google account, one Microsoft account and one ordinary
   site in two containers; a restart with "Continue where you left off" (section 4).
4. Make `Misyuk-T/splitsession` **public**; enable GitHub Pages (`main`, `/docs`); the privacy policy (`docs/privacy.md`) is then
   served at `https://misyuk-t.github.io/splitsession/privacy`; check it loads.
5. Update `EDITIONS.lite.description` to the final summary (listing-draft.md) and bump nothing else.
6. Assets: icon padding check; 3 to 5 screenshots 1280x800 without alpha (popup with two containers on the same site,
   tab groups, domain rules, options, dark theme); small promo tile 440x280.
7. Account: register (fee), 2-Step Verification, verify contact e-mail, publisher name, declare **non-trader**; add a
   mail filter so `chromewebstore` mail never lands in spam.
8. Run the release gate from docs/development.md (full e2e three times, independent review) on the release commit; tag
   `v0.1.0`; CI makes the GitHub Release.
9. Dashboard: Add new item → upload `splitsession-lite-0.1.0.zip` (no `key`; confirm the bundle check passed).
10. Store listing tab: description, category Productivity > Tools, language English, screenshots, tile, homepage and
    support URLs (GitHub, issues).
11. Privacy tab: single purpose, one justification per permission, remote code "No", data usage (authentication
    information, web history), three certifications, privacy policy URL.
12. Distribution: Public, all regions; untick auto-publish (deferred publishing).
13. Reviewer notes: what it does in two sentences, "no network requests, no remote code", how to test (create two
    containers, sign in to the same site twice), link to source.
14. Submit. Expect 1 to 4 weeks; contact One Stop Support after 3 weeks.
15. After approval: install the store build in a clean profile, smoke test, then Publish. Record the store item ID in
    docs/development.md and the README; switch the README "Install" to the store link.
16. Set up CI publishing (6.5) only after the first version is live: service account, secrets, `wxt submit --chrome-api-version v2`.

### 7.2 Full

**Recommended for v0.1.0: do not submit Full to the store; ship it as the GitHub Release zip (load unpacked).**

1. Same code and verification steps as Lite 1 to 3 (cookies removal applies to both).
2. Release notes on the GitHub Release: Developer mode required, no auto-update, how to update (replace folder,
   reload), containers survive an update in place because the ID is fixed.
3. README: Full = GitHub Release; Lite = store.

**If Full goes to the store later** (prerequisites first):

1. ~~A host installer that does not need the source checkout~~ done: the npm package `splitsession-bridge` (`npx splitsession-bridge install`, [npm.md](npm.md)); it is still to be published, and it takes the Store ID with `--extension-id`.
2. A store zip without `key`; `install --extension-id` writes the Store ID into `allowed_origins` (repeat it to allow both IDs); docs/agents.md explains the two IDs (6.2).
3. Single-purpose framing decided (2.6) and the description rewritten around it.
4. Privacy policy section for the bridge; data usage adds website content and user activity (1.4).
5. Remote-code answer "Yes" with the Debugger API explanation (2.3).
6. Reviewer notes with a short screen recording of `npx splitsession-bridge install` → switch on → an agent clicking in a container tab.
7. Visibility **Unlisted** first; promote to Public after a few weeks without problems.
