import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { IconChevron } from '../icons';

interface DisclosureProps {
  /** The id of the panel (what `aria-controls` points at). */
  id: string;
  title: string;
  children: ComponentChildren;
  testId?: string;
  /** An id for the toggle button, so a link like `#transfer` can find it, open it and focus it. */
  toggleId?: string;
  /** Controlled use: the parent owns the state and hears every change. Leave out for a self-contained disclosure. */
  open?: boolean;
  onToggle?(open: boolean): void;
}

/** A disclosure: a custom button with `aria-expanded` (not a native `<details>`) and the panel it opens. */
export function Disclosure({ id, title, children, testId, toggleId, open: controlled, onToggle }: DisclosureProps) {
  const [own, setOwn] = useState(false);
  const open = controlled ?? own;
  const toggle = () => {
    setOwn(!open);
    onToggle?.(!open);
  };
  return (
    <div class="fx-why fx-disclosure" data-testid={testId}>
      <button type="button" id={toggleId} class="fx-why__toggle fx-disclosure__toggle" aria-expanded={open} aria-controls={id} onClick={toggle}>
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
