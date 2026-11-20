# Module 03 — Profile Manager

*AEGOX_multisession · organizational profiles above Session Core*

This document describes the Profile Manager that was added on top of the Session Core from
Module 02. It covers the data model, the public APIs, the deletion and import rules, the
security boundaries and what is deliberately **not** implemented.

The Profile Manager is browser-neutral TypeScript. It stores JSON through the same
`StorageAreaLike` abstraction used by Session Core, so unit tests run without a browser and a
future UI/background layer can pass `chrome.storage.local`.

---

## 1. What a profile is (and is not)

A **profile** is the user's organizational layer: a named group with a color, an icon, an
optional description, tags, a folder, website guardrails, settings and an optional password.

It is **not** a browser profile, a container, or a guarantee of isolation. A profile groups
*sessions* by reference (`SessionMetadata.profileId`). Whether those sessions are actually
isolated is decided by the Session Core browser adapter and is documented in
[limits.md](./limits.md).

```
Profile (name, color, tags, folder, rules, settings, protection)
   └── SessionMetadata.profileId  →  Session (cookies, storage, lifecycle)
```

Nothing in this module claims that choosing a profile changes cookies, storage or the network.
It only records which sessions belong together.

---

## 2. Data model

| Type | Purpose |
| --- | --- |
| `Profile` | `id` (UUID v4), `state`, `metadata`, `origin`, `expiresAt`, `folderId`, `tags`, `order`, `hasIndependentPassword`, `websiteRules`, `settings` |
| `ProfileMetadata` | `name`, `color`, `icon`, `description`, `createdAt`, `lastUsedAt`, `isDefault` |
| `ProfileFolder` | `id`, `name`, `color`, `createdAt`, `order` |
| `ProfileSettings` | `restoreSessionsOnStartup`, `persistSessionData`, `websiteMode`, `collectStatistics`, `temporaryExpiryAction` |
| `WebsiteRule` | `domain`, `action` (`allow`/`block`), `enabled`, `createdAt` |
| `ProfileState` | `active`, `archived`, `temporary`, `deleted` |

### Validation and normalization

All user and storage input passes through `profile.ts`:

- names: whitespace collapsed, control/zero-width/bidi characters stripped, max 64 code points;
- colors: only `#rgb`, `#rrggbb` or `#rrggbbaa` (lowercase); arbitrary CSS is never accepted;
- icons: short text/emoji tokens, max 32 code points;
- descriptions: max 500 code points;
- tags: max 32 per profile, max 32 characters each, de-duplicated case-insensitively;
- website rules: max 500 per profile, domains normalized to a lowercase host (no scheme, path,
  port or credentials);
- settings: untrusted values fall back to conservative defaults.

### IDs

`generateProfileId()` reuses Session Core's `generateSessionId()` and produces an RFC 4122
version 4 UUID. IDs never change during a profile's lifetime. Import may preserve an existing
ID; manual creation always generates a new one.

---

## 3. ProfileManager API

`src/profiles/profile-manager/profile-manager.ts`

| Method | Behavior |
| --- | --- |
| `load()` | Reads profiles and folders; drops invalid records and dangling folder references |
| `create(input)` | Validates, enforces case-insensitive unique names, persists; returns `{ profile, duplicateDetected }` |
| `createWithId(input)` | Restore/import path; preserves the ID and **allows duplicate names** so the conflict is shown to the user |
| `update(id, patch, opts?)` | Validates metadata; `allowDuplicateName` is used only by import |
| `archive` / `restore` / `markDeleted` | State changes; sessions are untouched |
| `delete(id)` | Removes the profile record only; sessions are handled by the deletion module |
| `duplicate(id)` | Copies metadata, tags, folder, rules and settings; **never** copies the password flag or vault |
| `createFolder` / `renameFolder` / `deleteFolder` | Folder management; deleting a folder unassigns its profiles, never deletes them |
| `addTag` / `removeTag` / `assignFolder` | Organization |
| `move(id, beforeId)` | Data operation behind drag-and-drop; renumbers `order` |
| `listFiltered(filters, sort)` | Search (name, description, tags, folder name), folder, tags, state, archived/temporary/deleted flags, sorting |
| `setWebsiteRules(id, rules)` | Replaces a profile's rules with normalized values |
| `getDefault()` | `isDefault` active profile, else the first active profile |

### Duplicate detection

`src/profiles/profile-duplicate/duplicate-detector.ts`

- `profileSimilarity()` is weighted: name 45, description 20, color 15, tags 20.
- `checkDuplicate()` reports candidates at or above `0.6` and returns a human-readable reason.
- `findDuplicateGroups()` groups only by exact name + color.
- `findSimilarPairs()` returns pairs at or above a threshold with explanations.

