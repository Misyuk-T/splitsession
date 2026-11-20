# AEGOX_multisession — UI Architecture (Module 04)

## Overview

Module 04 provides the **Dashboard & UI System** for AEGOX_multisession. It is a pure presentation layer that integrates:

- **Session Core (Module 02)** — session lifecycle, metadata, persistence
- **Profile Manager (Module 03)** — profiles, folders, tags, navigation, statistics

The dashboard is built as a Preact application (`src/ui/dashboard/main.tsx`) mounted at `dashboard.html`, accessible from the options page or directly.

## Design System

### Theme Tokens (`src/ui-system/theme.ts`)

The AEGOX identity uses a **restrained dark + violet** palette. Tokens are applied as CSS custom properties on the document root:

```typescript
// Light theme
--agx-bg: #f7f6fb
--agx-surface: #ffffff
--agx-accent: #5b3fd6
--agx-text: #16131f

// Dark theme
--agx-bg: #121018
--agx-surface: #1a1722
--agx-accent: #a794ff
--agx-text: #efeaf7
```

All components reference these tokens via `var(--agx-*)`. No hardcoded colours, no gradients, no "AI-looking" patterns.

### Typography

- Base font: **Inter Variable** (with `cv11` single-storey a, `ss01` open digits)
- Mono font: **JetBrains Mono Variable**
- Text scale: 100% / 110% / 120% / 130% (applied as root `font-size` multiplier)
- Minimum text size: 14px (secondary), 16px (main)

### Spacing & Borders

- Radius: `--fx-radius: 8px`, `--fx-radius-sm: 6px`
- Shadow: `--fx-shadow` (theme-aware)
- Border: `--agx-border`, `--agx-borderStrong`

### Motion

- Respects `prefers-reduced-motion: reduce`
- User can choose: `full` / `reduced` / `none`
- No continuous animations; only short transitions (panel slide, widget reorder, toast)

## Navigation

Three modes (`src/ui-system/navigation.ts`):

| Mode | Sidebar | Top Bar |
|------|---------|---------|
| `sidebar` | ✅ | ❌ |
| `top` | ❌ | ✅ |
| `combined` | ✅ (desktop) / drawer (mobile) | ✅ |

Pages exposed (only implemented features):
1. **Dashboard** (Alt+1) — overview, widgets, quick actions
2. **Sessions** (Alt+2) — compact / cards / table views
3. **Profiles** (Alt+3) — profile list with session counts
4. **Settings** (Alt+4) — theme, navigation, motion, text size

Future modules (Workspace Manager, Automation, Security Manager, Backup, Analytics, MCP/AI) have **no navigation entries**.

## Dashboard

### Widgets (`src/ui-system/widgets.ts`)

| Widget | Locked | Default Size | Span | Description |
|--------|--------|--------------|------|-------------|
| Overview | ✅ | large | 2 | Session/profile totals |
| Quick actions | | small | 1 | Create profile/session, search |
| Session breakdown | | medium | 1 | Active/paused/expired/archived/closed |
| Profile overview | | medium | 2 | Profiles with session counts |
| Recent activity | | medium | 1 | Latest timestamps |
| Favorites | | small | 1 | Pinned profiles & sessions |
| Statistics | | medium | 2 | Aggregate stats (when enabled) |
| Security notices | ✅ | medium | 1 | Expired sessions, unprotected profiles |

Customization:
- Add/remove/reorder/resize widgets
- Locked widgets cannot be hidden/removed
- Layout saved in preferences (`widgetLayout`)

### Data Aggregation (`src/ui-system/dashboard-data.ts`)

```typescript
interface DashboardOverview {
  sessions: SessionTotals;        // active/paused/expired/archived/closed
  profiles: ProfileTotals;        // active/archived/temporary/deleted/favorites
  statistics: AggregateStats | null;
  profileSummaries: ProfileSummary[];  // per-profile session counts
  recentActivity: ActivityItem[];
  warnings: SecurityWarning[];
  favorites: { profiles: Profile[]; sessions: Session[] };
  isEmpty: boolean;
}
```

All values derived from real stores — **no invented statistics**.

## Session Views (`src/ui-system/session-presenter.ts`)

Three display modes, switchable in toolbar:

1. **Compact list** — one-line rows, state dot, name, domain, actions
2. **Visual cards** — grid, state badge, metadata, action icons
3. **Advanced table** — sortable columns, pagination (50/page)

Common features:
- Filter by query, state, profile (including unassigned)
- Favorites-only toggle
- Real actions per state (pause/resume/archive/restore/delete)
- Keyboard accessible, ARIA labelled

## Global Search (`src/ui-system/search.ts`)

- Local, synchronous, no network
- Indexes: profile name/description/tags, session name/domain/state
- **Never searches**: cookies, tokens, passwords, vault entries
- Keyboard navigation (↑/↓, Enter, Esc)
- Result categories with badges
- Limit: 8 per category

## Notifications (`src/ui-system/notifications.ts`)

Categories: `sessions`, `profiles`, `security`, `system`

Channels:
- **In-app** — non-intrusive, stored in dashboard state
- **Browser** — `Notification` API, permission requested once via button

Policies:
- Per-category enable/disable
- Quiet hours (local time, may wrap midnight)
- Respects denied/default permission without re-prompting
- Deduplication window: 15s per event key

## Accessibility

