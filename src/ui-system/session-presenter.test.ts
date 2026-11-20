import { describe, expect, it } from "vitest";

import type { Session, SessionState } from "../core/session-manager/session";
import {
  buildSessionRow,
  filterSessions,
  formatTimestamp,
  paginate,
  sessionActions,
  sortSessions,
  statePresentation,
} from "./session-presenter";

const session = (
  id: string,
  state: SessionState = "active",
  overrides: Partial<Session["metadata"]> = {},
): Session => ({
  id,
  state,
  metadata: {
    name: `Session ${id}`,
    domain: "example.com",
    profileId: "profile-a",
    createdAt: 1000,
    lastUsedAt: 2000,
    persistent: true,
    restorable: true,
    ...overrides,
  },
});

describe("state presentation", () => {
  it("labels every lifecycle state once", () => {
    const states: SessionState[] = ["active", "paused", "expired", "archived", "closed"];
    expect(states.map((state) => statePresentation(state).label)).toEqual([
      "Active",
      "Paused",
      "Expired",
      "Archived",
      "Closed",
    ]);
    expect(new Set(states.map((state) => statePresentation(state).description)).size).toBe(5);
  });
});

describe("session actions", () => {
  const availability = (state: SessionState) =>
    Object.fromEntries(sessionActions(session("id", state)).map((action) => [action.id, action.available]));

  it("offers pause for active sessions and resume for paused ones", () => {
    expect(availability("active")).toMatchObject({ open: true, pause: true, resume: false, archive: true, delete: true });
    expect(availability("paused")).toMatchObject({ pause: false, resume: true, archive: true });
  });

  it("requires restoring expired sessions before opening", () => {
    expect(availability("expired")).toMatchObject({
      open: false,
      resume: true,
      restore: true,
      archive: true,
    });
    expect(sessionActions(session("id", "expired")).find((action) => action.id === "open")?.reason).toContain(
      "Restore",
    );
  });

  it("keeps closed sessions terminal", () => {
    expect(availability("closed")).toMatchObject({
      open: false,
      pause: false,
      resume: false,
      archive: false,
      delete: false,
    });
  });

  it("marks delete as a dangerous action", () => {
    expect(sessionActions(session("id")).find((action) => action.id === "delete")?.danger).toBe(true);
  });
});

describe("filters and sorting", () => {
  const sessions = [
    session("1", "active", { name: "Alpha", domain: "alpha.com", profileId: "p1", lastUsedAt: 300 }),
    session("2", "paused", { name: "Beta", domain: "beta.com", profileId: "p2", lastUsedAt: null }),
    session("3", "archived", { name: "Gamma", domain: "gamma.com", profileId: "p1", lastUsedAt: 100 }),
    session("4", "active", { name: "Delta", domain: null, profileId: null, lastUsedAt: 400 }),
  ];

  it("filters by state", () => {
    expect(filterSessions(sessions, { state: "active" }).map((s) => s.id)).toEqual(["1", "4"]);
    expect(filterSessions(sessions, { state: "all" })).toHaveLength(4);
  });

  it("filters by profile and unassigned", () => {
    expect(filterSessions(sessions, { profileId: "p1" }).map((s) => s.id)).toEqual(["1", "3"]);
    expect(filterSessions(sessions, { profileId: "unassigned" }).map((s) => s.id)).toEqual(["4"]);
  });

  it("filters by text and favorites", () => {
    expect(filterSessions(sessions, { query: "beta" }).map((s) => s.id)).toEqual(["2"]);
    expect(filterSessions(sessions, { query: "GAMMA.COM" }).map((s) => s.id)).toEqual(["3"]);
    expect(filterSessions(sessions, { onlyFavorites: true, favoriteIds: ["2"] }).map((s) => s.id)).toEqual(["2"]);
  });

  it("combines filters", () => {
    expect(
      filterSessions(sessions, { state: "active", profileId: "p1", query: "alpha" }).map((s) => s.id),
    ).toEqual(["1"]);
  });

  it("sorts by real fields in both directions", () => {
    expect(sortSessions(sessions, "name", "asc").map((s) => s.id)).toEqual(["1", "2", "4", "3"]);
    expect(sortSessions(sessions, "lastUsedAt", "desc").map((s) => s.id)).toEqual(["4", "1", "3", "2"]);
    expect(sortSessions(sessions, "lastUsedAt", "asc").map((s) => s.id)).toEqual(["2", "3", "1", "4"]);
    expect(sortSessions(sessions, "state", "asc").map((s) => s.id)).toEqual(["1", "4", "3", "2"]);
  });

  it("does not mutate the input", () => {
    const before = sessions.map((s) => s.id);
    sortSessions(sessions, "name", "asc");
    filterSessions(sessions, { state: "active" });
    expect(sessions.map((s) => s.id)).toEqual(before);
  });
});

describe("pagination", () => {
  const items = Array.from({ length: 105 }, (_, index) => index);

  it("paginates large collections", () => {
    const first = paginate(items, 0, 50);
    expect(first.items).toHaveLength(50);
    expect(first.pageCount).toBe(3);
    expect(first.total).toBe(105);

    const last = paginate(items, 99, 50);
    expect(last.page).toBe(2);
    expect(last.items).toHaveLength(5);
  });

  it("clamps invalid pages and sizes", () => {
    expect(paginate(items, -3, 50).page).toBe(0);
    expect(paginate(items, 10, 50).page).toBe(2);
    expect(paginate(items, 0, 0).pageSize).toBe(1);
    expect(paginate([], 0, 50)).toMatchObject({ page: 0, pageCount: 1, items: [] });
  });
});

describe("row building", () => {
  it("uses real timestamps and profile names", () => {
    const row = buildSessionRow(session("1"), "Work");
    expect(row.profileName).toBe("Work");
    expect(row.createdLabel).not.toBe("");
    expect(row.lastUsedLabel).not.toBe("");
    expect(row.actions.length).toBeGreaterThan(0);
  });

  it("formats missing timestamps honestly", () => {
    expect(formatTimestamp(null)).toBe("Never");
    expect(formatTimestamp(Number.NaN)).toBe("Never");
  });
});
