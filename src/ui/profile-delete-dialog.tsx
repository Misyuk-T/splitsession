/**
 * Profile Manager — Delete Profile Dialog (AEGOX_multisession).
 *
 * Deleting a profile requires an explicit decision about its sessions:
 * keep them, detach them, move them to another profile, or delete them. The
 * last option needs a second confirmation inside the same dialog, and the
 * confirm button stays disabled until the user has chosen something.
 *
 * The component never calls Session Core directly: it reports the chosen
 * `SessionDisposition` and the caller runs `deleteProfileWithSessions`, which
 * validates the request again before changing anything.
 *
 * Preact component, consistent with the existing SplitSession design system.
 *
 * Derived from SplitSession's delete-confirmation pattern
 * (https://github.com/Misyuk-T/splitsession, MIT License).
 */

import { useState } from "preact/hooks";

import { Button } from "./components/Button";
import type { DeletionImpact, SessionDisposition } from "../profiles/profile-lifecycle/deletion";
import type { Profile, ProfileId } from "../profiles/profile-manager/profile";

/** Props for the ProfileDeleteDialog component. */
export interface ProfileDeleteDialogProps {
  /** What will be affected; built with `describeDeletionImpact`. */
  impact: DeletionImpact;
  /** Profiles that can receive the sessions (excluding the deleted one). */
  targets?: Profile[];
  onCancel: () => void;
  onConfirm: (disposition: SessionDisposition) => void;
  busy?: boolean;
  /** Error shown after a failed deletion attempt. */
  error?: string;
}

type Choice = "keep" | "reassign" | "delete";

/**
 * ProfileDeleteDialog: the mandatory session-disposition step.
 */
export const ProfileDeleteDialog = ({
  impact,
  targets = [],
  onCancel,
  onConfirm,
  busy = false,
  error,
}: ProfileDeleteDialogProps) => {
  const [choice, setChoice] = useState<Choice | null>(null);
  const [targetId, setTargetId] = useState<ProfileId | "">("");
  const [deleteConfirmed, setDeleteConfirmed] = useState(false);

  const recipients = targets.filter(
    (profile) =>
      profile.id !== impact.profileId &&
      (profile.state === "active" || profile.state === "temporary"),
  );

  const canConfirm =
    !busy &&
    (choice === "keep" ||
      (choice === "reassign" && targetId !== "") ||
      (choice === "delete" && deleteConfirmed));

  const confirm = () => {
    if (!canConfirm) return;
    switch (choice) {
      case "keep":
        onConfirm({ action: "keep" });
        break;
      case "reassign":
        if (targetId !== "") onConfirm({ action: "reassign", toProfileId: targetId });
        break;
      case "delete":
        onConfirm({ action: "delete", confirmed: true });
        break;
      default:
        break;
    }
  };

  return (
    <div
      class="fx-dialog profile-delete"
      role="dialog"
      aria-modal="true"
      aria-labelledby="profile-delete-title"
    >
      <h2 class="fx-dialog__title" id="profile-delete-title">
        Delete “{impact.profileName}”?
      </h2>

      <div class="fx-dialog__body">
        <p>
          This profile has{" "}
          <strong>
            {impact.sessionCount} session{impact.sessionCount === 1 ? "" : "s"}
          </strong>
          . Choose what happens to them; nothing is deleted until you confirm.
        </p>

        {impact.sessionCount > 0 && (
          <ul class="profile-delete__sessions">
            {impact.sessions.map((session) => (
              <li key={session.id}>
                {session.name}
                {session.domain ? ` — ${session.domain}` : ""}
              </li>
            ))}
          </ul>
        )}

        <fieldset class="profile-delete__choices">
          <legend>What should happen to these sessions?</legend>

          <label class="profile-delete__choice">
            <input
              type="radio"
              name="profile-delete-disposition"
              checked={choice === "keep"}
              onChange={() => setChoice("keep")}
            />
            Keep them; they stay in Session Core and move to the default
            profile.
          </label>

          <label class="profile-delete__choice">
            <input
              type="radio"
              name="profile-delete-disposition"
              checked={choice === "reassign"}
              onChange={() => setChoice("reassign")}
              disabled={recipients.length === 0}
            />
            Move them to another profile:
            <select
              class="fx-input profile-delete__select"
              value={targetId}
              disabled={choice !== "reassign" || recipients.length === 0}
              onChange={(event) =>
                setTargetId((event.currentTarget as HTMLSelectElement).value)
              }
              aria-label="Profile that receives the sessions"
            >
              <option value="">Choose a profile…</option>
              {recipients.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.metadata.name}
                </option>
              ))}
            </select>
          </label>

          <label class="profile-delete__choice profile-delete__choice--danger">
            <input
              type="radio"
              name="profile-delete-disposition"
              checked={choice === "delete"}
              onChange={() => setChoice("delete")}
            />
            Delete these sessions permanently.
          </label>
        </fieldset>

        {choice === "delete" && (
          <div class="fx-notice fx-notice--error" role="alert">
            <p>
              This permanently deletes {impact.sessionCount} session
              {impact.sessionCount === 1 ? "" : "s"}, including their saved
              state. This cannot be undone.
            </p>
            <label class="profile-delete__choice">
              <input
                type="checkbox"
                checked={deleteConfirmed}
                onChange={(event) =>
                  setDeleteConfirmed(
                    (event.currentTarget as HTMLInputElement).checked,
                  )
                }
              />
              Yes, delete these sessions as well.
            </label>
          </div>
        )}

        {impact.hasIndependentPassword && (
          <p class="fx-notice fx-notice--info">
            This profile has its own password. Deleting it does not ask for that
            password again, but the encrypted data associated with it is not
            touched by this dialog.
          </p>
        )}

        {error && (
          <p class="fx-notice fx-notice--error" role="alert">
            {error}
          </p>
        )}
      </div>

      <div class="fx-dialog__actions">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="danger"
          onClick={confirm}
          disabled={!canConfirm}
          aria-label={`Delete profile “${impact.profileName}”`}
        >
          Delete profile
        </Button>
      </div>
    </div>
  );
};
