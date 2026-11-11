# Open questions (observations without a decision)

## A tab dragged out of its container's group (2026-10-11)
**Observation (manual test):** a container tab was dragged out of its group. It stays in the container and keeps living as that container's account. There is no reverse effect (it does not return to the main profile). A tab dragged *into* a container's group, on the other hand, is moved by SplitSession into that container (`64494a3`). The behaviour is asymmetric, and a tab outside the group looks ordinary although its account is the container's (only the badge on the active tab shows it).

**Options:**
1. Leave as is: dragging out does not change the account (protection against accidentally switching to the main account).
2. Symmetric: the dragged-out tab is reopened in the ordinary profile.
3. "The group always tells the truth": a container tab that was dragged out returns to its group (without a reload); it goes to the ordinary profile only through an explicit action, "Reopen in... > No container".

**Decision:** not taken; recorded as an observation only (2026-10-11).

## Container tab requests while the extension restarts (2026-11-04)
**Observation (live log, mail.google.com):** right after a restart of the extension (an update, and now the bridge's one-shot restart after the `nativeMessaging` grant), the log showed "ignored 6 Set-Cookie of a request sent outside the container's rules". The rules of a container tab are session rules and are gone with the old worker; the tab keeps running and sends requests (polling, XHR, a navigation) in the few hundred milliseconds before the rules are installed again. Those requests carry the regular profile's cookies, and their `Set-Cookie` is dropped, not stored anywhere.

**Options:**
1. Leave as is, documented in limits.md (the window is short; the update case happens once per release).
2. Before a planned self-restart (the bridge's one), hold the container tabs: block them with the same rule the restore uses, or reload them after the rules are back.
3. After any restart, reload the container tabs that made a request in the gap (the log already identifies them).
4. Install the rules from `onStartup`/worker start before anything else is awaited, to shrink the window (the part that is ours; the browser's own gap on an update stays).

**Decision:** not taken; documented only (2026-11-04).

## `run_js` in the store build (2026-11-05)
**Observation:** the store item (0.2.0, published 2026-11-05) has no `run_js`. `debugger` cannot be optional, and as a required permission it disables the extension for every user until they approve, with container tabs sending the regular profile's cookies meanwhile (decisions.md, 2026-10-27 and 2026-11-04). An optional `userScripts` with `chrome.userScripts.execute` would give JavaScript without that: Chrome 135+, the user turns on "Allow User Scripts" on the extension's details page, and the store's remote-code answer becomes "Yes". It gives no trusted input, dialogs, uploads or console and network records. The code existed until 2026-10-13 (decisions.md, "Removed"); as an optional permission on this build it has not been live-tested.

**Options:**
1. Optional `userScripts` as above.
2. A submission with `debugger`, auto-publish off, to learn whether the store accepts it; a rejection stays on record, and a hotfix means cancelling the submission.
3. Leave as is: the unpacked Full from GitHub has `run_js`.

**Decision:** a build with `debugger` goes to review with auto-publish off (2026-11-05, branch `store-debugger`); whether to publish it is open.

**Decision (2026-11-11): not published.** 0.3.0 was approved by the store (2026-11-06) and stays unpublished; the store keeps the build without `debugger` (option 3). Reason: every existing user would get the extension disabled until they accept, with container tabs on the regular profile's cookies meanwhile, for a gain only users who connect an AI client see; they have the unpacked Full. The approved draft is dropped when the next patch (0.2.1) is uploaded. Revisit with option 1 if store users ask for `run_js`. Branch `store-debugger` is kept, not merged.
