/**
 * Unit tests for `src/core/session-lifecycle/lifecycle.ts`.
 * Pure TypeScript: no browser APIs required.
 */

import { describe, expect, it } from "vitest";

import {
  attemptTransition,
  isValidTransition,
  allowedNextStates,
  isActive,
  isPaused,
  isExpired,
  isArchived,
  isClosed,
  isTerminal,
  evaluatePause,
  evaluateResume,
} from "./lifecycle";
import { createSession } from "../session-manager/session";

describe("isValidTransition", () => {
  it("allows active -> paused, expired, archived, closed", () => {
    expect(isValidTransition("active", "paused")).toBe(true);
    expect(isValidTransition("active", "expired")).toBe(true);
    expect(isValidTransition("active", "archived")).toBe(true);
    expect(isValidTransition("active", "closed")).toBe(true);
  });

  it("allows paused -> active, expired, archived, closed", () => {
    expect(isValidTransition("paused", "active")).toBe(true);
    expect(isValidTransition("paused", "expired")).toBe(true);
    expect(isValidTransition("paused", "archived")).toBe(true);
    expect(isValidTransition("paused", "closed")).toBe(true);
  });

  it("allows expired -> active, archived, closed", () => {
    expect(isValidTransition("expired", "active")).toBe(true);
    expect(isValidTransition("expired", "archived")).toBe(true);
    expect(isValidTransition("expired", "closed")).toBe(true);
  });

  it("allows archived -> active, closed", () => {
    expect(isValidTransition("archived", "active")).toBe(true);
    expect(isValidTransition("archived", "closed")).toBe(true);
  });

  it("does not allow transitions from closed (terminal)", () => {
    expect(isValidTransition("closed", "active")).toBe(false);
    expect(isValidTransition("closed", "paused")).toBe(false);
    expect(isValidTransition("closed", "closed")).toBe(false);
  });

  it("does not allow invalid transitions", () => {
    expect(isValidTransition("active", "active")).toBe(false); // same state not a transition
    expect(isValidTransition("paused", "paused")).toBe(false);
    expect(isValidTransition("archived", "expired")).toBe(false);
  });
});

describe("attemptTransition", () => {
  const session = createSession({
    name: "Test",
    domain: null,
    profileId: "default",
    createdAt: 1000,
    lastUsedAt: null,
    persistent: true,
    restorable: true,
  });

  it("returns success for valid transition", () => {
    const result = attemptTransition(session, "paused");
    expect(result.ok).toBe(true);
    expect(result.session?.state).toBe("paused");
    expect(result.session?.id).toBe(session.id);
  });

  it("returns failure for invalid transition", () => {
    const closed = { ...session, state: "closed" as const };
    const result = attemptTransition(closed, "active");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Cannot transition");
  });

  it("returns success for same state", () => {
    const result = attemptTransition(session, "active");
    expect(result.ok).toBe(true);
    expect(result.session?.state).toBe("active");
  });

  it("does not mutate the original session", () => {
    attemptTransition(session, "paused");
    expect(session.state).toBe("active");
  });
});

describe("allowedNextStates", () => {
  it("returns the correct next states for active", () => {
    expect(allowedNextStates("active")).toContain("paused");
    expect(allowedNextStates("active")).toContain("closed");
    expect(allowedNextStates("active")).not.toContain("active");
  });

  it("returns empty array for closed", () => {
    expect(allowedNextStates("closed")).toEqual([]);
  });
});

describe("state checkers", () => {
  it("isActive / isPaused / isExpired / isArchived / isClosed", () => {
    expect(isActive("active")).toBe(true);
    expect(isPaused("paused")).toBe(true);
    expect(isExpired("expired")).toBe(true);
    expect(isArchived("archived")).toBe(true);
    expect(isClosed("closed")).toBe(true);

    expect(isActive("paused")).toBe(false);
    expect(isPaused("active")).toBe(false);
    expect(isClosed("active")).toBe(false);
  });

  it("isTerminal only for closed", () => {
    expect(isTerminal("closed")).toBe(true);
    expect(isTerminal("active")).toBe(false);
    expect(isTerminal("paused")).toBe(false);
  });
});

describe("evaluatePause", () => {
  const session = createSession({
    name: "Test",
    domain: null,
    profileId: "default",
    createdAt: 1000,
    lastUsedAt: null,
    persistent: true,
    restorable: true,
  });

  it("allows pausing an active session", () => {
    expect(evaluatePause(session).canPause).toBe(true);
  });

  it("rejects pausing an already paused session", () => {
    const paused = { ...session, state: "paused" as const };
    expect(evaluatePause(paused).canPause).toBe(false);
  });

  it("rejects pausing a closed session", () => {
    const closed = { ...session, state: "closed" as const };
    expect(evaluatePause(closed).canPause).toBe(false);
    expect(evaluatePause(closed).reason).toContain("closed");
  });
});

describe("evaluateResume", () => {
  const session = createSession({
    name: "Test",
    domain: null,
    profileId: "default",
    createdAt: 1000,
    lastUsedAt: null,
    persistent: true,
    restorable: true,
  });

  it("allows resuming a paused session", () => {
    const paused = { ...session, state: "paused" as const };
    expect(evaluateResume(paused).canPause).toBe(true);
  });

  it("allows resuming an expired session", () => {
    const expired = { ...session, state: "expired" as const };
    expect(evaluateResume(expired).canPause).toBe(true);
  });

  it("allows resuming an archived session", () => {
    const archived = { ...session, state: "archived" as const };
    expect(evaluateResume(archived).canPause).toBe(true);
  });

  it("rejects resuming an active session", () => {
    expect(evaluateResume(session).canPause).toBe(false);
  });

  it("rejects resuming a closed session", () => {
    const closed = { ...session, state: "closed" as const };
    expect(evaluateResume(closed).canPause).toBe(false);
  });
});
