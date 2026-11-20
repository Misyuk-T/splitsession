/**
 * Profile Manager — Profile List UI (AEGOX_multisession).
 *
 * Dashboard-style list of profiles: state badge, folder, tags, duplicate
 * warning, quick actions and drag-and-drop ordering. It is presentational:
 * every mutation goes through the callbacks, which should call ProfileManager.
 *
 * Preact component, consistent with the existing SplitSession design system.
 *
 * Derived from SplitSession's container list pattern
 * (https://github.com/Misyuk-T/splitsession, MIT License).
 */

import { useMemo, useState } from "preact/hooks";

import { Button } from "./components/Button";
import { findDuplicateGroups } from "../profiles/profile-duplicate/duplicate-detector";
import type {
  Profile,
  ProfileFolder,
  ProfileId,
  ProfileState,
} from "../profiles/profile-manager/profile";

/** Props for the ProfileList component. */
export interface ProfileListProps {
  profiles: Profile[];
  folders?: ProfileFolder[];
  activeProfileId: ProfileId | null;
  onSwitch?: (id: ProfileId) => void;
  onEdit?: (id: ProfileId) => void;
  onArchive?: (id: ProfileId) => void;
  onRestore?: (id: ProfileId) => void;
  onDuplicate?: (id: ProfileId) => void;
  onRequestDelete?: (id: ProfileId) => void;
  /** Drag-and-drop ordering: move `id` before `beforeId` (null = to the end). */
  onMove?: (id: ProfileId, beforeId: ProfileId | null) => void;
  /** Called when the user asks to review a duplicate group. */
  onReviewDuplicates?: (profileIds: ProfileId[]) => void;
}

/** Human-readable label for a profile state. */
function stateLabel(state: ProfileState): string {
  switch (state) {
    case "active":
      return "Active";
    case "archived":
      return "Archived";
    case "temporary":
      return "Temporary";
    case "deleted":
      return "Deleted";
  }
}

/** Dot class for a profile state. */
function stateDotClass(state: ProfileState): string {
  switch (state) {
    case "active":
      return "fx-dot--green";
    case "temporary":
      return "fx-dot--yellow";
    case "archived":
    case "deleted":
      return "fx-dot--gray";
  }
}

/**
 * ProfileList: all profiles with state badges, tags, folders and actions.
 */
