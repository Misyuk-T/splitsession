import { useCallback, useMemo, useState } from "preact/hooks";

import { Button } from "../components/Button";
import { IconPlus, IconSearch } from "./Icons";
import {
  buildDashboard,
  type DashboardOverview,
} from "../../ui-system/dashboard-data";
import {
  DEFAULT_WIDGET_LAYOUT,
  WIDGET_CATALOG,
  addWidget,
  moveWidget,
  removeWidget,
  resetWidgetLayout,
  setWidgetVisible,
  type WidgetLayoutItem,
  visibleWidgets,
  widgetSpan,
} from "../../ui-system/widgets";
import { SearchPalette } from "./SearchPalette";

interface OverviewCardProps {
  label: string;
  value: number | "--";
  sublabel?: string;
  accent?: string;
}

const OverviewCard = ({
  label,
  value,
  sublabel,
  accent,
}: OverviewCardProps) => (
  <div class="agx-kpi__card" style={{ borderLeft: `4px solid ${accent ?? "var(--agx-borderStrong)"}` }}>
    <div class="agx-kpi__value">{value}</div>
    <div class="agx-kpi__label">{label}</div>
    {sublabel && <div style={{ fontSize: "11px", color: "var(--agx-muted)" }}>{sublabel}</div>}
  </div>
);

interface WidgetSettingsProps {
  layout: WidgetLayoutItem[];
  onChange(next: WidgetLayoutItem[]): void;
}

