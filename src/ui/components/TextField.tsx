import { useRef } from "preact/hooks";

import { useUid } from "./hooks";

interface TextFieldProps {
  label: string;
  value: string;
  onValue(next: string): void;
  /** Applied to every edit before it is stored (drop control characters, cap the length...). */
  sanitize?(raw: string): string;
  /** Inline message shown under the field (also announced to screen readers). */
  error?: string | null;
  hint?: string;
  /** Shows a "n/max" counter. */
  max?: number;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  onEnter?(): void;
  onEscape?(): void;
  onBlur?(): void;
  /** Visually hide the label (it stays for assistive technology). */
  hideLabel?: boolean;
  inputMode?: "text" | "url" | "search";
  name?: string;
  /** DOM id of the input (default: generated). */
  id?: string;
}

/** Text input with a label, live inline validation message, optional counter. Never uses the browser's validation bubble. */
export const TextField = (props: TextFieldProps) => {
  const {
    label,
    value,
    onValue,
    sanitize,
    error,
    hint,
    max,
    placeholder,
    autoFocus,
    disabled,
    onEnter,
    onEscape,
    onBlur,
    hideLabel,
    inputMode,
    name,
    id,
  } = props;
  const generated = useUid("field");
  const uid = id ?? generated;
  const messageId = `${uid}-msg`;
  const inputRef = useRef<HTMLInputElement>(null);
  const count = Array.from(value).length;
  return (
    <div class="fx-field">
      {/* eslint-disable-next-line jsx-a11y/label-has-associated-control -- the label is tied to the input by `for` (Preact spelling of htmlFor) */}
      <label class={hideLabel ? "fx-sr-only" : "fx-field__label"} for={uid}>
        {label}
      </label>
      <div class="fx-field__row">
        <input
          ref={inputRef}
          id={uid}
          name={name}
          class="fx-input"
          type="text"
          inputMode={inputMode}
          autoComplete="off"
          autoCapitalize="off"
          spellcheck={false}
          // eslint-disable-next-line jsx-a11y/no-autofocus -- opt-in prop, set only by dialogs that open on their text field
          autoFocus={autoFocus}
          disabled={disabled}
          placeholder={placeholder}
          value={value}
          maxLength={max !== undefined ? max * 2 : undefined}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={messageId}
          onInput={(event) => {
            const input = event.currentTarget;
            const clean = sanitize ? sanitize(input.value) : input.value;
            if (clean !== input.value) input.value = clean; // keep the box in step with what we accepted
            onValue(clean);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && onEnter) {
              event.preventDefault();
              onEnter();
            } else if (event.key === "Escape" && onEscape) {
              event.preventDefault();
              event.stopPropagation();
              onEscape();
            }
          }}
          onBlur={onBlur}
        />
      </div>
      <div class="fx-field__meta" id={messageId} aria-live="polite">
        {error ? (
          <span class="fx-field__error">{error}</span>
        ) : hint ? (
          <span class="fx-field__hint">{hint}</span>
        ) : (
          <span />
        )}
        {max !== undefined && (
          <span class="fx-field__count" aria-hidden="true">
            {count}/{max}
          </span>
        )}
      </div>
    </div>
  );
};
