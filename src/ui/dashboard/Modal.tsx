import { useEffect, useRef } from "preact/hooks";

import { IconClose } from "./Icons";

interface ModalProps {
  title: string;
  description?: string;
  onClose: () => void;
  children: preact.ComponentChildren;
  footer?: preact.ComponentChildren;
  /** Wider dialog for forms and settings. */
  wide?: boolean;
}

/**
 * Accessible modal: labelled by its heading, Escape closes, focus moves inside
 * on open and Tab cycles within the dialog.
 */
export const Modal = ({ title, description, onClose, children, footer, wide }: ModalProps) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const headingId = useRef(`agx-modal-${Math.random().toString(36).slice(2, 8)}`);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const previous = document.activeElement as HTMLElement | null;
    const focusable = () =>
      Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.offsetParent !== null);
    focusable()[0]?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, [onClose]);

  return (
    <div class="agx-overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        ref={panelRef}
        class={`agx-modal${wide ? " agx-modal--wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId.current}
        aria-describedby={description ? `${headingId.current}-desc` : undefined}
      >
        <div class="agx-modal__head">
          <div>
            <h2 id={headingId.current}>{title}</h2>
            {description && (
              <p id={`${headingId.current}-desc`} class="agx-muted">
                {description}
              </p>
            )}
          </div>
          <button type="button" class="agx-icon-btn" aria-label="Close dialog" onClick={onClose}>
            <IconClose />
          </button>
        </div>
        <div class="agx-modal__body">{children}</div>
        {footer && <div class="agx-modal__foot">{footer}</div>}
      </div>
    </div>
  );
};
