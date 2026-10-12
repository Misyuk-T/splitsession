import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { IconChevron } from '../icons';

/** A disclosure: a custom button with `aria-expanded` (not a native `<details>`) and the panel it opens. */
export function Disclosure({ id, title, children, testId }: { id: string; title: string; children: ComponentChildren; testId?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div class="fx-why fx-disclosure" data-testid={testId}>
      <button type="button" class="fx-why__toggle fx-disclosure__toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <span>{title}</span>
        <span class={`fx-why__chevron${open ? ' fx-why__chevron--open' : ''}`} aria-hidden="true">
          <IconChevron />
        </span>
      </button>
      {open && (
        <div id={id} class="fx-disclosure__body">
          {children}
        </div>
      )}
    </div>
  );
}
