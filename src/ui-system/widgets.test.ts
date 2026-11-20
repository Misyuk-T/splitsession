import { describe, expect, it } from "vitest";

import {
  DEFAULT_WIDGET_LAYOUT,
  WIDGET_CATALOG,
  WIDGET_IDS,
  addWidget,
  moveWidget,
  normalizeWidgetLayout,
  removeWidget,
  resetWidgetLayout,
  resizeWidget,
  setWidgetVisible,
  visibleWidgets,
  widgetSpan,
} from "./widgets";

describe("widget layout", () => {
  it("offers a default layout containing every widget exactly once", () => {
    const layout = normalizeWidgetLayout(DEFAULT_WIDGET_LAYOUT);
    expect(layout).toHaveLength(WIDGET_IDS.length);
    expect(new Set(layout.map((item) => item.id)).size).toBe(WIDGET_IDS.length);
    expect(layout.map((item) => item.order)).toEqual(layout.map((_, index) => index));
  });

  it("drops unknown widgets and duplicates", () => {
    const layout = normalizeWidgetLayout([
      { id: "overview", visible: true, order: 0, size: "large" },
      { id: "overview", visible: false, order: 1, size: "small" },
      { id: "future-module", visible: true, order: 2, size: "small" },
    ]);
    expect(layout.filter((item) => item.id === "overview")).toHaveLength(1);
    expect(layout).toHaveLength(WIDGET_IDS.length);
  });

  it("rebuilds missing widgets from defaults", () => {
    const layout = normalizeWidgetLayout([]);
    expect(layout).toHaveLength(WIDGET_IDS.length);
    expect(layout.every((item) => item.order >= 0)).toBe(true);
  });

  it("keeps locked widgets visible even from stored data", () => {
    const layout = normalizeWidgetLayout([
      { id: "security-notices", visible: false, order: 0, size: "small" },
      { id: "overview", visible: false, order: 1, size: "small" },
    ]);
    const security = layout.find((item) => item.id === "security-notices");
    expect(security?.visible).toBe(true);
    expect(visibleWidgets(layout).some((item) => item.id === "security-notices")).toBe(true);
  });

  it("never removes a locked widget", () => {
    const layout = removeWidget(DEFAULT_WIDGET_LAYOUT, "security-notices");
    expect(layout.find((item) => item.id === "security-notices")?.visible).toBe(true);
  });

  it("hides, shows and re-adds optional widgets", () => {
    const hidden = setWidgetVisible(DEFAULT_WIDGET_LAYOUT, "favorites", false);
    expect(hidden.find((item) => item.id === "favorites")?.visible).toBe(false);
    expect(visibleWidgets(hidden).some((item) => item.id === "favorites")).toBe(false);

    const shown = addWidget(hidden, "favorites");
    expect(shown.find((item) => item.id === "favorites")?.visible).toBe(true);
  });

  it("moves widgets in both directions and compacts order", () => {
    const moved = moveWidget(DEFAULT_WIDGET_LAYOUT, "quick-actions", -1);
    expect(moved[0]?.id).toBe("quick-actions");
    expect(moved.map((item) => item.order)).toEqual(moved.map((_, index) => index));

    const back = moveWidget(moved, "quick-actions", 1);
    expect(back[0]?.id).toBe("overview");
  });

  it("ignores moves outside the list", () => {
    const first = normalizeWidgetLayout(DEFAULT_WIDGET_LAYOUT)[0]!.id;
    expect(moveWidget(DEFAULT_WIDGET_LAYOUT, first, -1)).toEqual(
      normalizeWidgetLayout(DEFAULT_WIDGET_LAYOUT),
    );
    const last = normalizeWidgetLayout(DEFAULT_WIDGET_LAYOUT).at(-1)!.id;
    expect(moveWidget(DEFAULT_WIDGET_LAYOUT, last, 1)).toEqual(
      normalizeWidgetLayout(DEFAULT_WIDGET_LAYOUT),
    );
  });

  it("resizes widgets and computes their grid span", () => {
    const resized = resizeWidget(DEFAULT_WIDGET_LAYOUT, "overview", "small");
    const item = resized.find((entry) => entry.id === "overview")!;
    expect(item.size).toBe("small");
    expect(widgetSpan(item)).toBe(1);
    expect(widgetSpan({ ...item, size: "medium" })).toBe(2);
    expect(widgetSpan({ ...item, size: "large" })).toBe(3);
  });

  it("resets to the documented default layout", () => {
    const custom = setWidgetVisible(DEFAULT_WIDGET_LAYOUT, "recent-activity", false);
    expect(resetWidgetLayout()).toEqual(normalizeWidgetLayout(DEFAULT_WIDGET_LAYOUT));
    expect(custom.find((item) => item.id === "recent-activity")?.visible).toBe(false);
  });

  it("marks only core and security widgets as locked", () => {
    const locked = Object.values(WIDGET_CATALOG).filter((definition) => definition.locked);
    expect(locked.map((definition) => definition.id).sort()).toEqual([
      "overview",
      "security-notices",
    ]);
  });
});
