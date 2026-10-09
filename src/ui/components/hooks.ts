import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { RefObject } from 'preact';

let counter = 0;

/** A stable unique id per component instance, for aria-labelledby / aria-controls / aria-describedby. */
export function useUid(prefix = 'fx'): string {
  const ref = useRef<string>('');
  if (ref.current === '') ref.current = `${prefix}-${++counter}`;
  return ref.current;
}

/** Calls `onOutside` for pointer presses outside every given element while `active`. */
export function useOutsidePress(refs: ReadonlyArray<RefObject<HTMLElement | null>>, onOutside: () => void, active: boolean): void {
  const handler = useRef(onOutside);
  handler.current = onOutside;
  useEffect(() => {
    if (!active) return;
    const listener = (event: Event) => {
      const target = event.target as Node | null;
      if (target && refs.some((r) => r.current?.contains(target))) return;
      handler.current();
    };
    document.addEventListener('pointerdown', listener, true);
    return () => document.removeEventListener('pointerdown', listener, true);
  }, [active]);
}

export interface PopoverPlacement {
  left: number;
  top: number;
  minWidth: number;
  maxHeight: number;
}

/**
 * Fixed positioning for menus and listboxes: below the trigger when there is room, above it otherwise, clamped to the
 * viewport. `position: fixed` keeps the popover from being clipped by scrolling containers.
 */
export function usePopoverPlacement(
  trigger: RefObject<HTMLElement | null>,
  popover: RefObject<HTMLElement | null>,
  open: boolean,
  align: 'start' | 'end' = 'start',
  matchWidth = false,
): PopoverPlacement | null {
  const [placement, setPlacement] = useState<PopoverPlacement | null>(null);
  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }
    const compute = () => {
      const t = trigger.current;
      const p = popover.current;
      if (!t || !p) return;
      const rect = t.getBoundingClientRect();
      const margin = 8;
      const naturalHeight = p.scrollHeight;
      const width = Math.max(p.offsetWidth, matchWidth ? rect.width : 0);
      const below = window.innerHeight - rect.bottom - margin;
      const above = rect.top - margin;
      const openUp = naturalHeight > below && above > below;
      const maxHeight = Math.max(120, openUp ? above : below);
      const height = Math.min(naturalHeight, maxHeight);
      let left = align === 'end' ? rect.right - width : rect.left;
      left = Math.min(Math.max(margin, left), Math.max(margin, window.innerWidth - width - margin));
      const top = openUp ? Math.max(margin, rect.top - height - 4) : rect.bottom + 4;
      setPlacement({ left, top, minWidth: matchWidth ? rect.width : 0, maxHeight });
    };
    compute();
    window.addEventListener('resize', compute);
    window.addEventListener('scroll', compute, true);
    return () => {
      window.removeEventListener('resize', compute);
      window.removeEventListener('scroll', compute, true);
    };
  }, [open, align, matchWidth]);
  return placement;
}

/** Type-ahead for menus and listboxes: returns the index of the next label starting with the typed text. */
export function useTypeahead(labels: readonly string[], current: number): (key: string) => number {
  const buffer = useRef('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  return (key: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => (buffer.current = ''), 600);
    buffer.current += key.toLowerCase();
    const text = buffer.current;
    const order = [...labels.keys()];
    const rotated = text.length === 1 ? [...order.slice(current + 1), ...order.slice(0, current + 1)] : [...order.slice(current), ...order.slice(0, current)];
    return rotated.find((i) => labels[i]!.toLowerCase().startsWith(text)) ?? -1;
  };
}
