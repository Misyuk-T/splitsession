import { useCallback, useMemo, useRef, useState } from "preact/hooks";

import { Button } from "../components/Button";
import { IconClose, IconStar } from "./Icons";
import {
  buildSessionRow,
  filterSessions,
  paginate,
  sessionActions,
  sortSessions,
  SESSION_PAGE_SIZE,
  type SessionFilter,
  type SessionRow,
} from "../../ui-system/session-presenter";
import { statePresentation } from "../../ui-system/session-presenter";
import type { Session } from "../../core/session-manager/session";

interface SessionCardProps {
  row: SessionRow;
  onToggleFavorite: (id: string) => void;
  onAction: (id: string, action: string) => void;
  favoriteIds: readonly string[];
}

const SessionCard = ({ row, onToggleFavorite, onAction, favoriteIds }: SessionCardProps) => {
  const session = row.session;
  const dotColor = {
    active: "var(--agx-ok)",
    paused: "var(--agx-warning)",
    expired: "var(--agx-danger)",
    archived: "var(--agx-muted)",
    closed: "var(--agx-muted)",
  }[row.state.tone];

  return (
    <article class="agx-card">
      <div class="agx-card__head">
        <div class="agx-card__title" title={session.metadata.name}>
          {session.metadata.name}
        </div>
        <span class="agx-card__state" style={{ background: "var(--agx-surface-hover)", color: dotColor }}>
          {row.state.label}
        </span>
      </div>
      {session.metadata.domain && (
        <div style={{ fontSize: "12px", color: "var(--agx-muted)" }}>{session.metadata.domain}</div>
      )}
      <div style={{ fontSize: "12px", color: "var(--agx-muted)" }}>
        Creada: {row.createdLabel} &nbsp;·&nbsp; Último uso: {row.lastUsedLabel}
      </div>
      <div class="agx-card__footer">
        <button
          type="button"
          class="agx-icon-btn"
          aria-label={favoriteIds.includes(session.id) ? "Quitar favorito" : "Marcar favorito"}
          onClick={() => onToggleFavorite(session.id)}
        >
          <IconStar filled={favoriteIds.includes(session.id)} />
        </button>
        {row.actions.map((action) => (
          <button
            key={action.id}
            type="button"
            class="agx-icon-btn"
            disabled={!action.available}
            title={action.available ? action.label : action.reason ?? action.label}
            onClick={() => action.available && onAction(session.id, action.id)}
            aria-label={`${action.label} ${session.metadata.name}`}
            style={{
              color: action.danger ? "var(--agx-danger)" : "var(--agx-muted)",
              opacity: action.available ? 1 : 0.45,
            }}
          >
            {action.id === "open" && <span aria-hidden="true">⇥</span>}
            {action.id === "pause" && <span aria-hidden="true">❚❚</span>}
            {action.id === "resume" && <span aria-hidden="true">▶</span>}
            {action.id === "archive" && <span aria-hidden="true">📦</span>}
            {action.id === "restore" && <span aria-hidden="true">↩</span>}
            {action.id === "delete" && <IconClose />}
          </button>
        ))}
      </div>
    </article>
  );
};

interface SessionsViewProps {
  sessions: ReadonlyArray<Session>;
  profileNames: ReadonlyMap<string, string>;
  favoriteSessionIds: readonly string[];
  onToggleFavorite: (id: string) => void;
  onAction: (id: string, action: string) => void;
  view: "compact" | "cards" | "table";
  onView(next: "compact" | "cards" | "table"): void;
}