**Nothing is merged, renamed, archived or deleted automatically.** The UI can warn, but the
decision is always the user's. Manual `create` still rejects duplicate names because the user is
present and can pick another name; `createWithId` preserves imported duplicates on purpose.

---

## 4. Association with Session Core

`src/profiles/profile-association/association.ts`

- `associate(sessionId, profileId, mode)` updates `SessionMetadata.profileId` through
  `SessionManager` and persists an association record.
- `reassign(sessionId, newProfileId)` changes the owning profile.
- `dissociate(sessionId, { detachSession })` removes the record; with `detachSession` the
  session returns to `DEFAULT_PROFILE_ID`.
- `autoAssociateByDomain(session, { defaultProfileId })` applies the most specific matching
  domain rule; **manual associations are never overwritten**. If no rule matches, the optional
  default profile is used.
- `reassignAll(from, to)` and `clearAssociationsForProfile(profileId, { detachSessions })` are
  used by the deletion flow.

Archived and deleted profiles cannot receive sessions. Domain matching is exact-host or
subdomain only: a rule for `example.com` covers `mail.example.com`, not `notexample.com`.

---

## 5. Password protection

`src/profiles/profile-protection/protection.ts` delegates all cryptography to Module 02
(AES-256-GCM + PBKDF2 via Web Crypto). No password or derived key is stored.

Modes:

- `none` — no global master password and no independent password;
- `master` — the profile is protected by the global master password;
- `independent` — the profile has its own vault and password; it takes precedence.

Behavior:

- `checkProtection(profile)` reports `protected`, `locked`, `mode`, `requiresPassword` and a
  reason (including temporary lockout);
- `unlock(profile, password)` verifies through the corresponding `VaultManager`, tracks failed
  attempts and locks out for 15 minutes after 5 failures;
- `lock(profile?)` locks one profile or everything;
- `removeProfileVault(profileId)` forgets an independent vault after deletion.

### Vault verification fix (Module 02)

`VaultManager.unlock()` previously derived a key but never checked the password, so any
password produced a key and "unlocked" the vault. The vault now stores an AES-GCM **verifier**
(a fixed marker encrypted with the derived key). A wrong password derives a different key and
authentication fails. This uses the existing `encrypt`/`decrypt` functions; no custom
cryptography was added.

Vaults created before this change have no verifier. They are migrated on their first successful
unlock (trust on first use) and verified from then on. This limitation is documented rather than
hidden.

### What protection does not do

- It does not encrypt profile names, tags, colors, folders or website rules; those stay readable
  in local storage.
- It does not make profile data inaccessible to other extensions or to code running as the user.
- It does not encrypt sessions or cookies. Session encryption belongs to the security module.
- Export never includes the independent-password flag or any vault data; after importing a
  profile the user must protect it again manually.

---

## 6. Temporary profiles

`src/profiles/profile-temporary/temporary.ts`

- `create(input, { ttlMs, onExpire })` and `makeTemporary(profileId, …)` set `expiresAt`.
- `checkExpiration(profile)` returns `{ expired, timeRemainingMs, expiresAt }`.
- `sweep()` only **reports** expired profiles configured with `temporaryExpiryAction: "notify"`
  and **archives** those configured with `"archive"`. It never deletes anything.
- `extend(profileId, ms)`, `makePermanent(profileId)` and `archiveExpired(profileId)` are
  explicit user actions.

---

## 7. Website rules

`src/profiles/profile-rules/website-rules.ts`

Two modes, matching `ProfileSettings.websiteMode`:

- **blocklist** (default): everything is allowed except matching `block` rules;
- **allowlist**: everything is blocked except matching `allow` rules.

Evaluation rules:

1. the most specific (longest) matching domain wins;
2. on a tie, `block` wins;
3. disabled rules are ignored;
4. an invalid address is denied with a warning.

**These are guardrails, not a security boundary.** They are evaluated by extension code when a
navigation or a session is created; they do not alter browser cookies, do not prevent a page
from opening by other means, and do not isolate anything. A determined user or page can bypass
them because the browser, not this module, controls navigation.

---

## 8. Deletion

`src/profiles/profile-lifecycle/deletion.ts`

1. `describeDeletionImpact(profileId, …)` lists the affected sessions for the dialog.
2. `deleteProfileWithSessions(deps, { profileId, sessions })` requires a disposition:

| Disposition | Effect on sessions |
| --- | --- |
| `{ action: "keep" }` | Sessions stay in Session Core and move to the default profile (no dangling reference) |
| `{ action: "reassign", toProfileId }` | Sessions move to an active/temporary profile |
| `{ action: "delete", confirmed: true }` | Sessions are deleted **only** with explicit confirmation |

