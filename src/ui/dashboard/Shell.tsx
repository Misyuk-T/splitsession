import { useCallback, useEffect, useState } from "preact/hooks";

import { Button } from "../components/Button";
import { IconDashboard, IconProfiles, IconSessions, IconSettings } from "./Icons";
import { NAVIGATION_ITEMS, pageForShortcut, type NavigationMode, type PageId } from "../../ui-system/navigation";
import { Logo } from "../components/Logo";

interface ShellProps {
  mode: NavigationMode;
  page: PageId;
  onPage(next: PageId): void;
  onToggleSidebar?: () => void;
  children: preact.ComponentChildren;
}

export const Shell = ({
  mode,
  page,
  onPage,
  onToggleSidebar,
  children,
}: ShellProps) => {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const handleShortcut = useCallback(
    (event: KeyboardEvent) => {
      if (!event.altKey) return;
      const target = pageForShortcut(event.key);
      if (target) {
        event.preventDefault();
        onPage(target);
        if (mode === "sidebar" || mode === "combined") setSidebarOpen(false);
      }
    },
    [mode, onPage],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [handleShortcut]);

  const active = (id: string) => page === id;

  return (
    <div class="agx-shell" data-agx-nav={mode}>
      <button
        type="button"
        class="agx-shell__menu"
        aria-label={sidebarOpen ? "Cerrar navegación" : "Abrir navegación"}
        aria-expanded={sidebarOpen}
        onClick={() => setSidebarOpen(!sidebarOpen)}
        hidden={mode === "top"}
      >
        <span aria-hidden="true">☰</span>
      </button>

      <nav
        class="agx-sidebar"
        aria-label="Navegación principal"
        hidden={!(sidebarOpen && (mode === "sidebar" || mode === "combined"))}
      >
        <div class="agx-brand" aria-hidden="true">
          <Logo size={20} />
          <span>AEGOX</span>
        </div>
        <ul class="agx-sidebar__scroll">
          {NAVIGATION_ITEMS.map((item) => (
            <li key={item.id}>
              <button
                class="agx-nav-item"
                aria-current={active(item.id) ? "page" : undefined}
                aria-label={`${item.label} (Alt+${item.shortcut})`}
                onClick={() => {
                  onPage(item.id);
                  setSidebarOpen(false);
                }}
              >
                {item.id === "dashboard" && <IconDashboard />}
                {item.id === "sessions" && <IconSessions />}
                {item.id === "profiles" && <IconProfiles />}
                {item.id === "settings" && <IconSettings />}
                <span>{item.label}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <main class="agx-main">
        <header class="agx-topbar">
          {!sidebarOpen && mode !== "top" && (
            <button
              type="button"
              class="agx-shell__menu"
              aria-label={sidebarOpen ? "Cerrar navegación" : "Abrir navegación"}
              aria-expanded={sidebarOpen}
              onClick={() => setSidebarOpen(!sidebarOpen)}
            >
              <span aria-hidden="true">☰</span>
            </button>
          )}
          <div class="agx-brand" aria-hidden="true">
            <Logo size={20} />
            <span>AEGOX</span>
          </div>
          <div class="agx-spacer" />
          <nav class="agx-topbar__nav" aria-label="Secciones rápidas">
            {NAVIGATION_ITEMS.map((item) => (
              <button
                key={item.id}
                type="button"
                class="agx-topbar__item"
                aria-current={active(item.id) ? "page" : undefined}
                aria-label={`${item.label} (Alt+${item.shortcut})`}
                onClick={() => onPage(item.id)}
              >
                {item.shortLabel}
              </button>
            ))}
          </nav>
        </header>
        <div class="agx-main__pad">{children}</div>
      </main>
    </div>
  );
};
