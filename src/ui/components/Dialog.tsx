import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";

import { Button } from "./Button";
import { useUid } from "./hooks";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"]), textarea:not([disabled])';

interface DialogProps {
  title: string;
  children: ComponentChildren;
  /** Esc, a click on the backdrop and the Cancel button call this. */
  onClose(): void;
  actions: ComponentChildren;
  /** `alertdialog` for confirmations that need an answer. */
  role?: "dialog" | "alertdialog";
}

/**
 * Modal dialog: focus moves in (to the element marked `data-autofocus`, else the first control), Tab cycles inside,
 * Esc closes, focus returns to what had it before. Replaces alert/confirm/prompt.
 */
export const Dialog = ({
  title,
  children,
  onClose,
  actions,
  role = "dialog",
}: DialogProps) => {
  const uid = useUid("dialog");
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const root = box.current;
    const first =
      root?.querySelector<HTMLElement>("[data-autofocus]") ??
      root?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    return () => {
      if (previous && document.contains(previous)) previous.focus();
    };
  }, []);

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- a click on the backdrop closes the dialog; Escape is the keyboard route (handled on the dialog)
    <div
      class="fx-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close.current();
      }}
    >
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- keydown here only traps Tab and handles Escape for the dialog */}
      <div
        ref={box}
        class="fx-dialog"
        role={role}
        aria-modal="true"
        aria-labelledby={`${uid}-title`}
        aria-describedby={`${uid}-body`}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            close.current();
          } else if (event.key === "Tab") {
            const items = [
              ...(box.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []),
            ];
            if (items.length === 0) return;
            const firstItem = items[0]!;
            const lastItem = items[items.length - 1]!;
            if (event.shiftKey && document.activeElement === firstItem) {
              event.preventDefault();
              lastItem.focus();
            } else if (!event.shiftKey && document.activeElement === lastItem) {
              event.preventDefault();
              firstItem.focus();
            }
          }
        }}
      >
        <h2 class="fx-dialog__title" id={`${uid}-title`}>
          {title}
        </h2>
        <div class="fx-dialog__body" id={`${uid}-body`}>
          {children}
        </div>
        <div class="fx-dialog__actions">{actions}</div>
      </div>
    </div>
  );
};

interface ConfirmProps {
  title: string;
  children: ComponentChildren;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm(): void;
  onCancel(): void;
}

/** Confirmation with the safe answer focused first. */
export const ConfirmDialog = ({
  title,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  danger,
  busy,
  onConfirm,
  onCancel,
}: ConfirmProps) => (
  <Dialog
    title={title}
    role="alertdialog"
    onClose={onCancel}
    actions={
      <>
        <Button data-autofocus onClick={onCancel} disabled={busy}>
          {cancelLabel}
        </Button>
        <Button
          variant={danger ? "danger" : "primary"}
          onClick={onConfirm}
          disabled={busy}
        >
          {confirmLabel}
        </Button>
      </>
    }
  >
    {children}
  </Dialog>
);