- `{ action: "delete", confirmed: false }` changes nothing and returns a reason.
- Reassigning to the same profile, a missing profile or an unavailable profile is refused before
  anything changes.
- After the sessions are handled, the profile record, its website rules and its local statistics
  are removed.
- A failure during reassignment aborts before the profile is removed, so the user can retry.

The UI component `src/ui/profile-delete-dialog.tsx` enforces the same rules visually: the confirm
button stays disabled until a disposition is chosen, and deletion requires a second checkbox.

---

## 9. Import / export

`src/profiles/profile-import-export/backup.ts`

### Export format (version 1)

```json
{
  "format": "aegox-multisession-profiles",
  "version": 1,
  "exportedAt": 1730000000000,
  "profiles": [
    {
      "id": "…",
      "name": "Work",
      "color": "#4f46e5",
      "icon": "briefcase",
      "description": "Daily work",
      "state": "active",
      "origin": "manual",
      "expiresAt": null,
      "folderId": "…",
      "tags": ["work"],
      "order": 0,
      "websiteRules": [{ "domain": "example.com", "action": "block", "enabled": true }],
      "settings": {
        "restoreSessionsOnStartup": true,
        "persistSessionData": true,
        "websiteMode": "blocklist",
        "collectStatistics": false,
        "temporaryExpiryAction": "notify"
      }
    }
  ],
  "organization": { "folders": [], "tags": ["work"] },
  "includesSensitiveData": false
}
```

### Security rules

- **Never exported:** cookies, authentication tokens, passwords, credentials, vault entries,
  session data, the independent-password flag.
- A defense-in-depth scan rejects files containing keys such as `cookie`, `token`, `password`,
  `secret`, `credential`, `authorization`, `accessToken`, `refreshToken`, `apiKey`, `privateKey`.
- `includesSensitiveData: true` is rejected outright.
- Unknown/newer versions are rejected with an explanation; older unsupported versions are
  rejected too.
- Files larger than 5 MiB are refused before parsing; invalid JSON is refused.
- The whole file is validated before any change is made.
- Duplicate IDs inside one file are rejected. Existing IDs are skipped unless `overwrite: true`.
- Folders are imported preserving their IDs; missing folder references produce a warning and the
  profile is imported without a folder.
- Import never restores password protection. The user must re-protect imported profiles.

---

## 10. Statistics (optional)

`src/profiles/profile-stats/stats.ts`

- Collection is **off** by default (`ProfileSettings.collectStatistics`).
- Records only aggregate counters: session counts, active session counts, switch count,
  first/last use timestamps. No URLs, page titles, search terms or identities.
- When disabled, recording is a no-op; disabling does not erase existing records.
- `MemoryProfileStatsStore` is the default; a future Analytics module can provide a persisted
  `ProfileStatsStore`.

---

## 11. Sync interfaces only

`src/profiles/profile-sync/sync.ts` defines `ProfileSyncProvider`, `ProfileSnapshot`,
`SyncCapabilities` and `ProfileSyncCoordinator`. It contains **no network transport and no cloud
storage**.

`NoopProfileSyncProvider` reports `implemented: false` and a push message stating that
synchronization is not implemented. `getStatus()` never claims sync is active. Snapshots reuse
the safe export format, so a future provider cannot send more than an export allows. Validation
rejects unknown schemas, versions and secret fields.

---

## 12. UI components

| File | Purpose |
| --- | --- |
| `src/ui/profile-list.tsx` | Dashboard-style list: state badge, folder, tags, duplicate warning, actions, drag-and-drop |
| `src/ui/profile-switcher.tsx` | Compact popup switcher with locked/temporary badges |
| `src/ui/profile-delete-dialog.tsx` | Mandatory session-disposition dialog with second confirmation |
| `src/ui/profiles.css` | Classes used by the three components above |

The components are presentational: every mutation is a callback. They do not call Session Core
or `chrome.*` directly.

### Wiring status (important)

The Profile Manager **core** is complete and tested. Mounting these components in the extension
popup, dashboard/options page and background context menu is **not** wired in this module:

- `src/ui/profiles.css` must be imported by the entry point that mounts a profile screen;
- `ProfileNavigation.buildContextMenu()` produces a browser-agnostic model, but
  `chrome.contextMenus.create`/`onClicked` registration and the `background` handler are not
  added yet;
- there is no profile dashboard screen in this module (Dashboard redesign is Module 04);
- the popup still shows containers/sessions from Session Core; the `ProfileSwitcher` component
  exists but is not mounted.

This is deliberate: the module boundaries exclude UI redesign and background rewiring. The
public APIs are ready for that integration.

---

## 13. Browser and security limits (honest list)

