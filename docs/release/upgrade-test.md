# Lite → Full on one store item: the packed-update test (manual, 2026-10-27)

The store item `hhodioekcdmhpocjbkjnblmbmchddphf` goes from Lite to the store build of Full in place
(docs/decisions.md, "The store item becomes Full"). Full adds the required `nativeMessaging` and `debugger`, so Chrome
disables the extension after the update until the user approves the new permissions
([permission warnings](https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings#update_permissions)).
This page is the check of that path with real packed builds, to run by hand before the upload.

## What is automated and what is not

- **Automated** (`e2e/store-upgrade.spec.ts`, part of `pnpm e2e`): Lite and the store build made with one throwaway key,
  so both load *unpacked* at one ID in one profile. Lite's containers (names, colours), container tabs, tab groups, jars and
  settings are all there under the store build; Full-only settings are at their defaults; the bridge is off and no consent
  is recorded. Disable → enable from chrome://extensions: the tabs keep their containers and isolation returns. Disabled
  across a browser restart: the restored container tabs load **with the real profile's cookies** (asserted), and after
  enabling they are back in their containers with their own cookies.
- **Not automated: the packed update itself** (the "disabled until you approve" state, the prompt, the approval). Tried
  2026-10-27 in Playwright's Chrome for Testing 1248 on macOS: the .crx files pack fine (`--pack-extension`), but there is
  no way to install one without a person. A drag synthesised over CDP (`Input.dispatchDragEvent` with the file) shows
  "Drop to install" on chrome://extensions but installs nothing (the install reads the browser's native drop data, which a
  synthetic drag does not set); opening the .crx as a `file://` address only downloads it; the install confirmation is a
  native dialog that Playwright cannot press, and macOS refuses scripted key presses without Accessibility permission;
  force-installing by policy would skip the permission prompt, which is the thing under test. An unpacked extension never
  enters the "pending approval" state (unpacked reloads grant new permissions silently).
- Unpacked loading has one artefact the store path does not have: launched from the command line with a new manifest at
  the same ID, Chromium kept running the *old* service worker code until the extension was reloaded once. The spec reloads
  it. Step 4 below checks that a real update starts the new code by itself.

## Manual test (about 30 minutes)

You need: Google Chrome stable, a scratch Chrome profile (Chrome menu → Profiles → Add, "Continue without an account"),
a terminal in the repository.

### 1. Builds with one throwaway key

```sh
mkdir -p /tmp/ss-upgrade && cd /tmp/ss-upgrade
openssl genrsa -out key.pem 2048                       # throwaway; never into the repository
K=$(openssl rsa -in key.pem -pubout -outform DER | base64 | tr -d '\n')
cd ~/Documents/projects/facet                          # the checkout with the store build
FACET_EDITION=lite  FACET_OUT_DIR=/tmp/ss-upgrade/lite  FACET_TEST_KEY="$K" pnpm exec wxt build
FACET_EDITION=store FACET_OUT_DIR=/tmp/ss-upgrade/store FACET_TEST_KEY="$K" pnpm exec wxt build
```

Give the store build a higher version, as the real upload will have (edit `/tmp/ss-upgrade/store/chrome-mv3/manifest.json`,
e.g. `"version": "0.1.12"` → `"0.1.13"`). Then pack both with that key: chrome://extensions → Developer mode on →
**Pack extension** → root `/tmp/ss-upgrade/lite/chrome-mv3`, key `/tmp/ss-upgrade/key.pem`; again for
`/tmp/ss-upgrade/store/chrome-mv3`. You get `lite/chrome-mv3.crx` and `store/chrome-mv3.crx`.

Start the test server in a second terminal: `pnpm stand` (port 47321; hosts `a.localhost` etc.).

### 2. Install Lite (packed) and make data

In the scratch profile:

1. chrome://extensions, Developer mode on, drag `lite/chrome-mv3.crx` onto the page, **Add extension**. Note the ID
   shown; it must be the same after the update.
2. Plain tab: `http://a.localhost:47321/set?c=who%3Dreal%3B%20Max-Age%3D86400%3B%20Path%3D%2F` (the real profile's cookie).
3. Popup → create containers **Work** (blue) and **Home** (orange).
4. In Work: open `http://a.localhost:47321/login?user=alice`; in Home: `http://a.localhost:47321/login?user=bob`. Each
   shows its user at `/whoami`; a plain tab shows `anonymous` (and `who=real` in the cookies line).
5. Settings: switch off "Mark container tabs outside their group" and "Remember tabs when a container’s last tab closes"; switch on "Strict mode".
6. Chrome settings → On start-up → **Continue where you left off**.

### 3. The update (the step that matters)

Drag `store/chrome-mv3.crx` onto chrome://extensions. Chrome treats it as an update of the same ID.

- [ ] Expected: the card shows the new version, and the extension is **disabled** with a notice that it needs new
      permissions ("Read and change … / Communicate with cooperating native applications / Access the page debugger
      backend"); the toolbar puzzle-piece menu offers to re-enable. Record the exact wording and take a screenshot (for
      the release notes and the Lite notice). If Chrome instead shows an install prompt and the extension stays enabled,
      the drag path behaves like a fresh user-accepted install; then test the real path with a store **Unlisted** or
      staged rollout to a test account instead (6.4 in chrome-web-store.md), and note that here.

### 4. While approval is pending

- [ ] Work and Home tabs are still open, still in their tab groups (the groups stay; their colours stay).
- [ ] Reload the Work tab and open `/whoami`: record what it shows. Expected per the automated test: the **real**
      profile's cookie (`who=real`, user `anonymous`). That is the isolation gap; nothing from Work's jar leaks to the
      site, but requests go as the real profile.
- [ ] A new tab opened from the Work group: also a plain tab (expected).
- [ ] Logins made now in those tabs land in the **real** profile (expected; worth one line in the release notes).

### 5. Restart while pending

- [ ] Quit Chrome (Cmd+Q) without approving; start it again. The extension is still disabled.
- [ ] The Work and Home tabs come back (Continue where you left off) and load as ordinary tabs (`who=real`).

### 6. Approve

- [ ] Re-enable from the puzzle-piece menu or chrome://extensions and accept the permissions.
- [ ] Within a few seconds the Work and Home tabs are back in their containers (popup shows their tab counts; the
      groups are SplitSession's again). Reload them: `/whoami` shows `alice` and `bob`. A plain tab still shows `anonymous`.
- [ ] Popup and Settings open without errors; containers, names, colours are Lite's; the two changed settings are kept.
- [ ] Settings → For AI agents: "Agent bridge" is **off**. Switching it on shows the consent dialog first.
- [ ] Diagnostics log: no errors around the update; one service worker running the new version (chrome://extensions →
      "service worker" link → console: `chrome.runtime.getManifest().version` is the new version and
      `typeof facet.getBridgeState === "function"`, i.e. the Full code runs without a manual reload).

### 7. Rollback (chrome-web-store.md 6.4)

- [ ] Build Lite again with a version higher than the store build (e.g. `0.1.14`), pack it with the same key, drag it on.
      Chrome accepts it (fewer permissions: no prompt).
- [ ] Containers, tabs and the two changed settings are all there; the Lite popup and Settings show no errors.
      (Full-only settings and the consent record stay in storage; Lite ignores them.)

### 8. Clean up

Remove the extension from the scratch profile, delete the profile, `rm -rf /tmp/ss-upgrade` (the throwaway key goes with it).

Write the results (dates, Chrome version, wording of the prompt, what step 4 showed) at the end of this file.
