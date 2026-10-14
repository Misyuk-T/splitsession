# Development

The product is called SplitSession (renamed from Facet on 2026-10-11). The local repository folder is still `facet/` and
internal identifiers keep the old name on purpose (`docs/decisions.md`, "Rename").

Requirements: Node 22+, pnpm 10.

```sh
pnpm install        # also runs `wxt prepare`
pnpm typecheck      # tsc --noEmit (src), tsc -p e2e, tsc -p bridge
pnpm test           # vitest run (src/**/*.test.ts, bridge/**/*.test.ts)
pnpm build          # Full edition: unpacked extension in .output/chrome-mv3 (= pnpm build:full)
pnpm build:lite     # Lite edition: .output/lite/chrome-mv3, then scripts/check-lite.mjs
pnpm e2e            # build both editions and the agent bridge, then Playwright e2e against the local stand (headless)
pnpm e2e:lite       # build Lite and run only e2e/lite.spec.ts
pnpm bridge:build   # bundle the agent bridge into bridge/dist/ (the npm package `splitsession-bridge`; bridge:install / bridge:uninstall run its install / uninstall from this checkout)
pnpm zip:full       # release zip: .output/splitsession-full-<version>.zip (pnpm zip is the same)
pnpm zip:lite       # release zip: .output/lite/splitsession-lite-<version>.zip (builds and checks Lite first)
pnpm dev            # WXT dev mode (Full) with a throwaway Chrome profile; pnpm dev:lite for Lite
pnpm stand          # the e2e stand alone: http://a.localhost:47321/
```

### E2E

`pnpm e2e` builds the extension and runs `e2e/*.spec.ts` with Playwright's bundled Chromium (branded Chrome no longer
loads unpacked extensions from the command line). Install the browser once with `pnpm exec playwright install chromium`.
`HEADED=1 pnpm e2e` shows the browser; `pnpm e2e:only -g <name>` skips the build and filters tests. On failure the
extension's log and the stand's request log are attached to the test result (`FACET_E2E_DEBUG=1` prints them).

The stand (`test-server/server.mjs`, plain Node) answers for `a.localhost`, `sub.a.localhost`, `b.localhost`,
`sso.localhost`, `cdn.localhost` and `nosw.localhost` on port 47321 (`FACET_TEST_PORT`): Chrome resolves `*.localhost`
to loopback, so these are distinct sites without DNS or certificates. `GET /__log` returns every request it saw with its
Cookie header; tests use it to check what the first request of a flow carried.

In the service worker the background API is available as `globalThis.facet` (DevTools console, or Playwright
`worker.evaluate`): `facet.createContainer({name})`, `facet.openInContainer(url, idOrName)`, `facet.getLog()`, …

Load `.output/chrome-mv3` (Full) or `.output/lite/chrome-mv3` (Lite) via `chrome://extensions` > "Load unpacked" to try a build by hand.

## Editions (Lite and Full)

One codebase, two builds (the decision and its reasons: [decisions.md](decisions.md), "Two editions"). The edition is chosen
by the environment variable `FACET_EDITION` (`lite`; anything else or unset is Full), read once in `wxt.config.ts`:

- **Name and description** per edition: the `EDITIONS` table at the top of `wxt.config.ts` (the only place).
- **Manifest**: Lite drops the `nativeMessaging` and `debugger` permissions, and has no `key`.
- **Output**: Full `.output/chrome-mv3` (the folder the author loads unpacked; unchanged), Lite `.output/lite/chrome-mv3`.
  Zips are named `splitsession-<edition>-<version>.zip`.
- **Code**: `wxt.config.ts` defines the compile-time constant `__FULL__` (declared in `src/env.d.ts`; `vitest.config.ts` sets it
  `true`, so unit tests run the Full edition). The bundler removes every `if (__FULL__)` branch from Lite and, with it, the
  modules only those branches use. Full-only code is therefore always reached through such a branch: the agent side of the
  worker is `src/background/full-edition.ts` (called from `src/background/index.ts`), the interface pieces (`BridgeCard`,
  `BridgeSection`, the two page-name switches) sit behind `__FULL__` in the popup and options,
  the beacon starts `title-prefix.ts` only under it, and `src/core/settings.ts` gives Lite a smaller settings schema
  (`tabGroups`, `strictMode`, `restoreTabs`, `markOutsideGroup`; an update naming any other key is an error). A stylesheet only the bridge card uses is resolved to an empty
  module (a side-effect-only `import './x.css'` survives tree-shaking by itself).
- **Adding code to the agent side**: put it behind `__FULL__`, then run `pnpm build:lite`. `scripts/check-lite.mjs` (run by
  `build:lite` and `zip:lite`, and by CI) scans every file of the Lite output for bridge / CDP / page-name markers and the
  manifest for the three permissions, and fails with the file and the offending text. A top-level statement with a side
  effect in a module that is otherwise dead (`TOOLS.map(...)` once kept the whole tool list alive) needs `/* @__PURE__ */`.
