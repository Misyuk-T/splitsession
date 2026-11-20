import { useCallback, useState } from "preact/hooks";

import { Button } from "../components/Button";
import { Select } from "../components/Select";
import { IconClose, IconSearch } from "./Icons";
import {
  defaultPreferences,
  type DashboardPreferences,
  type ThemePreference,
  type NavigationMode,
  type AnimationPreference,
  type SessionViewMode,
  TEXT_SCALES,
} from "../../ui-system/preferences";

interface SettingsProps {
  preferences: DashboardPreferences | null;
  onSave(next: DashboardPreferences): void;
  onClose: () => void;
}

export const Settings = ({ preferences, onSave, onClose }: SettingsProps) => {
  const [draft, setDraft] = useState<DashboardPreferences>(
    preferences ?? defaultPreferences(),
  );

  const setField = useCallback(
    <K extends keyof DashboardPreferences>(key: K, value: DashboardPreferences[K]) =>
      setDraft((prev) => ({ ...prev, [key]: value })),
    [],
  );

  const themeOptions: { value: ThemePreference; label: string }[] = [
    { value: "light", label: "Claro" },
    { value: "dark", label: "Oscuro" },
    { value: "system", label: "Sistema" },
  ];

  const navOptions: { value: NavigationMode; label: string }[] = [
    { value: "sidebar", label: "Barra lateral" },
    { value: "top", label: "Barra superior" },
    { value: "combined", label: "Ambas" },
  ];

  const viewOptions: { value: SessionViewMode; label: string }[] = [
    { value: "compact", label: "Lista compacta" },
    { value: "cards", label: "Tarjetas" },
    { value: "table", label: "Tabla" },
  ];

  const animationOptions: { value: AnimationPreference; label: string }[] = [
    { value: "full", label: "Completas" },
    { value: "reduced", label: "Reducidas" },
    { value: "none", label: "Sin animaciones" },
  ];

  const handleSave = () => {
    onSave(draft);
    onClose();
  };

  const handleReset = () => {
    setDraft(defaultPreferences());
  };

  return (
    <section class="agx-section" style={{ maxWidth: "720px" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, marginBottom: 10 }}>
        <h2 style={{ fontSize: "18px", color: "var(--agx-text)" }}>Apariencia y comportamiento</h2>
        <Button type="button" variant="ghost" small onClick={handleReset}>
          Restablecer predeterminados
        </Button>
      </div>

      <div class="agx-field">
        <label>Tema</label>
        <Select
          label="Tema"
          value={draft.theme}
          options={themeOptions}
          onChange={(next: ThemePreference) => setField("theme", next)}
        />
        <span class="fx-secondary">
          El tema “Sistema” sigue el modo claro/oscuro del sistema operativo.
        </span>
      </div>

      <div class="agx-field">
        <label>Navegación</label>
        <Select
          label="Navegación"
          value={draft.navigation}
          options={navOptions}
          onChange={(next: NavigationMode) => setField("navigation", next)}
        />
        <span class="fx-secondary">
          Solo aparecen secciones que ya están implementadas.
        </span>
      </div>

      <div class="agx-field">
        <label>Vista de sesiones predeterminada</label>
        <Select
          label="Vista de sesiones"
          value={draft.sessionView}
          options={viewOptions}
          onChange={(next: SessionViewMode) => setField("sessionView", next)}
        />
      </div>

      <div class="agx-field">
        <label>Animaciones</label>
        <Select
          label="Animaciones"
          value={draft.animations}
          options={animationOptions}
          onChange={(next: AnimationPreference) => setField("animations", next)}
        />
        <span class="fx-secondary">
          Respeta “Reducir movimiento” del sistema cuando corresponde.
        </span>
      </div>

      <div class="agx-field">
        <label>Tamaño de texto</label>
        <Select
          label="Tamaño de texto"
          value={String(draft.textScale)}
          options={TEXT_SCALES.map((s) => ({ value: String(s), label: `${s}%` }))}
          onChange={(next) => setField("textScale", Number(next) as 100 | 110 | 120 | 130)}
        />
        <span class="fx-secondary">Aumenta el texto base de toda la interfaz.</span>
      </div>

      <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
        <Button variant="secondary" small onClick={onClose}>
          Cancelar
        </Button>
        <Button variant="primary" small onClick={handleSave}>
          Guardar
        </Button>
      </div>
    </section>
  );
};
