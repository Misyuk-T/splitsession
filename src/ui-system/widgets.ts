/**
 * Dashboard widget layout (AEGOX_multisession, Module 04).
 *
 * The layout is a small, validated list. Widgets only read real module data;
 * customization can move, resize, hide or remove optional widgets, but the
 * security-notices widget is locked so warnings can never be hidden forever.
 */

export const WIDGET_IDS = [
  "overview",
  "quick-actions",
  "session-breakdown",
  "profile-overview",
  "recent-activity",
  "favorites",
  "statistics",
  "security-notices",
] as const;

export type WidgetId = (typeof WIDGET_IDS)[number];
export type WidgetSize = "small" | "medium" | "large";

export interface WidgetLayoutItem {
  id: WidgetId;
  visible: boolean;
  /** Position in the dashboard, lower comes first. */
  order: number;
  size: WidgetSize;
}

export interface WidgetDefinition {
  id: WidgetId;
  title: string;
  description: string;
  /** Locked widgets cannot be removed or hidden. */
  locked: boolean;
  defaultSize: WidgetSize;
  /** Default column span in the dashboard grid. */
  defaultSpan: 1 | 2 | 3;
}

export const WIDGET_CATALOG: Readonly<Record<WidgetId, WidgetDefinition>> = {
  overview: {
    id: "overview",
    title: "Overview",
    description: "Session and profile totals from the real stores.",
    locked: true,
    defaultSize: "large",
    defaultSpan: 2,
  },
  "quick-actions": {
    id: "quick-actions",
    title: "Quick actions",
    description: "Create a profile or session, open views and search.",
    locked: false,
    defaultSize: "small",
    defaultSpan: 1,
  },
  "session-breakdown": {
    id: "session-breakdown",
    title: "Session states",
    description: "How many sessions are active, paused, expired or archived.",
    locked: false,
    defaultSize: "medium",
    defaultSpan: 1,
  },
  "profile-overview": {
    id: "profile-overview",
    title: "Profiles",
    description: "Profiles with their real session counts.",
    locked: false,
    defaultSize: "medium",
    defaultSpan: 2,
  },
  "recent-activity": {
    id: "recent-activity",
    title: "Recent activity",
    description: "Latest session and profile timestamps, newest first.",
    locked: false,
    defaultSize: "medium",
    defaultSpan: 1,
  },
  favorites: {
    id: "favorites",
    title: "Favorites",
    description: "Pinned profiles and sessions.",
    locked: false,
    defaultSize: "small",
    defaultSpan: 1,
  },
  statistics: {
    id: "statistics",
    title: "Statistics",
    description: "Aggregates from Profile Manager's optional statistics store.",
    locked: false,
    defaultSize: "medium",
    defaultSpan: 2,
  },
  "security-notices": {
    id: "security-notices",
    title: "Security notices",
    description: "Expired sessions and profiles that need attention.",
    locked: true,
    defaultSize: "medium",
    defaultSpan: 1,
  },
};

export const WIDGET_SIZES: ReadonlyArray<WidgetSize> = ["small", "medium", "large"];

export const DEFAULT_WIDGET_LAYOUT: ReadonlyArray<WidgetLayoutItem> = WIDGET_IDS.map(
  (id, index) => ({
    id,
    visible: id !== "statistics",
    order: index,
    size: WIDGET_CATALOG[id].defaultSize,
  }),
);

function isWidgetId(value: unknown): value is WidgetId {
  return typeof value === "string" && (WIDGET_IDS as ReadonlyArray<string>).includes(value);
}

function isSize(value: unknown): value is WidgetSize {
  return typeof value === "string" && (WIDGET_SIZES as ReadonlyArray<string>).includes(value);
}

function sortLayout(items: WidgetLayoutItem[]): WidgetLayoutItem[] {
  return items
    .slice()
    .sort((a, b) => a.order - b.order || WIDGET_IDS.indexOf(a.id) - WIDGET_IDS.indexOf(b.id))
    .map((item, index) => ({ ...item, order: index }));
}

/**
 * Validates a stored layout: unknown widgets are dropped, duplicates keep the
 * first entry, every known widget appears exactly once, locked widgets become
 * visible, and order is compacted to 0..n-1.
 */