const WidgetSettings = ({ layout, onChange }: WidgetSettingsProps) => {
  const [editing, setEditing] = useState<WidgetLayoutItem[]>(layout);

  const toggle = (id: WidgetLayoutItem["id"]) =>
    setEditing((prev) => setWidgetVisible(prev, id, !prev.find((i) => i.id === id)!.visible));
  const up = (id: WidgetLayoutItem["id"]) =>
    setEditing((prev) => moveWidget(prev, id, -1));
  const down = (id: WidgetLayoutItem["id"]) =>
    setEditing((prev) => moveWidget(prev, id, 1));

  return (
    <section class="agx-section">
      <h2>Distribución de widgets</h2>
      <p class="fx-secondary">Reorganiza, muestra u oculta los paneles del inicio.</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {editing.map((item) => {
          const def = WIDGET_CATALOG[item.id];
          return (
            <div
              key={item.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 10px",
                border: "1px solid var(--agx-border)",
                borderRadius: "6px",
                background: "var(--agx-surface)",
              }}
            >
              <button
                type="button"
                aria-pressed={!item.visible}
                onClick={() => toggle(item.id)}
                title={item.visible ? "Ocultar" : "Mostrar"}
                style={{
                  padding: "2px 6px",
                  fontSize: "11px",
                  borderRadius: "4px",
                  border: "1px solid var(--agx-border)",
                  background: item.visible ? "transparent" : "var(--agx-accent-soft)",
                  color: item.visible ? "var(--agx-text)" : "var(--agx-accent)",
                  cursor: "pointer",
                }}
              >
                {item.visible ? "Ocultar" : "Mostrar"}
              </button>
              <button
                type="button"
                onClick={() => up(item.id)}
                disabled={item.order === 0}
                title="Subir"
                style={{ padding: "2px 6px", fontSize: "11px", border: "1px solid var(--agx-border)", background: "transparent", cursor: item.order === 0 ? "not-allowed" : "pointer" }}
              >
                ▲
              </button>
              <button
                type="button"
                onClick={() => down(item.id)}
                disabled={item.order === editing.length - 1}
                title="Bajar"
                style={{ padding: "2px 6px", fontSize: "11px", border: "1px solid var(--agx-border)", background: "transparent", cursor: item.order === editing.length - 1 ? "not-allowed" : "pointer" }}
              >
                ▼
              </button>
              <span style={{ flex: 1, fontSize: "var(--fx-text-secondary)", color: "var(--agx-text)" }}>{def.title}</span>
              <span style={{ fontSize: "11px", color: "var(--agx-muted)" }}>{def.description}</span>
              {def.locked && <span style={{ fontSize: "10px", color: "var(--agx-muted)" }}>(obligatorio)</span>}
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <Button variant="ghost" small onClick={() => setEditing(resetWidgetLayout())}>
          Restablecer predeterminado
        </Button>
        <Button variant="primary" small onClick={() => onChange(editing)}>
          Guardar distribución
        </Button>
      </div>
    </section>
  );
};

interface HomeProps {
  overview: DashboardOverview | null;
  layout: WidgetLayoutItem[];
  onLayoutChange(next: WidgetLayoutItem[]): void;
  onSearch: () => void;
  onCreateProfile: () => void;
  onCreateSession: () => void;
}

export const Home = ({
  overview,
  layout,
  onLayoutChange,
  onSearch,
  onCreateProfile,
  onCreateSession,
}: HomeProps) => {
  const [widgetsOpen, setWidgetsOpen] = useState(false);

  const sessions = overview?.sessions;
  const profiles = overview?.profiles;

  return (
    <section aria-label="Panel de inicio">
      <header class="agx-page">
        <div>
          <h1>Panel de control</h1>
          <p class="agx-page__lead">
            Resumen real de tus perfiles y sesiones de Session Core y Profile Manager.
          </p>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <Button variant="ghost" small icon onClick={onSearch} aria-label="Buscar global">
            <IconSearch />
          </Button>
          <Button variant="primary" small onClick={onCreateSession}>
            <IconPlus /> Nueva sesión
          </Button>
          <Button variant="secondary" small onClick={onCreateProfile}>
            <IconPlus /> Nuevo perfil
          </Button>
        </div>
      </header>

      {overview === null && (
        <div class="agx-state">
          <svg aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="1.8" />
            <circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="1.8" />
          </svg>
          <h2>No hay datos aún</h2>
          <p>Crea tu primer perfil o sesión para empezar.</p>
        </div>
      )}

      {overview && (
        <>
          <div class="agx-kpi">
            <OverviewCard
              label="Sesiones totales"
              value={overview!.sessions.total}
              sublabel="de Session Core"
              accent="var(--agx-accent)"
            />
            <OverviewCard
              label="Activas"
              value={overview!.sessions.active}
              sublabel="en uso"
              accent="var(--agx-ok)"
            />
            <OverviewCard
              label="Pausadas"
              value={overview!.sessions.paused}
              sublabel="suspendidas"
              accent="var(--agx-warning)"
            />
            <OverviewCard
              label="Expiradas"
              value={overview!.sessions.expired}
              sublabel="necesitan atención"
              accent="var(--agx-danger)"
            />
            <OverviewCard
              label="Perfiles"
              value={overview!.profiles.total}
              sublabel="de Profile Manager"
              accent="var(--agx-accent)"
            />
            <OverviewCard
              label="Favoritos"
              value={overview!.profiles.favorites}
              sublabel="perfiles y sesiones"
              accent="var(--agx-accent)"
            />
          </div>

          <div class="agx-grid">
            {visibleWidgets(layout).map((item) => {
              const def = WIDGET_CATALOG[item.id];
              const locked = def.locked;
              return (
                <div
                  key={item.id}
                  class={`agx-widget${locked ? " agx-widget--locked" : ""} agx-widget--span-${widgetSpan(item)}`}
                >
                  <div class="agx-widget__head">
                    <h3>{def.title}</h3>
                  </div>
                  <div class="agx-widget__body">
                    {item.id === "overview" && (
                      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                        <div style={{ flex: 1, minWidth: 110 }}>
                          <div style={{ fontSize: "11px", color: "var(--agx-muted)" }}>Sesiones activas</div>
                          <div style={{ fontSize: "20px", fontWeight: 700 }}>{overview.sessions.active}</div>
                        </div>
                        <div style={{ flex: 1, minWidth: 110 }}>
                          <div style={{ fontSize: "11px", color: "var(--agx-muted)" }}>Perfiles</div>
                          <div style={{ fontSize: "20px", fontWeight: 700 }}>{overview.profiles.total}</div>
                        </div>
                        <div style={{ flex: 1, minWidth: 110 }}>
                          <div style={{ fontSize: "11px", color: "var(--agx-muted)" }}>Favoritos</div>
                          <div style={{ fontSize: "20px", fontWeight: 700 }}>{overview.profiles.favorites}</div>
                        </div>
                      </div>
                    )}
                    {item.id === "session-breakdown" && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {[
                          ["Activas", overview.sessions.active, "var(--agx-ok)"],
                          ["Pausadas", overview.sessions.paused, "var(--agx-warning)"],
                          ["Expiradas", overview.sessions.expired, "var(--agx-danger)"],
                          ["Archivadas", overview.sessions.archived, "var(--agx-muted)"],
                          ["Cerradas", overview.sessions.closed, "var(--agx-muted)"],
                        ].map(([label, value, color]) => (
                          <div key={label} style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--fx-text-secondary)" }}>
                            <span style={{ color: "var(--agx-text)" }}>{label}</span>
                            <span style={{ color, fontWeight: 600 }}>{value}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {item.id === "profile-overview" && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {overview.profileSummaries.slice(0, 6).map((summary) => (
                          <div
                            key={summary.profile.id}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                              fontSize: "var(--fx-text-secondary)",
                            }}
                          >
                            <span
                              style={{
                                display: "inline-block",
                                width: 10,
                                height: 10,
                                borderRadius: "50%",
                                background: summary.profile.metadata.color ?? "var(--agx-border)",
                                flex: "none",
                              }}
                            />
                            <span
                              title={summary.profile.metadata.name}
                              style={{ flex: 1, minWidth: 0, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}
                            >
                              {summary.profile.metadata.name}
                            </span>
                            <span style={{ color: "var(--agx-muted)" }}>{summary.sessionCount} sesiones</span>
                          </div>
                        ))}
                        {overview.profileSummaries.length === 0 && (
                          <p style={{ color: "var(--agx-muted)", fontSize: "var(--fx-text-secondary)" }}>Sin perfiles.</p>
                        )}
                      </div>
                    )}
                    {item.id === "recent-activity" && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {overview.recentActivity.slice(0, 6).map((item) => (
                          <div
                            key={item.id}
                            style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--fx-text-secondary)" }}
                          >
                            <span style={{ color: "var(--agx-text)" }}>{item.title}</span>
                            <span style={{ color: "var(--agx-muted)" }}>{item.detail}</span>
                          </div>
                        ))}
                        {overview.recentActivity.length === 0 && (
                          <p style={{ color: "var(--agx-muted)", fontSize: "var(--fx-text-secondary)" }}>Sin actividad reciente.</p>
                        )}
                      </div>
                    )}
                    {item.id === "favorites" && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {([...overview.favorites.profiles.slice(0, 3), ...overview.favorites.sessions.slice(0, 3)]).map((item) => (
                            <div key={item.id} style={{ fontSize: "var(--fx-text-secondary)", color: "var(--agx-text)" }}>
                              {item.metadata.name ?? "Sin nombre"}
                            </div>
                          ))}
                        {overview.favorites.profiles.length === 0 && overview.favorites.sessions.length === 0 && (
                          <p style={{ color: "var(--agx-muted)", fontSize: "var(--fx-text-secondary)" }}>Sin favoritos.</p>
                        )}
                      </div>
                    )}
                    {item.id === "statistics" && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {overview.statistics ? (
                          <>
                            <div style={{ fontSize: "var(--fx-text-secondary)" }}>
                              <span style={{ color: "var(--agx-text)" }}>Perfiles</span>
                              <span style={{ color: "var(--agx-muted)" }}>{overview.statistics.totalProfiles}</span>
                            </div>
                            <div style={{ fontSize: "var(--fx-text-secondary)" }}>
                              <span style={{ color: "var(--agx-text)" }}>Sesiones</span>
                              <span style={{ color: "var(--agx-muted)" }}>{overview.statistics.totalSessions}</span>
                            </div>
                            <div style={{ fontSize: "var(--fx-text-secondary)" }}>
                              <span style={{ color: "var(--agx-text)" }}>Cambios de perfil</span>
                              <span style={{ color: "var(--agx-muted)" }}>{overview.statistics.totalSwitches}</span>
                            </div>
                          </>
                        ) : (
                          <p style={{ color: "var(--agx-muted)", fontSize: "var(--fx-text-secondary)" }}>
                            Estadísticas desactivadas. Actívalas en los ajustes de un perfil.
                          </p>
                        )}
                      </div>
                    )}
                    {item.id === "security-notices" && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {overview.warnings.length > 0 ? (
                          overview.warnings.map((warning) => (
                            <div
                              key={warning.id}
                              style={{
                                display: "flex",
                                gap: 8,
                                padding: "6px 8px",
                                borderRadius: "6px",
                                background: warning.severity === "critical" ? "var(--agx-danger-soft)" : "var(--agx-warning-soft)",
                                border: `1px solid ${warning.severity === "critical" ? "var(--agx-danger)" : "var(--agx-warning)"}`,
                                fontSize: "var(--fx-text-secondary)",
                              }}
                            >
                              <span style={{ color: warning.severity === "critical" ? "var(--agx-danger)" : "var(--agx-warning)", fontWeight: 600 }}>
                                {warning.title}
                              </span>
                              <span style={{ flex: 1, minWidth: 0 }}>{warning.detail}</span>
                            </div>
                          ))
                        ) : (
                          <p style={{ color: "var(--agx-ok)", fontSize: "var(--fx-text-secondary)" }}>Sin avisos de seguridad.</p>
                        )}
                      </div>
                    )}
                    {item.id === "quick-actions" && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        <Button small block onClick={onCreateSession}>Nueva sesión</Button>
                        <Button small block variant="secondary" onClick={onCreateProfile}>Nuevo perfil</Button>
                        <Button small block variant="ghost" onClick={onSearch}>Buscar global</Button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {widgetsOpen && (
            <WidgetSettings layout={layout} onChange={onLayoutChange} />
          )}
          <Button
            variant="ghost"
            small
            onClick={() => setWidgetsOpen(!widgetsOpen)}
            aria-label={widgetsOpen ? "Cerrar distribución de widgets" : "Editar distribución de widgets"}
          >
            {widgetsOpen ? "Listo" : "Editar widgets"}
          </Button>
        </>
      )}
    </section>
  );
};