1. **Profiles are labels, not sandboxes.** Association never changes cookies, storage or network
   behavior. Isolation is whatever Session Core/the browser actually provides.
2. **Website rules are guardrails.** They are not a security boundary and can be bypassed by the
   browser, another extension or a page that navigates by other means.
3. **Protection covers the vault, not the profile metadata.** Names, tags, colors, folders and
   rules remain readable in local storage.
4. **Local storage is not encrypted at rest** beyond the vault entries. Anyone with access to the
   browser profile can read the JSON.
5. **Failed-attempt lockout is in memory.** Restarting the extension resets the counter. The
   password itself is still required.
6. **Legacy vault migration is trust on first use.** A vault created before the verifier existed
   accepts the first password used after the upgrade and stores a verifier for next time.
7. **Import cannot restore protection.** No vault is present in the file, so importing never
   claims a profile is protected.
8. **Temporary expiration is advisory.** Expired profiles are reported or archived; they are
   never deleted automatically, and nothing runs while the extension is closed.
9. **Duplicate detection is heuristic.** It may miss similar profiles and may flag unrelated
   ones. It never acts on its own.
10. **Statistics are opt-in and aggregate.** They are local counters, not analytics.
11. **Sync is absent.** Only interfaces exist; there is no cloud transport, account or conflict
    resolution.
12. **Drag-and-drop depends on the browser's HTML5 DnD.** Touch devices and some accessibility
    setups need the explicit "move" action instead.

---

## 14. Tests

Everything below runs with `pnpm test` (Vitest, Node environment, `MemoryStorageArea`).

| Suite | Covers |
| --- | --- |
| `profile.test.ts` | IDs, defaults, normalization, validation, name uniqueness/import mode |
| `profile-manager.test.ts` | CRUD, folders, tags, ordering, filtering/sorting, persistence, duplicate names, protection flags on import |
| `association.test.ts` | Manual/automatic association, precedence, detach, reassign, persistence, domain matching |
| `protection.test.ts` | Modes, real vault unlock, wrong password, lockout and recovery, independent vaults |
| `duplicate-detector.test.ts` | Similarity, grouping, explanations, no mutation |
| `website-rules.test.ts` | CRUD, persistence, specific-match wins, block tie-break, allowlist, invalid input |
| `temporary.test.ts` | TTL, expiration, sweep policies, extend/permanent |
| `backup.test.ts` | Export shape, secret rejection, version rejection, round-trip import, overwrite, protection flags |
| `navigation.test.ts` | Active profile, switching, quick list, folders/tags, context-menu model |
| `stats.test.ts` | Opt-in behavior, counters, aggregation, persistence boundary |
| `deletion.test.ts` | Impact, keep/reassign/delete, confirmation requirement, cleanup |
| `sync.test.ts` | Noop provider, status honesty, snapshot validation, secret rejection |

Session Core suites (`src/core`, `src/security`) also run as regression tests.

---

## 15. Known issues / deferred

- Popup, dashboard and context-menu wiring (see §12).
- Profile dashboard/redesign (Module 04).
- Workspace Manager, Automation, Analytics implementation, cloud sync, MCP/AI integration,
  password manager and architectural rewrites are out of scope.
- Profile-level statistics are not persisted by default; the in-memory store is intentional.
- `SessionMetadata.profileId` can only hold one ID; a session belongs to exactly one profile.
- Independent vaults are per profile ID; deleting and re-importing a profile creates a new ID
  unless the ID is preserved by an import, so old vaults are not silently reattached.
- The context-menu model uses `"page"` and `"action"` contexts; the integration layer must map
  them to `chrome.contextMenus` and rebuild the menu when profiles change.

---

## 16. File map

```
src/profiles/
├── index.ts
├── profile-manager/{profile.ts, profile-manager.ts, *.test.ts}
├── profile-association/{association.ts, *.test.ts}
├── profile-protection/{protection.ts, *.test.ts}
├── profile-duplicate/{duplicate-detector.ts, *.test.ts}
├── profile-rules/{website-rules.ts, *.test.ts}
├── profile-temporary/{temporary.ts, *.test.ts}
├── profile-import-export/{backup.ts, *.test.ts}
├── profile-navigation/{navigation.ts, *.test.ts}
├── profile-stats/{stats.ts, *.test.ts}
├── profile-lifecycle/{deletion.ts, *.test.ts}
└── profile-sync/{sync.ts, *.test.ts}

src/ui/{profile-list.tsx, profile-switcher.tsx, profile-delete-dialog.tsx, profiles.css}
```

---

Derived from SplitSession (https://github.com/Misyuk-T/splitsession), MIT License.
Copyright (c) 2026 Taras Misiuk.
