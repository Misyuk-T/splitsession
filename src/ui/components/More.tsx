import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { IconChevron } from '../icons';

/**
 * A small "More" link under a setting: a custom button with `aria-expanded` (not a native `<details>`) and the longer
 * explanation it opens. `about` makes the accessible name unique when a page has several of them.
 */
export function More({ id, title = 'More', about, children }: { id: string; title?: string; about?: string; children: ComponentChildren }) {
  const [open, setOpen] = useState(false);
  return (
    <div class="fx-why fx-more">
      <button type="button" class="fx-why__toggle" aria-expanded={open} aria-controls={id} aria-label={about ? `${title}: ${about}` : undefined} onClick={() => setOpen(!open)}>
        <span>{title}</span>
        <span class={`fx-why__chevron${open ? ' fx-why__chevron--open' : ''}`} aria-hidden="true">
          <IconChevron />
        </span>
      </button>
      {open && (
        <div id={id} class="fx-why__body fx-secondary">
          {children}
        </div>
      )}
    </div>
  );
}
