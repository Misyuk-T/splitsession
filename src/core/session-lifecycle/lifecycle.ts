/**
 * Session Core — Session Lifecycle (AEGOX_multisession).
 *
 * Defines valid state transitions and rules for pausing, resuming, expiring,
 * archiving, and closing sessions.
 *
 * Pure TypeScript: no `chrome.*` references.
 *
 * Derived from SplitSession's isolation patterns
 * (https://github.com/Misyuk-T/splitsession, MIT License).
 */

import type { Session, SessionId, SessionState } from "../session-manager/session";

/** All valid session states. */
export type LifecycleState = SessionState;

/** A transition rule: from state -> allowed target states. */
const ALLOWED_TRANSITIONS: Record<SessionState, SessionState[]> = {
  active: ["paused", "expired", "archived", "closed"],
  paused: ["active", "expired", "archived", "closed"],
  expired: ["active", "archived", "closed"],
  archived: ["active", "closed"],
  closed: [], // closed is terminal: cannot transition out
};

/** Result of a state transition attempt. */
export interface TransitionResult {
  /** True if the transition was allowed and applied. */
  ok: boolean;
  /** The session after transition (copy), or undefined if not allowed. */
  session?: Session;
  /** Human-readable reason when the transition is not allowed. */
  reason?: string;
}

/** Validates whether a transition from `from` to `to` is permitted. */
export function isValidTransition(
  from: SessionState,
  to: SessionState,
): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Returns all states that can follow the given state. */
export function allowedNextStates(from: SessionState): SessionState[] {
  return [...(ALLOWED_TRANSITIONS[from] ?? [])];
}

/**
 * Attempts to transition a session to a new state.
 * Returns a result describing success or failure without mutating the session.
 */
export function attemptTransition(
  session: Session,
  target: SessionState,
): TransitionResult {
  if (session.state === target) {
    return { ok: true, session: { ...session } };
  }
  if (!isValidTransition(session.state, target)) {
    return {
      ok: false,
      reason: `Cannot transition session "${session.id}" from "${session.state}" to "${target}".`,
    };
  }
  return { ok: true, session: { ...session, state: target } };
}

/** Checks if a session is in a terminal state (closed). */
export function isTerminal(state: SessionState): boolean {
  return state === "closed";
}

/** Checks if a session is currently usable (active). */
export function isActive(state: SessionState): boolean {
  return state === "active";
}

/** Checks if a session is paused (suspended but data preserved). */
export function isPaused(state: SessionState): boolean {
  return state === "paused";
}

/** Checks if a session is expired (authentication may no longer be valid). */
export function isExpired(state: SessionState): boolean {
  return state === "expired";
}

/** Checks if a session is archived (inactive, not auto-restored). */
export function isArchived(state: SessionState): boolean {
  return state === "archived";
}

/** Checks if a session is closed (terminal). */
export function isClosed(state: SessionState): boolean {
  return state === "closed";
}

/**
 * Pausing rules:
 * - Pausing must not destroy persistent authentication state.
 * - A paused session can be resumed to active.
 * - Pausing is not the same as logging out.
 */
export interface PauseRules {
  /** Whether pausing is allowed for this session. */
  canPause: boolean;
  /** Reason if pausing is not allowed. */
  reason?: string;
}

/** Evaluates whether a session can be paused. */
export function evaluatePause(session: Session): PauseRules {
  if (isClosed(session.state)) {
    return { canPause: false, reason: "Cannot pause a closed session." };
  }
  if (isPaused(session.state)) {
    return { canPause: false, reason: "Session is already paused." };
  }
  return { canPause: true };
}

/** Evaluates whether a session can be resumed (paused -> active). */
export function evaluateResume(session: Session): PauseRules {
  if (isClosed(session.state)) {
    return { canPause: false, reason: "Cannot resume a closed session." };
  }
  if (isActive(session.state)) {
    return { canPause: false, reason: "Session is already active." };
  }
  if (isPaused(session.state) || isExpired(session.state) || isArchived(session.state)) {
    return { canPause: true };
  }
  return { canPause: false, reason: "Cannot resume from current state." };
}
