import type { ComponentChildren } from "preact";

interface ToggleProps {
  checked: boolean;
  onChange(next: boolean): void;
  label: string;
  description?: ComponentChildren;
  disabled?: boolean;
  id?: string;
  describedBy?: string;
}

/** On/off switch: `<button role="switch">`, so Space and Enter work and screen readers announce the state. */
export const Switch = ({
  checked,
  onChange,
  label,
  description,
  disabled,
  id,
  describedBy,
}: ToggleProps) => (
  <button
    type="button"
    id={id}
    role="switch"
    class="fx-toggle"
    aria-checked={checked}
    aria-describedby={describedBy}
    disabled={disabled}
    onClick={() => onChange(!checked)}
  >
    <span class="fx-toggle__text">
      <span class="fx-toggle__label">{label}</span>
      {description && <span class="fx-secondary">{description}</span>}
    </span>
    <span class="fx-switch" aria-hidden="true" />
  </button>
);

/** A checkbox that is not a native `<input type=checkbox>`: `<button role="checkbox">`. */
export const Checkbox = ({
  checked,
  onChange,
  label,
  description,
  disabled,
  id,
  describedBy,
}: ToggleProps) => (
  <button
    type="button"
    id={id}
    role="checkbox"
    class="fx-toggle"
    aria-checked={checked}
    aria-describedby={describedBy}
    disabled={disabled}
    onClick={() => onChange(!checked)}
  >
    <span class="fx-check" aria-hidden="true">
      <svg
        viewBox="0 0 14 14"
        fill="none"
        stroke-width="2.4"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M2.5 7.5l3 3 6-7" />
      </svg>
    </span>
    <span class="fx-toggle__text">
      <span class="fx-toggle__label">{label}</span>
      {description && <span class="fx-secondary">{description}</span>}
    </span>
  </button>
);

/** Just the switch, for rows that lay out their own text. `label` is its accessible name. */
export const SwitchControl = ({
  checked,
  onChange,
  label,
  disabled,
  id,
}: {
  checked: boolean;
  onChange(next: boolean): void;
  label: string;
  disabled?: boolean;
  id?: string;
}) => (
  <button
    type="button"
    id={id}
    role="switch"
    class="fx-toggle fx-toggle--bare"
    aria-checked={checked}
    aria-label={label}
    disabled={disabled}
    onClick={() => onChange(!checked)}
  >
    <span class="fx-switch" aria-hidden="true" />
  </button>
);
