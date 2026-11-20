/**
 * Profile Manager — Profile Switcher UI (AEGOX_multisession).
 *
 * Compact profile list for the extension popup: the active profile first,
 * a lock badge for protected profiles, and a one-click switch. It is
 * presentational; the caller performs the switch through `ProfileNavigation`
 * and handles protection before revealing a protected profile.
 *
 * Preact component, consistent with the existing SplitSession design system.
 *
 * Derived from SplitSession's popup container list pattern
 * (https://github.com/Misyuk-T/splitsession, MIT License).
 */

import { Button } from "./components/Button";
import type { Profile, ProfileId } from "../profiles/profile-manager/profile";

/** Props for the ProfileSwitcher component. */
export interface ProfileSwitcherProps {
  profiles: Profile[];
  activeProfileId: ProfileId | null;
  /** Whether the global master password is configured. */
  masterPasswordSet?: boolean;
  onSwitch?: (id: ProfileId) => void;
  onCreate?: () => void;
  onManage?: () => void;
  /** Disables switching while a password prompt is open. */
  busy?: boolean;
}

/** True when a profile requires a password to be opened. */
function isProtected(profile: Profile, masterPasswordSet: boolean): boolean {
  return profile.hasIndependentPassword || masterPasswordSet;
}

/**
 * ProfileSwitcher: the popup's profile control.
 * Protected profiles show a lock; the actual unlock happens before switching.
 */
export const ProfileSwitcher = ({
  profiles,
  activeProfileId,
  masterPasswordSet = false,
  onSwitch,
  onCreate,
  onManage,
  busy = false,
}: ProfileSwitcherProps) => {
  const visible = profiles.filter(
    (profile) => profile.state === "active" || profile.state === "temporary",
  );
  const ordered = [...visible].sort(
    (a, b) =>
      Number(b.id === activeProfileId) - Number(a.id === activeProfileId),
  );

  return (
    <section class="profile-switcher" aria-label="Profiles">
      <div class="profile-switcher__head">
        <h2 class="profile-switcher__title">Profiles</h2>
        {onManage && (
          <Button
            variant="ghost"
            small
            onClick={onManage}
            aria-label="Manage profiles"
          >
            Manage
          </Button>
        )}
      </div>

      <ul class="profile-switcher__rows">
        {ordered.map((profile) => {
          const active = profile.id === activeProfileId;
          const protectedProfile = isProtected(profile, masterPasswordSet);
          return (
            <li
              key={profile.id}
              class={[
                "profile-switcher__row",
                active && "profile-switcher__row--active",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <span
                class="profile-switcher__dot fx-dot"
                aria-hidden="true"
                style={
                  profile.metadata.color
                    ? { background: profile.metadata.color }
                    : undefined
                }
              />
              <span class="profile-switcher__name">
                {profile.metadata.name}
              </span>
              {profile.state === "temporary" && (
                <span class="profile-switcher__tag">Temporary</span>
              )}
              {protectedProfile && (
                <span
                  class="profile-switcher__lock"
                  title="Password protected"
                  aria-label="Password protected"
                >
                  Locked
                </span>
              )}
              {onSwitch && (
                <Button
                  variant={active ? "primary" : "ghost"}
                  small
                  disabled={active || busy}
                  onClick={() => onSwitch(profile.id)}
                  aria-label={`Switch to profile “${profile.metadata.name}”`}
                >
                  {active ? "Current" : "Switch"}
                </Button>
              )}
            </li>
          );
        })}
      </ul>

      {visible.length === 0 && (
        <p class="profile-switcher__empty fx-secondary">
          No profiles yet.
        </p>
      )}

      {onCreate && (
        <Button variant="secondary" block onClick={onCreate}>
          New profile
        </Button>
      )}
    </section>
  );
};
