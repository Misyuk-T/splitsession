import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";

import { Button } from "../components/Button";
import { IconClose, IconSearch } from "./Icons";
import { searchAll, flattenResults, moveIndex, clampIndex, type SearchResult } from "../../ui-system/search";
import type { Profile } from "../../profiles/profile-manager/profile";
import type { Session } from "../../core/session-manager/session";

interface SearchPaletteProps {
  open: boolean;
  onClose: () => void;
  profiles: ReadonlyArray<Profile>;
  sessions: ReadonlyArray<Session>;
  onSelect(result: SearchResult): void;
}

export const SearchPalette = ({
  open,
  onClose,
  profiles,
  sessions,
  onSelect,
}: SearchPaletteProps) => {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const results = useMemo(() => searchAll(query, profiles, sessions), [query, profiles, sessions]);
  const flat = useMemo(() => flattenResults(results), [results]);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setActive(-1);
    input.current?.focus();
  }, [open]);

  const handleKey = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive((cur) => moveIndex(cur, 1, flat.length));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive((cur) => moveIndex(cur, -1, flat.length));
        return;
      }
      if ((event.key === "Enter" || event.key === " ") && active >= 0) {
        event.preventDefault();
        onSelect(flat[active]!);
        return;
      }
    },
    [open, active, flat.length, onClose, onSelect],
  );

  const handleQuery = useCallback((event: Event) => {
    setQuery((event.target as HTMLInputElement).value);
    setActive(-1);
  }, []);

  const handleSelect = useCallback(
    (result: SearchResult) => {
      onSelect(result);
      onClose();
    },
    [onSelect, onClose],
  );

  if (!open) return null;

  return (
    <div
      class="agx-search-overlay"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
      onKeyDown={handleKey}
    >
      <div class="agx-search-panel" role="dialog" aria-modal="true" aria-label="Búsqueda global">
        <div class="agx-search__head">
          <IconSearch aria-hidden="true" />
          <input
            ref={input}
            type="search"
            placeholder="Buscar perfiles y sesiones…"
            value={query}
            onInput={handleQuery}
            autoFocus
            aria-label="Búsqueda global de perfiles y sesiones"
            spellcheck={false}
            style={{
              flex: 1,
              padding: "10px 14px",
              border: "1px solid var(--agx-border)",
              borderRadius: "var(--fx-radius)",
              background: "var(--agx-surface)",
              color: "var(--agx-text)",
              font: "inherit",
              fontSize: "var(--fx-text-main)",
            }}
          />
          <button type="button" class="agx-icon-btn" aria-label="Cerrar búsqueda" onClick={onClose}>
            <IconClose />
          </button>
        </div>

        {query.length < 1 && (
          <div class="agx-search__empty">
            <p style={{ color: "var(--agx-muted)", fontSize: "var(--fx-text-secondary)" }}>
              Escribe para buscar perfiles y sesiones por nombre, dominio o etiquetas.
            </p>
            <p style={{ color: "var(--agx-muted)", fontSize: "12px", marginTop: 4 }}>
              No se consultan contraseñas, cookies, tokens ni credenciales.
            </p>
            <p style={{ color: "var(--agx-muted)", fontSize: "12px", marginTop: 8 }}>
              Atajos: Alt+1 Dashboard · Alt+2 Sesiones · Alt+3 Perfiles · Alt+4 Ajustes
            </p>
          </div>
        )}

        {query.length >= 1 && results.total === 0 && (
          <div class="agx-search__empty">
            <p style={{ color: "var(--agx-muted)", fontSize: "var(--fx-text-secondary)" }}>
              No se encontró “{query}”.
            </p>
          </div>
        )}

        {query.length >= 1 && results.total > 0 && (
          <div class="agx-search__list" role="listbox" aria-label="Resultados">
            {results.profiles.map((result, index) => (
              <button
                key={`profile-${result.id}`}
                type="button"
                role="option"
                aria-selected={active === index}
                aria-posinset={index + 1}
                aria-setsize={results.profiles.length + results.sessions.length}
                onClick={() => handleSelect(result)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "8px 12px",
                  border: "none",
                  background: active === index ? "var(--agx-accent-soft)" : "transparent",
                  color: "var(--agx-text)",
                  cursor: "pointer",
                  textAlign: "left",
                  font: "inherit",
                  width: "100%",
                }}
              >
                <span style={{ flex: 1, minWidth: 0 }}>{result.title}</span>
                <span style={{ fontSize: "12px", color: "var(--agx-muted)" }}>{result.subtitle}</span>
                {result.badge && (
                  <span
                    style={{
                      fontSize: "11px",
                      padding: "1px 6px",
                      borderRadius: "10px",
                      background: "var(--agx-surface-hover)",
                      color: "var(--agx-accent)",
                      fontWeight: 600,
                    }}
                  >
                    {result.badge}
                  </span>
                )}
              </button>
            ))}
            {results.sessions.map((result, index) => (
              <button
                key={`session-${result.id}`}
                type="button"
                role="option"
                aria-selected={active === results.profiles.length + index}
                aria-posinset={results.profiles.length + index + 1}
                aria-setsize={results.profiles.length + results.sessions.length}
                onClick={() => handleSelect(result)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "8px 12px",
                  border: "none",
                  background: active === results.profiles.length + index ? "var(--agx-accent-soft)" : "transparent",
                  color: "var(--agx-text)",
                  cursor: "pointer",
                  textAlign: "left",
                  font: "inherit",
                  width: "100%",
                }}
              >
                <span style={{ flex: 1, minWidth: 0 }}>{result.title}</span>
                <span style={{ fontSize: "12px", color: "var(--agx-muted)" }}>{result.subtitle}</span>
                {result.badge && (
                  <span
                    style={{
                      fontSize: "11px",
                      padding: "1px 6px",
                      borderRadius: "10px",
                      background: "var(--agx-surface-hover)",
                      color: "var(--agx-accent)",
                      fontWeight: 600,
                    }}
                  >
                    {result.badge}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        <div class="agx-search__foot">
          {results.total > 0 && (
            <p style={{ fontSize: "12px", color: "var(--agx-muted)" }}>
              {results.total} resultado{results.total !== 1 ? "s" : ""} •
              ↑/↓ navega, Enter abre, Esc cierra
            </p>
          )}
        </div>
      </div>
    </div>
  );
};
