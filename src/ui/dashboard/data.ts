/**
 * Dashboard data bridge (AEGOX_multisession, Module 04).
 *
 * Instantiates the real Module 02 Session Core and Module 03 Profile Manager
 * over `browser.storage.local`. The dashboard is a presentation layer: it never
 * re-implements validation or lifecycle rules, it calls the managers.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { browser } from "wxt/browser";

import { SessionManager, type Session, type SessionState } from "../../core";
import { ProfileManager, type Profile } from "../../profiles";
import { ProfileNavigation } from "../../profiles/profile-navigation/navigation";
import type { StorageAreaLike } from "../../engine/storage/storage-area";
import { describeError } from "../../ui/format";
import { loadPreferences, savePreferences, type DashboardPreferences } from "../../ui-system/preferences";

/** Adapts the extension storage area to the narrow interface the managers use. */
export function extensionStorageArea(): StorageAreaLike {
  return {
    get: (keys?: string | string[] | null) =>
      browser.storage.local.get(keys ?? null) as Promise<Record<string, unknown>>,
    set: (items: Record<string, unknown>) => browser.storage.local.set(items),
    remove: (keys: string | string[]) => browser.storage.local.remove(keys),
  };
}

export interface CreateSessionInput {
  name: string;
  domain?: string | null;
  profileId?: string | null;
}

export interface DashboardData {
  ready: boolean;
  busy: boolean;
  error: string | null;
  sessions: Session[];
  profiles: Profile[];
  activeProfileId: string | null;
  preferences: DashboardPreferences | null;
  refresh(): Promise<void>;
  updatePreferences(patch: Partial<DashboardPreferences>): Promise<void>;
  createProfile(name: string, color?: string): Promise<Profile | null>;
  createSession(input: CreateSessionInput): Promise<Session | null>;
  setSessionState(id: string, state: SessionState): Promise<void>;
  deleteSession(id: string): Promise<void>;
  setActiveProfile(id: string | null): Promise<void>;
  archiveProfile(id: string): Promise<void>;
  restoreProfile(id: string): Promise<void>;
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : describeError(error);

/**
 * Real stores plus preferences. `useRef` keeps one manager instance per page so
 * load/save ordering is stable; refresh reads the managers' in-memory copies.
 */
export function useDashboardData(): DashboardData {
  const areaRef = useRef<StorageAreaLike | null>(null);
  const sessionsRef = useRef<SessionManager | null>(null);
  const profilesRef = useRef<ProfileManager | null>(null);
  const navigationRef = useRef<ProfileNavigation | null>(null);

  if (areaRef.current === null) {
    areaRef.current = extensionStorageArea();
    sessionsRef.current = new SessionManager(areaRef.current);
    profilesRef.current = new ProfileManager(areaRef.current);
    navigationRef.current = new ProfileNavigation(profilesRef.current, areaRef.current);
  }

  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [preferences, setPreferences] = useState<DashboardPreferences | null>(null);

  const sync = useCallback(() => {
    setSessions(sessionsRef.current?.list() ?? []);
    setProfiles(profilesRef.current?.list() ?? []);
    setActiveProfileId(navigationRef.current?.getActiveProfileId() ?? null);
  }, []);

  const refresh = useCallback(async () => {
    const area = areaRef.current;
    const sessionsManager = sessionsRef.current;
    const profilesManager = profilesRef.current;
    const navigation = navigationRef.current;
    if (!area || !sessionsManager || !profilesManager || !navigation) return;
    try {
      await Promise.all([sessionsManager.load(), profilesManager.load()]);
      await navigation.load();
      setPreferences(await loadPreferences(area));
      sync();
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setReady(true);
    }
  }, [sync]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = useCallback(
    async <T,>(operation: () => Promise<T>): Promise<T | null> => {
      setBusy(true);
      try {
        const result = await operation();
        sync();
        setError(null);
        return result;
      } catch (e) {
        setError(errorText(e));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [sync],
  );

  const updatePreferences = useCallback(
    async (patch: Partial<DashboardPreferences>) => {
      const area = areaRef.current;
      if (!area) return;
      const current = preferences ?? (await loadPreferences(area));
      const next = await savePreferences(area, { ...current, ...patch });
      setPreferences(next);
    },
    [preferences],
  );

  const createProfile = useCallback(
    (name: string, color?: string) =>
      run(async () => (await profilesRef.current!.create({ name, color })).profile),
    [run],
  );

  const createSession = useCallback(
    (input: CreateSessionInput) =>
      run(async () =>
        (
          await sessionsRef.current!.create({
            name: input.name,
            domain: input.domain ?? null,
            profileId: input.profileId ?? null,
          })
        ).session,
      ),
    [run],
  );

  const setSessionState = useCallback(
    async (id: string, state: SessionState) => {
      await run(() => sessionsRef.current!.setState(id, state));
    },
    [run],
  );

  const deleteSession = useCallback(
    async (id: string) => {
      await run(() => sessionsRef.current!.delete(id));
    },
    [run],
  );

  const setActiveProfile = useCallback(
    async (id: string | null) => {
      await run(async () => {
        await navigationRef.current!.setActiveProfile(id);
        if (id) await profilesRef.current!.touch(id);
      });
    },
    [run],
  );

  const archiveProfile = useCallback(
    async (id: string) => {
      await run(() => profilesRef.current!.archive(id));
    },
    [run],
  );

  const restoreProfile = useCallback(
    async (id: string) => {
      await run(() => profilesRef.current!.restore(id));
    },
    [run],
  );

  return useMemo(
    () => ({
      ready,
      busy,
      error,
      sessions,
      profiles,
      activeProfileId,
      preferences,
      refresh,
      updatePreferences,
      createProfile,
      createSession,
      setSessionState,
      deleteSession,
      setActiveProfile,
      archiveProfile,
      restoreProfile,
    }),
    [
      ready,
      busy,
      error,
      sessions,
      profiles,
      activeProfileId,
      preferences,
      refresh,
      updatePreferences,
      createProfile,
      createSession,
      setSessionState,
      deleteSession,
      setActiveProfile,
      archiveProfile,
      restoreProfile,
    ],
  );
}
