import type { RefObject } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";

let counter = 0;

/** A stable unique id per component instance, for aria-labelledby / aria-controls / aria-describedby. */
export function useUid(prefix = "fx"): string {
  const ref = useRef<string>("");
  if (ref.current === "") ref.current = `${prefix}-${++counter}`;
  return ref.current;
}

/** Calls `onOutside` for pointer presses outside every given element while `active`. */
export function useOutsidePress(
  refs: ReadonlyArray<RefObject<HTMLElement | null>>,
  onOutside: () => void,
  active: boolean,
): void {
  const handler = useRef(onOutside);
  handler.current = onOutside;
  useEffect(() => {
    if (!active) return;
    const listener = (event: Event) => {
      const target = event.target as Node | null;
      if (target && refs.some((r) => r.current?.contains(target))) return;
      handler.current();
    };
    document.addEventListener("pointerdown", listener, true);
    return () => document.removeEventListener("pointerdown", listener, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `refs` is a fresh array each render and its members are stable ref objects; the listener only needs re-binding when `active` flips
  }, [active]);
}

export interface PopoverPlacement {
  left: number;
  top: number;
  minWidth: number;
  /** 0 = the popover fits whole, no limit (and no inner scrollbar); otherwise the most it can take before it scrolls. */
  maxHeight: number;
}

/** Set on <html> while a popover that opens downwards needs the extension popup to be taller (read by popup.css). */
const GROW_VAR = "--fx-menu-min";

/**
 * Fixed positioning for menus and listboxes: below the trigger when it fits, above it when that fits better, clamped
 * to the viewport. `position: fixed` keeps the popover from being clipped by scrolling containers.
 *
 * A browser-action popup is as tall as its content (up to a cap), so a short popup has no room for a menu below its
 * last row. A page that declares that cap (`--fx-popup-max` on <html>, popup.css) gets room made instead: the minimum
 * height `--fx-menu-min` is set in the same layout pass that places the menu, i.e. before the menu is first painted,
 * and removed when it closes. Placement never depends on the current window height in that case, so the window
 * growing does not move the menu.
 */
export function usePopoverPlacement(
  trigger: RefObject<HTMLElement | null>,
  popover: RefObject<HTMLElement | null>,
  open: boolean,
  align: "start" | "end" = "start",
  matchWidth = false,
): PopoverPlacement | null {
  const [placement, setPlacement] = useState<PopoverPlacement | null>(null);
  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }
    const root = document.documentElement;
    const compute = () => {
      const t = trigger.current;
      const p = popover.current;
      if (!t || !p) return;
      const rect = t.getBoundingClientRect();
      const margin = 8;
      const gap = 4;
      const cap =
        parseFloat(getComputedStyle(root).getPropertyValue("--fx-popup-max")) ||
        0;
      const viewport =
        cap > 0 ? Math.max(cap, window.innerHeight) : window.innerHeight;
      const border = p.offsetHeight - p.clientHeight;
      const natural = Math.ceil(p.scrollHeight + border);
      const width = Math.max(p.offsetWidth, matchWidth ? rect.width : 0);
      const below = viewport - rect.bottom - gap - margin;
      const above = rect.top - gap - margin;
      const openUp = natural > below && above > below;
      const room = Math.max(120, openUp ? above : below);
      const fits = natural <= room;
      const height = fits ? natural : room;
      let left = align === "end" ? rect.right - width : rect.left;
      left = Math.min(
        Math.max(margin, left),
        Math.max(margin, window.innerWidth - width - margin),
      );
      const top = openUp
        ? Math.max(margin, rect.top - height - gap)
        : rect.bottom + gap;
      if (cap > 0 && !openUp)
        root.style.setProperty(
          GROW_VAR,
          `${Math.min(cap, Math.ceil(top + height + margin))}px`,
        );
      else root.style.removeProperty(GROW_VAR);
      setPlacement((old) =>
        old &&
        old.left === left &&
        old.top === top &&
        old.minWidth === (matchWidth ? rect.width : 0) &&
        old.maxHeight === (fits ? 0 : room)
          ? old
          : {
              left,
              top,
              minWidth: matchWidth ? rect.width : 0,
              maxHeight: fits ? 0 : room,
            },
      );
    };
    compute();
    window.addEventListener("resize", compute);
    window.addEventListener("scroll", compute, true);
    return () => {
      window.removeEventListener("resize", compute);
      window.removeEventListener("scroll", compute, true);
      root.style.removeProperty(GROW_VAR);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `trigger` and `popover` are stable ref objects
  }, [open, align, matchWidth]);
  return placement;
}

/** Type-ahead for menus and listboxes: returns the index of the next label starting with the typed text. */
export function useTypeahead(
  labels: readonly string[],
  current: number,
): (key: string) => number {
  const buffer = useRef("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  return (key: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => (buffer.current = ""), 600);
    buffer.current += key.toLowerCase();
    const text = buffer.current;
    const order = [...labels.keys()];
    const rotated =
      text.length === 1
        ? [...order.slice(current + 1), ...order.slice(0, current + 1)]
        : [...order.slice(current), ...order.slice(0, current)];
    return rotated.find((i) => labels[i]!.toLowerCase().startsWith(text)) ?? -1;
  };
}