export function normalizeWidgetLayout(raw: unknown): WidgetLayoutItem[] {
  const byId = new Map<WidgetId, WidgetLayoutItem>();
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      if (!isWidgetId(record.id) || byId.has(record.id)) continue;
      const definition = WIDGET_CATALOG[record.id];
      byId.set(record.id, {
        id: record.id,
        visible:
          definition.locked || typeof record.visible !== "boolean"
            ? definition.locked
              ? true
              : record.visible !== false
            : record.visible,
        order: typeof record.order === "number" && Number.isFinite(record.order)
          ? Math.round(record.order)
          : Number.MAX_SAFE_INTEGER,
        size: isSize(record.size) ? record.size : definition.defaultSize,
      });
    }
  }
  for (const definition of Object.values(WIDGET_CATALOG)) {
    if (!byId.has(definition.id)) {
      const fallback = DEFAULT_WIDGET_LAYOUT.find((item) => item.id === definition.id);
      byId.set(definition.id, {
        id: definition.id,
        visible: fallback?.visible ?? true,
        order: fallback?.order ?? Number.MAX_SAFE_INTEGER,
        size: fallback?.size ?? definition.defaultSize,
      });
    }
  }
  return sortLayout([...byId.values()]);
}

/** Visible widgets in display order. Locked widgets are always included. */
export function visibleWidgets(layout: ReadonlyArray<WidgetLayoutItem>): WidgetLayoutItem[] {
  return normalizeWidgetLayout(layout).filter(
    (item) => item.visible || WIDGET_CATALOG[item.id].locked,
  );
}

/** Adds a widget that was removed, or makes it visible again. */
export function addWidget(
  layout: ReadonlyArray<WidgetLayoutItem>,
  id: WidgetId,
): WidgetLayoutItem[] {
  const normalized = normalizeWidgetLayout(layout);
  return normalized.map((item) =>
    item.id === id ? { ...item, visible: true } : item,
  );
}

/**
 * Removes a widget from the visible board. Locked widgets are ignored rather
 * than throwing so a stale stored layout can never break the dashboard.
 */
export function removeWidget(
  layout: ReadonlyArray<WidgetLayoutItem>,
  id: WidgetId,
): WidgetLayoutItem[] {
  if (WIDGET_CATALOG[id].locked) return normalizeWidgetLayout(layout);
  return normalizeWidgetLayout(layout).map((item) =>
    item.id === id ? { ...item, visible: false } : item,
  );
}

/** Shows or hides a widget; locked widgets always stay visible. */
export function setWidgetVisible(
  layout: ReadonlyArray<WidgetLayoutItem>,
  id: WidgetId,
  visible: boolean,
): WidgetLayoutItem[] {
  if (WIDGET_CATALOG[id].locked) visible = true;
  return normalizeWidgetLayout(layout).map((item) =>
    item.id === id ? { ...item, visible } : item,
  );
}

/** Moves a widget one position up (-1) or down (+1). */
export function moveWidget(
  layout: ReadonlyArray<WidgetLayoutItem>,
  id: WidgetId,
  direction: -1 | 1,
): WidgetLayoutItem[] {
  const items = normalizeWidgetLayout(layout);
  const index = items.findIndex((item) => item.id === id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= items.length) return items;
  const [moved] = items.splice(index, 1);
  if (!moved) return items;
  items.splice(target, 0, moved);
  return items.map((item, order) => ({ ...item, order }));
}

/** Resizes a widget within the supported sizes. */
export function resizeWidget(
  layout: ReadonlyArray<WidgetLayoutItem>,
  id: WidgetId,
  size: WidgetSize,
): WidgetLayoutItem[] {
  return normalizeWidgetLayout(layout).map((item) =>
    item.id === id ? { ...item, size } : item,
  );
}

/** Restores the documented default layout. */
export function resetWidgetLayout(): WidgetLayoutItem[] {
  return DEFAULT_WIDGET_LAYOUT.map((item) => ({ ...item }));
}

/** Number of grid columns a widget occupies in the dashboard. */
export function widgetSpan(item: WidgetLayoutItem): 1 | 2 | 3 {
  if (item.size === "large") return 3;
  if (item.size === "medium") return 2;
  return 1;
}