- Full keyboard navigation (Tab, arrows, Enter, Esc)
- Visible focus indicators (`--agx-focus`)
- ARIA roles: `dialog`, `listbox`, `option`, `navigation`, `region`
- WCAG AA contrast for text/background in both themes
- Text scaling (100–130%) via root font-size
- Reduced motion via media query and preference
- Screen-reader labels on all icon buttons
- Focus trapping in modals, search palette, dropdowns

## Responsive Layout

| Breakpoint | Sidebar | Grid | Tables |
|------------|---------|------|--------|
| ≥ 1080px | Fixed 260px | 12-col | Full |
| 720–1080px | Collapsible drawer | 12-col | Scroll |
| < 720px | Off-canvas drawer | 1-col | Scroll |

No mobile framework — pure CSS Grid + Flexbox.

## Integration Points

```typescript
// Data bridge (src/ui/dashboard/data.ts)
interface DashboardData {
  ready: boolean;
  sessions: Session[];
  profiles: Profile[];
  activeProfileId: string | null;
  preferences: DashboardPreferences;
  refresh(): Promise<void>;
  createProfile(name: string, color?: string): Promise<Profile>;
  createSession(input: CreateSessionInput): Promise<Session>;
  setSessionState(id: string, state: SessionState): Promise<void>;
  deleteSession(id: string): Promise<void>;
  setActiveProfile(id: string | null): Promise<void>;
  archiveProfile(id: string): Promise<void>;
  restoreProfile(id: string): Promise<void>;
  updatePreferences(patch: Partial<DashboardPreferences>): Promise<void>;
}
```

- Uses `SessionManager`, `ProfileManager`, `ProfileNavigation` from Modules 02/03
- Storage via `browser.storage.local` through `StorageAreaLike`
- **No business logic in UI** — all validation/lifecycle in core modules

## Browser Limitations (Honest)

| Capability | Status | Notes |
|------------|--------|-------|
| Separate browser windows | ❌ | Panels rendered inside single tab/window |
| True process isolation | ❌ | Uses Chrome container tabs / cookie store IDs |
| Encrypted vault at rest | ⚠️ | Optional master/independent passwords (Module 03) |
| Cross-device sync | ❌ | Module 10 (explicit opt-in) |
| Native OS notifications | ⚠️ | Requires user permission; not all platforms support |
| Persistent background | ✅ | Service worker (MV3) |

## File Structure (Module 04)

```
src/
├── ui-system/              # Pure UI policy (no DOM, no chrome.*)
│   ├── index.ts
│   ├── theme.ts            # Tokens, contrast, CSS vars
│   ├── preferences.ts      # DashboardPreferences, load/save/normalize
│   ├── widgets.ts          # Layout items, catalog, manipulation
│   ├── navigation.ts       # Page IDs, modes, shortcuts
│   ├── search.ts           # Local search, keyboard nav
│   ├── session-presenter.ts # Filters, sorting, pagination, actions
│   ├── dashboard-data.ts   # Aggregation from real stores
│   ├── notifications.ts    # Policy, throttle, messages
│   └── *.test.ts           # Unit tests
│
├── ui/dashboard/           # Preact components
│   ├── main.tsx            # Dashboard host
│   ├── data.ts             # Hook: useDashboardData()
│   ├── DashboardTheme.tsx  # Applies tokens, scale, motion
│   ├── Shell.tsx           # Layout (sidebar + topbar + main)
│   ├── Home.tsx            # Dashboard page with widgets
│   ├── SessionsView.tsx    # Three session views
│   ├── Settings.tsx        # Preferences editor
│   ├── SearchPalette.tsx   # Global search (Cmd/Ctrl+K)
│   ├── Modal.tsx           # Accessible dialog
│   ├── Icons.tsx           # Inline SVG icons
│   └── dashboard.css       # Component styles
│
├── entrypoints/
│   └── dashboard/
│       └── index.html      # dashboard.html entry point
```

## Testing

Run all Module 04 tests:
```bash
npx pnpm@10.34.5 exec vitest run src/ui-system
```

Key coverage:
- Theme tokens & contrast
- Preference normalization & persistence
- Widget layout mutations
- Navigation modes & shortcuts
- Search ranking & keyboard
- Session filters/sorting/pagination
- Dashboard aggregation
- Notification policies
- M02/M03 regression (via existing test suites)

## Documentation

- `docs/ui-architecture.md` (this file)
- `docs/design-system.md` — token reference, component API
- `docs/theme-configuration.md` — theme tokens, customization
- `docs/widget-system.md` — widget catalog, layout persistence
- `docs/navigation-configuration.md` — modes, shortcuts, responsive
- `docs/accessibility.md` — keyboard, ARIA, contrast, scaling, motion
- `docs/responsive-behavior.md` — breakpoints, panel behavior
- `docs/limits.md` — browser limitations (appended)

## Completion Checklist (Module 04)

- [x] Light/dark/system themes with persistence
- [x] AEGOX restrained dark + violet identity
- [x] Sidebar / top / combined navigation
- [x] Dashboard with real data, empty/loading/error states
- [x] Three session views (compact/cards/table) with actions
- [x] Widget add/remove/reorder/resize/visibility/save/reset
- [x] Resizable/collapsible panels
- [x] Global search with keyboard nav
- [x] In-app + browser notifications with permission handling
- [x] Accessibility (keyboard, focus, ARIA, contrast, scaling, reduced motion)
- [x] Responsive layouts
- [x] Configurable animations
- [x] Reusable AEGOX design system
- [x] Efficient rendering (pagination, lazy search, no polling)
- [x] Clean UI/business/storage separation
- [x] Tests passing
- [x] Documentation updated

---

*Module 04 complete. Ready for review before Module 05 authorization.*