export const SessionsView = ({
  sessions,
  profileNames,
  favoriteSessionIds,
  onToggleFavorite,
  onAction,
  view,
  onView,
}: SessionsViewProps) => {
  const [filter, setFilter] = useState<SessionFilter>({ query: "", state: "all" });
  const [page, setPage] = useState(0);
  const [sortField, setSortField] = useState<"name" | "createdAt" | "lastUsedAt" | "state" | "domain">("lastUsedAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [deleting, setDeleting] = useState<string | null>(null);

  const filtered = useMemo(() => filterSessions(sessions, filter), [sessions, filter]);
  const sorted = useMemo(() => sortSessions(filtered, sortField, sortDir), [filtered, sortField, sortDir]);
  const paged = useMemo(() => paginate(sorted, page, SESSION_PAGE_SIZE), [sorted, page]);

  const rows = useMemo(
    () =>
      paged.items.map((session) =>
        buildSessionRow(session, profileNames.get(session.metadata.profileId ?? "") ?? null),
      ),
    [paged.items, profileNames],
  );

  const handleFilter = useCallback((event: Event) => {
    const value = (event.target as HTMLInputElement).value;
    setFilter({ ...filter, query: value });
    setPage(0);
  }, [filter]);

  const handleState = useCallback((next: string) => {
    setFilter({ ...filter, state: next as "all" | "active" | "paused" | "expired" | "archived" | "closed" });
    setPage(0);
  }, [filter]);

  if (paged.total === 0) {
    return (
      <section class="agx-state">
        <svg aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="1.8" />
          <path d="M3 9h18M7 5V3M17 5V3" fill="none" stroke="currentColor" stroke-width="1.8" />
        </svg>
        <h2>Sin sesiones</h2>
        <p>No hay sesiones que coincidan con el filtro actual.</p>
      </section>
    );
  }

  return (
    <section aria-label="Sesiones">
      <div class="agx-view-toolbar">
        <input
          type="search"
          placeholder="Buscar sesiones…"
          value={filter.query ?? ""}
          onInput={handleFilter}
          aria-label="Filtrar sesiones"
          style={{
            padding: "6px 10px",
            border: "1px solid var(--agx-border)",
            borderRadius: "var(--fx-radius-sm)",
            background: "var(--agx-surface)",
            color: "var(--agx-text)",
            font: "inherit",
            minWidth: "200px",
          }}
        />
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "var(--fx-text-secondary)", color: "var(--agx-muted)" }}>
          Estado:
          <select
            value={filter.state ?? "all"}
            onChange={(e) => handleState((e.target as HTMLSelectElement).value)}
            style={{
              padding: "4px 8px",
              border: "1px solid var(--agx-border)",
              borderRadius: "var(--fx-radius-sm)",
              background: "var(--agx-surface)",
              color: "var(--agx-text)",
              font: "inherit",
            }}
          >
            <option value="all">Todas</option>
            <option value="active">Activas</option>
            <option value="paused">Pausadas</option>
            <option value="expired">Expiradas</option>
            <option value="archived">Archivadas</option>
            <option value="closed">Cerradas</option>
          </select>
        </label>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <button
            type="button"
            class="agx-view-toggle__btn"
            aria-pressed={view === "compact"}
            onClick={() => onView("compact")}
            title="Lista compacta"
            style={{
              padding: "6px 10px", border: "1px solid var(--agx-border)", background: view === "compact" ? "var(--agx-accent-soft)" : "transparent", color: view === "compact" ? "var(--agx-accent)" : "var(--agx-muted)", cursor: "pointer", fontSize: "var(--fx-text-secondary)", borderRadius: "var(--fx-radius-sm)"
            }}
          >
            Lista
          </button>
          <button
            type="button"
            aria-pressed={view === "cards"}
            onClick={() => onView("cards")}
            title="Tarjetas"
            style={{
              padding: "6px 10px", border: "1px solid var(--agx-border)", background: view === "cards" ? "var(--agx-accent-soft)" : "transparent", color: view === "cards" ? "var(--agx-accent)" : "var(--agx-muted)", cursor: "pointer", fontSize: "var(--fx-text-secondary)", borderRadius: "var(--fx-radius-sm)"
            }}
          >
            Tarjetas
          </button>
          <button
            type="button"
            aria-pressed={view === "table"}
            onClick={() => onView("table")}
            title="Tabla"
            style={{
              padding: "6px 10px", border: "1px solid var(--agx-border)", background: view === "table" ? "var(--agx-accent-soft)" : "transparent", color: view === "table" ? "var(--agx-accent)" : "var(--agx-muted)", cursor: "pointer", fontSize: "var(--fx-text-secondary)", borderRadius: "var(--fx-radius-sm)"
            }}
          >
            Tabla
          </button>
        </div>
      </div>

      {view === "compact" && (
        <ul class="agx-compact" aria-label="Lista compacta de sesiones">
          {rows.map((row) => {
            const session = row.session;
            return (
              <li key={session.id} class="agx-compact__row">
                <span
                  class="agx-compact__dot"
                  style={{ background: { active: "var(--agx-ok)", paused: "var(--agx-warning)", expired: "var(--agx-danger)", archived: "var(--agx-muted)", closed: "var(--agx-muted)" }[row.state.tone] }}
                  aria-hidden="true"
                />
                <span class="agx-compact__name" title={session.metadata.name}>
                  {session.metadata.name}
                </span>
                <span class="agx-compact__meta">{session.metadata.domain ?? "—"}</span>
                <span class="agx-compact__meta" style={{ color: row.state.tone === "expired" ? "var(--agx-danger)" : "var(--agx-text)" }}>
                  {row.state.label}
                </span>
                <div class="agx-compact__actions">
                  {row.actions.map((action) => (
                    <Button
                      key={action.id}
                      type="button"
                      variant="ghost"
                      small
                      disabled={!action.available}
                      title={action.available ? action.label : action.reason ?? action.label}
                      onClick={() => action.available && onAction(session.id, action.id)}
                    >
                      {action.label}
                    </Button>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {view === "cards" && (
        <ul class="agx-cards" aria-label="Tarjetas de sesiones">
          {rows.map((row) => (
            <SessionCard
              key={row.session.id}
              row={row}
              onToggleFavorite={onToggleFavorite}
              onAction={onAction}
              favoriteIds={favoriteSessionIds}
            />
          ))}
        </ul>
      )}

      {view === "table" && (
        <div class="agx-table-wrap">
          <table class="agx-table" aria-label="Tabla de sesiones">
            <thead>
              <tr>
                <th scope="col">Nombre</th>
                <th scope="col">Dominio</th>
                <th scope="col">Perfil</th>
                <th scope="col">Estado</th>
                <th scope="col">Creada</th>
                <th scope="col">Último uso</th>
                <th scope="col" style={{ textAlign: "center" }}>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const session = row.session;
                const profile = profileNames.get(session.metadata.profileId ?? "") ?? "—";
                return (
                  <tr key={session.id}>
                    <td title={session.metadata.name}>{session.metadata.name}</td>
                    <td>{session.metadata.domain ?? "—"}</td>
                    <td>{profile}</td>
                    <td>
                      <span
                        style={{
                          display: "inline-block",
                          width: 8,
                          height: 8,
                          borderRadius: "50%",
                          background: { active: "var(--agx-ok)", paused: "var(--agx-warning)", expired: "var(--agx-danger)", archived: "var(--agx-muted)", closed: "var(--agx-muted)" }[row.state.tone],
                          marginRight: "6px",
                          verticalAlign: "middle",
                        }}
                      />
                      {row.state.label}
                    </td>
                    <td>{row.createdLabel}</td>
                    <td>{row.lastUsedLabel}</td>
                    <td style={{ display: "flex", gap: 4 }}>
                      {row.actions
                        .filter((a) => a.available)
                        .map((action) => (
                          <Button
                            key={action.id}
                            type="button"
                            variant="ghost"
                            small
                            title={action.label}
                            onClick={() => onAction(session.id, action.id)}
                          >
                            {action.label}
                          </Button>
                        ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10, fontSize: "var(--fx-text-secondary)", color: "var(--agx-muted)" }}>
        <span>Mostrando {paged.items.length} de {paged.total} sesiones</span>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            type="button"
            disabled={paged.page === 0}
            onClick={() => setPage(paged.page - 1)}
            title="Anterior"
            style={{ padding: "4px 10px", border: "1px solid var(--agx-border)", background: "var(--agx-surface)", color: "var(--agx-text)", cursor: paged.page === 0 ? "not-allowed" : "pointer", borderRadius: "var(--fx-radius-sm)" }}
          >
            Anterior
          </button>
          <span>Página {paged.page + 1} de {paged.pageCount}</span>
          <button
            type="button"
            disabled={paged.page >= paged.pageCount - 1}
            onClick={() => setPage(paged.page + 1)}
            title="Siguiente"
            style={{ padding: "4px 10px", border: "1px solid var(--agx-border)", background: "var(--agx-surface)", color: "var(--agx-text)", cursor: paged.page >= paged.pageCount - 1 ? "not-allowed" : "pointer", borderRadius: "var(--fx-radius-sm)" }}
          >
            Siguiente
          </button>
        </div>
      </div>
    </section>
  );
};
