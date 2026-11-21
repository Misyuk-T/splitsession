/**
 * Session presentation model (AEGOX_multisession, Module 04).
 *
 * Converts Session Core entities into labels, action availability, sorting and
 * pagination. This is UI policy only; lifecycle transitions stay in Module 02.
 */

import type { Session, SessionState } from "../core/session-manager/session";
import { isValidTransition } from "../core/session-lifecycle/lifecycle";

export type SessionTone = "active" | "paused" | "expired" | "archived" | "closed";
export type SessionSortField = "name" | "createdAt" | "lastUsedAt" | "state" | "domain";
export type SortDirection = "asc" | "desc";

export interface StatePresentation {
  state: SessionState;
  label: string;
  tone: SessionTone;
  /** Honest description of what the state means. */
  description: string;
}

const STATES: Readonly<Record<SessionState, StatePresentation>> = {
  active: {
    state: "active",
    label: "Active",
    tone: "active",
    description: "Running and usable.",
  },
  paused: {
    state: "paused",
    label: "Paused",
    tone: "paused",
    description: "Suspended; resume it to use the session again.",
  },
  expired: {
    state: "expired",
    label: "Expired",
    tone: "expired",
    description: "The session expired and needs attention before use.",
  },
  archived: {
    state: "archived",
    label: "Archived",
    tone: "archived",
    description: "Kept out of the way but not deleted.",
  },
  closed: {
    state: "closed",
    label: "Closed",
    tone: "closed",
    description: "Closed permanently; this state cannot be changed.",
  },
};

export type SessionActionId =
  | "open"
  | "pause"
  | "resume"
  | "archive"
  | "restore"
  | "delete";

export interface SessionAction {
  id: SessionActionId;
  label: string;
  /** True when Session Core allows the transition. */
  available: boolean;
  /** Why an action is unavailable, when it is. */
  reason: string | null;
  danger: boolean;
}

/** Display data for one session, independent of the chosen view format. */
export interface SessionRow {
  session: Session;
  state: StatePresentation;
  profileName: string | null;
  createdLabel: string;
  lastUsedLabel: string;
  actions: SessionAction[];
}

export function statePresentation(state: SessionState): StatePresentation {
  return STATES[state];
}

function can(state: SessionState, target: SessionState): boolean {
  return isValidTransition(state, target);
}

/** Actions offered for a session state, with honest availability. */
export function sessionActions(session: Session): SessionAction[] {
  const state = session.state;
  const closed = state === "closed";
  return [
    {
      id: "open",
      label: "Open",
      available: !closed && state !== "expired",
      reason: closed
        ? "Closed sessions cannot be opened."
        : state === "expired"
          ? "Restore the session before opening it."
          : null,
      danger: false,
    },
    {
      id: "pause",
      label: "Pause",
      available: can(state, "paused"),
      reason: can(state, "paused") ? null : "Only active or expired sessions can be paused.",
      danger: false,
    },
    {
      id: "resume",
      label: "Resume",
      available: can(state, "active") && state !== "active",
      reason: can(state, "active") && state !== "active" ? null : "This session is already active.",
      danger: false,
    },
    {
      id: "archive",
      label: "Archive",
      available: can(state, "archived"),
      reason: can(state, "archived") ? null : "This session cannot be archived.",
      danger: false,
    },
    {
      id: "restore",
      label: "Restore",
      available: state === "archived" || state === "expired",
      reason:
        state === "archived" || state === "expired"
          ? null
          : "Only archived or expired sessions need restoring.",
      danger: false,
    },
    {
      id: "delete",
      label: "Delete",
      available: !closed,
      reason: closed ? "Closed sessions are already final." : null,
      danger: true,
    },
  ];
}

export function formatTimestamp(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "Never";
  return new Date(value).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Builds a row for a session. `now` is accepted for future relative labels. */
export function buildSessionRow(
  session: Session,
  profileName: string | null,
): SessionRow {
  return {
    session,
    state: statePresentation(session.state),
    profileName,
    createdLabel: formatTimestamp(session.metadata.createdAt),
    lastUsedLabel: formatTimestamp(session.metadata.lastUsedAt),
    actions: sessionActions(session),
  };
}

export interface SessionFilter {
  query?: string;
  state?: SessionState | "all";
  profileId?: string | "all" | "unassigned";
  onlyFavorites?: boolean;
  favoriteIds?: readonly string[];
}

/** Applies filters locally. No session data leaves the browser. */
export function filterSessions(
  sessions: ReadonlyArray<Session>,
  filter: SessionFilter = {},
): Session[] {
  const query = filter.query?.trim().toLowerCase() ?? "";
  return sessions.filter((session) => {
    if (filter.state && filter.state !== "all" && session.state !== filter.state) return false;
    const profileId = session.metadata.profileId;
    if (filter.profileId === "unassigned" && profileId !== null) return false;
    if (
      filter.profileId &&
      filter.profileId !== "all" &&
      filter.profileId !== "unassigned" &&
      profileId !== filter.profileId
    ) {
      return false;
    }
    if (filter.onlyFavorites) {
      const ids = filter.favoriteIds ?? [];
      if (!ids.includes(session.id)) return false;
    }
    if (query) {
      const haystack = [session.metadata.name, session.metadata.domain, session.state]
        .filter((part): part is string => Boolean(part))
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

function compare(a: Session, b: Session, field: SessionSortField): number {
  switch (field) {
    case "name":
      return a.metadata.name.localeCompare(b.metadata.name);
    case "domain":
      return (a.metadata.domain ?? "").localeCompare(b.metadata.domain ?? "");
    case "state":
      return a.state.localeCompare(b.state);
    case "createdAt":
      return a.metadata.createdAt - b.metadata.createdAt;
    case "lastUsedAt":
      return (a.metadata.lastUsedAt ?? 0) - (b.metadata.lastUsedAt ?? 0);
  }
}

/** Stable sorting by a real field. Ties fall back to name. */
export function sortSessions(
  sessions: ReadonlyArray<Session>,
  field: SessionSortField = "lastUsedAt",
  direction: SortDirection = "desc",
): Session[] {
  const factor = direction === "asc" ? 1 : -1;
  return sessions
    .slice()
    .sort((a, b) => factor * compare(a, b, field) || a.metadata.name.localeCompare(b.metadata.name));
}

export interface Page<T> {
  items: T[];
  page: number;
  pageCount: number;
  total: number;
  pageSize: number;
}

/** Pages a list without mutating it. Page numbering is zero-based. */
export function paginate<T>(items: ReadonlyArray<T>, page: number, pageSize: number): Page<T> {
  const size = Math.max(1, Math.floor(pageSize));
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / size));
  const safePage = Math.min(pageCount - 1, Math.max(0, Math.floor(page)));
  return {
    items: items.slice(safePage * size, safePage * size + size),
    page: safePage,
    pageCount,
    total,
    pageSize: size,
  };
}

/** Default page size for large session collections. */
export const SESSION_PAGE_SIZE = 50;

/** Returns the color token to use for a session state dot. */
export function stateColorToken(state: SessionState): string {
  return {
    active: "var(--agx-ok)",
    paused: "var(--agx-warning)",
    expired: "var(--agx-danger)",
    archived: "var(--agx-muted)",
    closed: "var(--agx-muted)",
  }[state];
}

/** Returns whether a session can be opened given its state. */
export function canOpen(session: Session): boolean {
  return session.state !== "closed" && session.state !== "expired";
}

/** Returns whether a session can be deleted given its state. */
export function canDelete(session: Session): boolean {
  return session.state !== "closed";
}