export const ProfileList = ({
  profiles,
  folders = [],
  activeProfileId,
  onSwitch,
  onEdit,
  onArchive,
  onRestore,
  onDuplicate,
  onRequestDelete,
  onMove,
  onReviewDuplicates,
}: ProfileListProps) => {
  const [dragging, setDragging] = useState<ProfileId | null>(null);
  const [dropTarget, setDropTarget] = useState<ProfileId | null>(null);

  const duplicateGroups = useMemo(() => findDuplicateGroups(profiles), [profiles]);
  const duplicateIds = useMemo(
    () => new Set(duplicateGroups.flatMap((group) => group.profiles.map((p) => p.id))),
    [duplicateGroups],
  );
  const folderNames = useMemo(
    () => new Map(folders.map((folder) => [folder.id, folder.name])),
    [folders],
  );
  const activeProfile = profiles.find((profile) => profile.id === activeProfileId);

  const handleDrop = (beforeId: ProfileId | null) => {
    const moving = dragging;
    setDragging(null);
    setDropTarget(null);
    if (moving && moving !== beforeId) onMove?.(moving, beforeId);
  };

  return (
    <section class="profile-list" aria-label="Profiles">
      <div class="profile-list__head">
        <h2 class="profile-list__title">Profiles</h2>
        <p class="profile-list__count fx-secondary">
          {profiles.length} profile{profiles.length === 1 ? "" : "s"}
        </p>
      </div>

      {activeProfile && (
        <p class="profile-list__active fx-secondary" role="status">
          Active profile: <strong>{activeProfile.metadata.name}</strong>
        </p>
      )}

      {duplicateGroups.length > 0 && (
        <div class="profile-list__notice fx-notice fx-notice--warn" role="alert">
          <p>
            {duplicateGroups.length} group
            {duplicateGroups.length === 1 ? "" : "s"} of profiles may be
            duplicates. Nothing was merged or deleted.
          </p>
          {onReviewDuplicates && (
            <Button
              variant="ghost"
              small
              onClick={() =>
                onReviewDuplicates(
                  duplicateGroups.flatMap((group) =>
                    group.profiles.map((profile) => profile.id),
                  ),
                )
              }
            >
              Review duplicates
            </Button>
          )}
        </div>
      )}

      <ul class="profile-list__rows">
        {profiles.map((profile) => {
          const isActive = profile.id === activeProfileId;
          const isDuplicate = duplicateIds.has(profile.id);
          return (
            <li
              key={profile.id}
              class={[
                "profile-list__row",
                isActive && "profile-list__row--active",
                dropTarget === profile.id && "profile-list__row--drop",
              ]
                .filter(Boolean)
                .join(" ")}
              draggable={Boolean(onMove)}
              onDragStart={(event) => {
                setDragging(profile.id);
                event.dataTransfer?.setData("text/plain", profile.id);
              }}
              onDragOver={(event) => {
                if (!onMove || dragging === null) return;
                event.preventDefault();
                setDropTarget(profile.id);
              }}
              onDragLeave={() => setDropTarget(null)}
              onDrop={(event) => {
                event.preventDefault();
                handleDrop(profile.id);
              }}
              onDragEnd={() => {
                setDragging(null);
                setDropTarget(null);
              }}
            >
              <div class="profile-list__main">
                <span
                  class={`profile-list__dot fx-dot ${stateDotClass(profile.state)}`}
                  aria-hidden="true"
                  style={
                    profile.metadata.color
                      ? { background: profile.metadata.color }
                      : undefined
                  }
                />
                <span class="profile-list__name">{profile.metadata.name}</span>
                <span class={`profile-list__state ${stateDotClass(profile.state)}`}>
                  {stateLabel(profile.state)}
                </span>
                {isActive && (
                  <span class="profile-list__badge" aria-label="Active profile">
                    Active
                  </span>
                )}
                {isDuplicate && (
                  <span
                    class="profile-list__duplicate"
                    title="Potential duplicate. Nothing was changed automatically."
                  >
                    Possible duplicate
                  </span>
                )}
                {profile.folderId && (
                  <span class="profile-list__folder">
                    {folderNames.get(profile.folderId) ?? profile.folderId}
                  </span>
                )}
                {profile.metadata.description && (
                  <span class="profile-list__desc">
                    {profile.metadata.description}
                  </span>
                )}
                {profile.tags.length > 0 && (
                  <span class="profile-list__tags">
                    {profile.tags.map((tag) => (
                      <span key={tag} class="profile-list__tag">
                        {tag}
                      </span>
                    ))}
                  </span>
                )}
                {profile.hasIndependentPassword && (
                  <span class="profile-list__protected" title="Password protected">
                    Protected
                  </span>
                )}
              </div>

              <div class="profile-list__actions">
                {(profile.state === "active" || profile.state === "temporary") &&
                  onSwitch && (
                    <Button
                      variant={isActive ? "primary" : "ghost"}
                      small
                      onClick={() => onSwitch(profile.id)}
                      aria-label={`Switch to “${profile.metadata.name}”`}
                      disabled={isActive}
                    >
                      {isActive ? "Current" : "Switch"}
                    </Button>
                  )}
                {onEdit && (
                  <Button
                    variant="ghost"
                    small
                    onClick={() => onEdit(profile.id)}
                    aria-label={`Edit “${profile.metadata.name}”`}
                  >
                    Edit
                  </Button>
                )}
                {onDuplicate && (
                  <Button
                    variant="ghost"
                    small
                    onClick={() => onDuplicate(profile.id)}
                    aria-label={`Duplicate “${profile.metadata.name}”`}
                  >
                    Duplicate
                  </Button>
                )}
                {profile.state === "archived" || profile.state === "deleted"
                  ? onRestore && (
                      <Button
                        variant="ghost"
                        small
                        onClick={() => onRestore(profile.id)}
                        aria-label={`Restore “${profile.metadata.name}”`}
                      >
                        Restore
                      </Button>
                    )
                  : onArchive && (
                      <Button
                        variant="ghost"
                        small
                        onClick={() => onArchive(profile.id)}
                        aria-label={`Archive “${profile.metadata.name}”`}
                      >
                        Archive
                      </Button>
                    )}
                {onRequestDelete && (
                  <Button
                    variant="ghost"
                    small
                    onClick={() => onRequestDelete(profile.id)}
                    aria-label={`Delete “${profile.metadata.name}”`}
                  >
                    Delete
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {profiles.length === 0 && (
        <p class="profile-list__empty fx-secondary">
          No profiles yet. Create your first profile to organize sessions.
        </p>
      )}
    </section>
  );
};
