/**
 * Session Core — Session List UI (AEGOX_multisession).
 *
 * Preact component displaying sessions with their states and indicators.
 * Keyboard accessible, consistent with the existing SplitSession UI design system.
 *
 * Derived from SplitSession's popup container list pattern
 * (https://github.com/Misyuk-T/splitsession, MIT License).
 */

import { useState } from "preact/hooks";
import { Button } from "./components/Button";

import type { Session, SessionState } from "../core/session-manager/session";
import { isActive, isPaused, isExpired, isArchived, isClosed } from "../core/session-lifecycle/lifecycle";

/** Props for the SessionList component. */
export interface SessionListProps {
  sessions: Session[];
  onPause?: (id: string) => void;
  onResume?: (id: string) => void;
  onArchive?: (id: string) => void;
  onDelete?: (id: string) => void;
  onRestore?: () => void;
}

/** Human-readable label for a session state. */
function stateLabel(state: SessionState): string {
  switch (state) {
    case "active": return "Active";
    case "paused": return "Paused";
    case "expired": return "Expired";
    case "archived": return "Archived";
    case "closed": return "Closed";
  }
}

/** Color indicator class for a session state. */
function stateColorClass(state: SessionState): string {
  switch (state) {
    case "active": return "fx-dot--green";
    case "paused": return "fx-dot--yellow";
    case "expired": return "fx-dot--red";
    case "archived": return "fx-dot--gray";
    case "closed": return "fx-dot--gray";
  }
}

/**
 * SessionList: shows all sessions with state badges and actions.
 * Follows the existing SplitSession component conventions (ARIA roles, keyboard accessible).
 */
export const SessionList = ({
  sessions,
  onPause,
  onResume,
  onArchive,
  onDelete,
  onRestore,
}: SessionListProps) => {
  const [deleting, setDeleting] = useState<string | null>(null);

  const activeSessions = sessions.filter((s) => isActive(s.state));
  const pausedSessions = sessions.filter((s) => isPaused(s.state));
  const expiredSessions = sessions.filter((s) => isExpired(s.state));

  return (
    <section class="session-list" aria-label="Sessions">
      <h2 class="session-list__title">Sessions</h2>

      <p class="session-list__count">
        {sessions.length} session{sessions.length !== 1 ? "s" : ""} total
      </p>

      {expiredSessions.length > 0 && (
        <p class="session-list__notice fx-notice fx-notice--warning" role="alert">
          {expiredSessions.length} session{expiredSessions.length !== 1 ? "s" : ""} require attention (expired).
        </p>
      )}

      {onRestore && (
        <Button variant="secondary" onClick={onRestore}>
          Restore Sessions
        </Button>
      )}

      <ul class="session-list__rows">
        {sessions.map((session) => (
          <li key={session.id} class="session-list__row">
            <div class="session-list__main">
              <span
                class={`session-list__dot ${stateColorClass(session.state)}`}
                aria-hidden="true"
              />
              <span class="session-list__name">{session.metadata.name}</span>
              <span class="session-list__state">{stateLabel(session.state)}</span>
              {session.metadata.domain && (
                <span class="session-list__domain">{session.metadata.domain}</span>
              )}
            </div>

            <div class="session-list__actions">
              {isActive(session.state) && onPause && (
                <Button
                  variant="ghost"
                  small
                  onClick={() => onPause(session.id)}
                  aria-label={`Pause “${session.metadata.name}”`}
                >
                  Pause
                </Button>
              )}
              {isPaused(session.state) && onResume && (
                <Button
                  variant="ghost"
                  small
                  onClick={() => onResume(session.id)}
                  aria-label={`Resume “${session.metadata.name}”`}
                >
                  Resume
                </Button>
              )}
              {!isClosed(session.state) && onArchive && (
                <Button
                  variant="ghost"
                  small
                  onClick={() => onArchive(session.id)}
                  aria-label={`Archive “${session.metadata.name}”`}
                >
                  Archive
                </Button>
              )}
              {deleting === session.id ? (
                <div class="session-list__confirm">
                  <Button
                    variant="danger"
                    small
                    onClick={() => {
                      onDelete?.(session.id);
                      setDeleting(null);
                    }}
                  >
                    Delete
                  </Button>
                  <Button
                    variant="ghost"
                    small
                    onClick={() => setDeleting(null)}
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button
                  variant="ghost"
                  small
                  onClick={() => setDeleting(session.id)}
                  aria-label={`Delete “${session.metadata.name}”`}
                >
                  Delete
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>

      {sessions.length === 0 && (
        <p class="session-list__empty fx-secondary">
          No sessions yet. Create your first session to start isolating accounts.
        </p>
      )}
    </section>
  );
};
