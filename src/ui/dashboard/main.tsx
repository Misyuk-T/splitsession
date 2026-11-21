import { useCallback, useMemo, useState } from "preact/hooks";
import { browser } from "wxt/browser";

import { DashboardTheme } from "./DashboardTheme";
import { Shell } from "./Shell";
import { Home } from "./Home";
import { SessionsView } from "./SessionsView";
import { SearchPalette } from "./SearchPalette";
import { Settings } from "./Settings";
import { Modal } from "./Modal";
import { useDashboardData } from "./data";
import {
  IconDashboard,
  IconProfiles,
  IconSessions,
  IconSettings,
  IconSearch,
  IconStar,
} from "./Icons";
import { Logo } from "../components/Logo";
import { Button } from "../components/Button";
import { toggleFavorite } from "../../ui-system/preferences";

/** AEGOX dashboard host (Module 04). Integrates Session Core + Profile Manager. */
export const Dashboard = () => {
  const data = useDashboardData();
  const [page, setPage] = useState<"dashboard" | "sessions" | "profiles" | "settings">("dashboard");
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sessionView, setSessionView] = useState<"compact" | "cards" | "table">(
    data.preferences?.sessionView ?? "compact",
  );

  const preferences = data.preferences;
  const themePref = preferences?.theme ?? "system";
  const navMode = preferences?.navigation ?? "sidebar";
  const textScale = preferences?.textScale ?? 100;
  const animations = preferences?.animations ?? "full";

  const activeProfileId = data.activeProfileId ?? "";
  const profileNames = useMemo(
    () =>
      new Map(
        data.profiles.map((profile) => [profile.id, profile.metadata.name]),
      ),
    [data.profiles],
  );

  const overview = useMemo(() => {
    if (!data.ready) return null;
    return {
      sessions: {
        total: data.sessions.length,
        active: data.sessions.filter((s) => s.state === "active").length,
        paused: data.sessions.filter((s) => s.state === "paused").length,
        expired: data.sessions.filter((s) => s.state === "expired").length,
        archived: data.sessions.filter((s) => s.state === "archived").length,
        closed: data.sessions.filter((s) => s.state === "closed").length,
      },
      profiles: {
        total: data.profiles.length,
        active: data.profiles.filter((p) => p.state === "active").length,
        archived: data.profiles.filter((p) => p.state === "archived").length,
        temporary: data.profiles.filter((p) => p.state === "temporary").length,
        deleted: data.profiles.filter((p) => p.state === "deleted").length,
        favorites: (preferences?.favoriteProfileIds ?? []).length,
      },
      profileSummaries: data.profiles.map((profile) => {
        const profileSessions = data.sessions.filter(
          (s) => s.metadata.profileId === profile.id,
        );
        return {
          profile,
          sessionCount: profileSessions.length,
          activeSessionCount: profileSessions.filter(
            (s) => s.state === "active",
          ).length,
          favorite: (preferences?.favoriteProfileIds ?? []).includes(profile.id),
        };
      }),
      recentActivity: [],
      warnings: [],
      statistics: null,
      favorites: {
        profiles: data.profiles.filter((p) =>
          (preferences?.favoriteProfileIds ?? []).includes(p.id),
        ),
        sessions: data.sessions.filter((s) =>
          (preferences?.favoriteSessionIds ?? []).includes(s.id),
        ),
      },
      isEmpty: data.profiles.length === 0 && data.sessions.length === 0,
    };
  }, [data.ready, data.sessions, data.profiles, preferences]);

  const handleCreateProfile = async () => {
    const name = prompt("Nombre del perfil");
    if (!name) return;
    await data.createProfile(name);
  };

  const handleCreateSession = async () => {
    const name = prompt("Nombre de la sesión");
    if (!name) return;
    const profileId = prompt("ID del perfil (opcional)", activeProfileId || undefined);
    await data.createSession({ name, profileId: profileId || undefined });
  };

  const handleToggleFavoriteProfile = (id: string) => {
    data.updatePreferences({
      favoriteProfileIds: toggleFavorite(preferences?.favoriteProfileIds ?? [], id),
    });
  };

  const handleToggleFavoriteSession = (id: string) => {
    data.updatePreferences({
      favoriteSessionIds: toggleFavorite(preferences?.favoriteSessionIds ?? [], id),
    });
  };

  const handleSessionAction = async (id: string, action: string) => {
    switch (action) {
      case "pause":
        await data.setSessionState(id, "paused");
        break;
      case "resume":
        await data.setSessionState(id, "active");
        break;
      case "archive":
        await data.setSessionState(id, "archived");
        break;
      case "restore":
        await data.setSessionState(id, "active");
        break;
      case "delete":
        await data.deleteSession(id);
        break;
    }
  };

  const handleLayoutChange = useCallback(
    (next: never[]) => {
      data.updatePreferences({ widgetLayout: next as never });
    },
    [data.updatePreferences],
  );

  const handleSaveSettings = useCallback((next: never) => {
    data.updatePreferences(next as never);
  }, [data.updatePreferences]);

  return (
    <>
      <DashboardTheme
        preference={themePref}
        textScale={textScale}
        animations={animations}
      />
      <Shell
        mode={navMode}
        page={page}
        onPage={setPage}
      >
        {page === "dashboard" && (
          <Home
            overview={overview}
            layout={preferences?.widgetLayout ?? []}
            onLayoutChange={handleLayoutChange}
            onSearch={() => setSearchOpen(true)}
            onCreateProfile={handleCreateProfile}
            onCreateSession={handleCreateSession}
          />
        )}
        {page === "sessions" && (
          <SessionsView
            sessions={data.sessions}
            profileNames={profileNames}
            favoriteSessionIds={preferences?.favoriteSessionIds ?? []}
            onToggleFavorite={handleToggleFavoriteSession}
            onAction={handleSessionAction}
            view={sessionView}
            onView={setSessionView}
          />
        )}
        {page === "profiles" && (
          <section aria-label="Perfiles">
            <header class="agx-page">
              <h1>Perfiles</h1>
              <p class="agx-page__lead">
                Tus perfiles de Profile Manager, con sus sesiones asociadas.
              </p>
            </header>
            {data.profiles.length === 0 && (
              <div class="agx-state">
                <svg aria-hidden="true">
                  <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.8" />
                  <path d="M8 12h8M12 8v8" fill="none" stroke="currentColor" stroke-width="1.8" />
                </svg>
                <h2>Sin perfiles</h2>
                <p>Crea tu primer perfil para organizar sesiones.</p>
              </div>
            )}
            {data.profiles.length > 0 && (
              <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
                {data.profiles.map((profile) => (
                  <li key={profile.id} style={{
                    display: "flex", alignItems: "center", gap: 10,
                    padding: "10px 12px", border: "1px solid var(--agx-border)",
                    borderRadius: "var(--fx-radius)", background: "var(--agx-surface-raised)"
                  }}>
                    <span
                      style={{
                        display: "inline-block", width: 12, height: 12, borderRadius: "50%",
                        background: profile.metadata.color ?? "var(--agx-border)", flex: "none"
                      }}
                    />
                    <span style={{ flex: 1, minWidth: 0 }}>{profile.metadata.name}</span>
                    <span style={{ color: "var(--agx-muted)", fontSize: "var(--fx-text-secondary)" }}>
                      {profile.state} · {profile.tags.length} etiquetas
                    </span>
                    <span style={{ color: "var(--agx-muted)", fontSize: "var(--fx-text-secondary)" }}>
                      {data.sessions.filter((s) => s.metadata.profileId === profile.id).length} sesiones
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      small
                      onClick={() => handleToggleFavoriteProfile(profile.id)}
                      aria-label={
                        (preferences?.favoriteProfileIds ?? []).includes(profile.id)
                          ? "Quitar favorito"
                          : "Marcar favorito"
                      }
                    >
                      <IconStar filled={(preferences?.favoriteProfileIds ?? []).includes(profile.id)} />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
        {page === "settings" && preferences && (
          <Settings
            preferences={preferences}
            onSave={handleSaveSettings}
            onClose={() => setPage("dashboard")}
          />
        )}
      </Shell>

      <SearchPalette
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        profiles={data.profiles}
        sessions={data.sessions}
        onSelect={(result) => {
          setSearchOpen(false);
          setPage(result.kind === "profile" ? "profiles" : "sessions");
        }}
      />

      {data.error && (
        <Modal
          title="Error"
          description={data.error}
          onClose={() => data.refresh()}
          footer={<Button variant="secondary" small onClick={() => data.refresh()} >Reintentar</Button>}
        >
          <p>{data.error}</p>
        </Modal>
      )}
    </>
  );
};