- **IDs**: Full is pinned by `extension-key.pub` (below). Lite has no `key`: the Web Store assigns the published ID, a local
  unpacked Lite gets one derived from its folder's path. `e2e/lite.spec.ts` reads it from its own service-worker URL.
- **Tests**: every spec except `lite.spec.ts` runs the Full build. `lite.spec.ts` launches `.output/lite/chrome-mv3` in its own
  browser (skipped when it is not built) and checks the manifest, the missing APIs, the settings schema, 302 login isolation
  between two containers, and the popup and options pages. `pnpm e2e` builds both editions first.
- **CI**: `.github/workflows/ci.yml`: typecheck, unit tests, both builds with the Lite check, both zips as artifacts; on a tag
  `v<version>` (it must equal `package.json`'s version) a GitHub Release with `splitsession-lite-<version>.zip` and
  `splitsession-full-<version>.zip`. No e2e there yet.

## Layout

| Path | Purpose |
| --- | --- |
| `src/core` | Pure TypeScript, no `chrome.*`: types, cookie jar, `Set-Cookie` parser, DNR rule compiler, page keys (`page-key.ts`, HMAC-SHA-256), timing helpers (`async.ts`: `sleep`, `Wakeups`, `Debounced`, `deleteWhere`), the pure part of container tabs that come back (`restore.ts` re-exports `restore/`: constants, group marker, gate, window signatures, records, recently closed, matching, held page); and the Stage C logic: settings, container-name rules, domain rules and their exemptions, export/import validation, badge/title helpers. Fully unit-tested. |
| `src/engine` | Pieces around `chrome.*` behind small interfaces (unit-tested with fakes): session-rule manager and ID pool, container/tab stores, stale-navigation detector, SW policy and strict mode (`sw-policy.ts`, `strict-mode.ts`), content-script registration, API client. |
| `src/background` | The service worker. `full-edition.ts` is the Full-only agent side (bridge, CDP sessions, activity display), reached from `index.ts` through `__FULL__` only. `facet.ts` (the isolation engine: wiring, rehydration and its API; the parts live in `isolation/`: `assignments`, `container-rules` (session-rule compiler, frame sites), `cookie-capture` (Set-Cookie, `document.cookie`, fetch barrier), `ctr-marker`, `popup-children`, `own-tabs`, `tab-opener`, `browser-events` (what each tab, navigation and webRequest event does), `content-messages` (a handler per message type), `after-update`, `page-keys`), `restore.ts` (container tabs that come back; `restore/`: gate, snapshot, session state, held status), `listeners.ts` (top-level event registration; `on-event.ts` is the shared `addListener` helper), `api.ts` (engine API). Stage C, built on `facet.events`: `extras.ts` (wiring), `extras-listeners.ts`, `extras-api.ts` + `full-api.ts` (settings, rules, import/export, choose page), `domain-rule-engine.ts`, `exemption-manager.ts`, `rule-store.ts`, `settings-store.ts`, `tab-groups.ts`, `badges.ts`, `transfer-apply.ts`. `src/entrypoints/background.ts` is only the WXT shim around it. |
| `src/content` | `beacon.isolated.ts` (ISOLATED world; also starts `group-mark.ts` and, in Full, `title-prefix.ts` in the top frame of container tabs; `title-layers.ts` is the one writer of `document.title` for both) and `shim.main.ts` (MAIN world; `shim/`: natives captured at evaluation, the bridge channel, the frame guard, patch helpers, one module per patched API in `shim/patches/`, and `install.ts`, the table of each mode's patches in order), built as `beacon.js` / `shim.js` by `src/entrypoints/{beacon,shim}.ts` and registered at runtime. |
| `src/ui` | The interface: `components/` (Button, Switch/Checkbox, TextField, ColorPicker, MenuButton, Select, Dialog, ContainerForm), `theme.css` and `components.css`, and one folder per page: `popup` (`Popup.tsx` composes `Header`, `HeldBanner`, `ThisTabRow`, `ContainerRow`, `DeleteDialog`; data in `usePopupData`, status line and action runner in `useStatus`), `options`, `choose`. Preact, plain CSS, no UI library. |
| `src/entrypoints` | WXT entrypoints: `background`, `beacon`, `shim`, `popup`, `options`, `open`, `choose` (HTML shells that load the code above). |
| `assets/icon.svg`, `public/icons` | The mark and the PNGs rendered from it (`node scripts/make-icons.mjs`, needs Playwright's Chromium; the PNGs are committed). |
| `public/rules` | Static DNR ruleset (default beacon answer). |
| `src/ui/fonts.css`, `public/fonts` | Bundled fonts, no network: Inter and JetBrains Mono (variable woff2; Latin, Latin Extended and Cyrillic subsets only; SIL OFL 1.1, licence texts in `public/fonts/LICENSE-*.txt`), from the `@fontsource-variable/*` devDependencies. About +230 KB in both editions. The in-page agent overlay keeps the system font on purpose: loading Inter into a web page's shadow root needs `web_accessible_resources`, which lets pages detect the extension. |
| `test-server/`, `e2e/` | Local multi-host stand and Playwright tests (`e2e/security.spec.ts`: regression tests of the 2026-10-09 isolation review; `e2e/extension.ts`: launch flags, worker lookup, the worker test-API caller and the popup page, shared by the fixtures and the specs with their own browser). |
| `bridge/`, `src/bridge/` | The agent bridge (docs/agents.md, section 7). `src/bridge/`: pure shared pieces (Native Messaging framing, protocol, the tool list `spec.ts`, argument validator) used by the extension, the host and the MCP server. `bridge/src/`: the Node program (`main.ts` dispatches the subcommands; `cli.ts` is `install` / `uninstall` / `status` with the per-browser paths in `paths.ts` and the AI-client snippets; `host.ts`, `mcp.ts`, `relay.ts`), bundled by `bridge/build.mjs` into `bridge/dist/splitsession-bridge.mjs`. `bridge/package.json` makes it the npm package `splitsession-bridge` (published by hand: `docs/release/npm.md`). Extension side: `src/background/bridge/` (`agent-bridge.ts` connection, status and the recent-actions list, `router.ts` validation and dispatch through one table of tools, `tools/` the tools by kind (tabs, read, input, devtools), `tool-context.ts` their tab/page/CDP helpers, `tool-kit.ts` argument and result basics, `inject.ts` page functions, `activity.ts` + `overlay.ts` the visible agent activity: overlay, title mark, AI badge). `e2e/agent-bridge.spec.ts` and `e2e/agent-activity.spec.ts` drive it with the MCP SDK client; the host manifest goes into the test profile's own `NativeMessagingHosts`. |
| `scripts/` | `bridge-install.mjs` (thin wrapper: builds the bridge, then runs its `install` / `uninstall`; `--client none` by default), `keygen.mjs` (extension key), `make-icons.mjs`, `screenshots.mjs` (README pictures: `pnpm build && node bridge/build.mjs && node scripts/screenshots.mjs` writes `docs/screenshots/`; it connects the bridge to a temporary host so the popup shows its recent actions). |

### Test hooks

- `popup.html?tab=<tabId>` makes the popup act on that tab instead of the active tab of the window (a popup opened as a
  tab in a test would otherwise see itself).
- The agent-activity overlay has a closed shadow root: the e2e reads its state (`__facetAgentActivity`, text, pulse count and
  rectangle, hidden flag) from the extension's ISOLATED world with `scripting.executeScript` run in the worker.
- In the service worker the whole API is `globalThis.facet`; the e2e fixture also has `facet.tabInfo(id)` (title, group,
  badge as Chrome reports them), `facet.groupInfo(id)` and `facet.inWorker(fn, arg)`.
- The fixture resets domain rules and settings before every test; containers and tabs from earlier tests stay.

What is and is not isolated: [limits.md](limits.md).

`src/entrypoints/` exists because WXT discovers entrypoints in a directory of that name; real logic lives in the folders above and is imported from there.

## Release gate

Before a public release, on the release commit:

1. `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`.
2. `pnpm build` and `pnpm build:lite` (the latter runs `scripts/check-lite.mjs`).
3. The full `pnpm e2e` three times in a row (the isolation tests are timing sensitive; a single green run is not enough).
4. An independent review of everything changed since the previous release, with extra attention to isolation (DNR rules,
   cookies, the beacon and shim, service workers, strict mode), the agent bridge and `debugger`, and manifest permissions.

## Extension ID and signing key

The **Full** manifest carries a `key` so that the extension ID is the same on every machine and build (Lite has none, see Editions above):

```
hapfikidacgfgnnajkgnaednpgnhmffk
```

- `extension-key.pub` (committed): base64 public key, read by `wxt.config.ts`.
- `keys/facet.pem` (**gitignored**, never commit): the matching private key. The ID is derived from the public key only, so day-to-day development does not need the private key. It is required only to pack a CRX signed with this identity.

Regenerate (this changes the extension ID; update anything that hardcodes it):

```sh
node scripts/keygen.mjs --force   # writes keys/facet.pem and extension-key.pub, prints the new ID
node scripts/keygen.mjs --id   # print the ID of the committed public key
```

A fresh clone has `extension-key.pub` but not `keys/facet.pem`; that is intended.
