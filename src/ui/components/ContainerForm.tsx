import { useState } from "preact/hooks";

import {
  checkContainerName,
  CONTAINER_COLORS,
  type ContainerColor,
  MAX_CONTAINER_NAME,
  sanitizeNameInput,
} from "../../core";
import { Button } from "./Button";
import { ColorPicker } from "./ColorPicker";
import { TextField } from "./TextField";

interface ContainerFormProps {
  /** Names of all containers, for the duplicate check. */
  existingNames: readonly string[];
  /** Present when editing: the container's own name and colour. */
  initial?: { name: string; color: ContainerColor };
  /** Colour preselected for a new container. */
  defaultColor?: ContainerColor;
  submitLabel: string;
  onSubmit(value: {
    name: string;
    color: ContainerColor;
  }): Promise<void> | void;
  onCancel(): void;
}

/** Name + colour, validated while typing (empty, too long, duplicate), used to create and to edit a container. */
export const ContainerForm = ({
  existingNames,
  initial,
  defaultColor,
  submitLabel,
  onSubmit,
  onCancel,
}: ContainerFormProps) => {
  const [name, setName] = useState(initial?.name ?? "");
  const [color, setColor] = useState<ContainerColor>(
    initial?.color ?? defaultColor ?? CONTAINER_COLORS[0]!,
  );
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const check = checkContainerName(name, existingNames, initial?.name);
  // Typing something wrong is reported at once; an empty box is only reported after the user has been in it.
  const message =
    !check.ok && (name.trim() !== "" || touched) ? check.message : null;

  const submit = async () => {
    setTouched(true);
    if (!check.ok || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      await onSubmit({ name: check.name, color });
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  };

  return (
    <form
      class="fx-cform"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <TextField
        label="Name"
        value={name}
        onValue={setName}
        sanitize={(raw) => sanitizeNameInput(raw)}
        error={message}
        hint="For example Work, Personal or Client A."
        max={MAX_CONTAINER_NAME}
        placeholder="Container name"
        autoFocus
        onBlur={() => setTouched(true)}
        onEscape={onCancel}
      />
      <div class="fx-cform__colors">
        <span class="fx-field__label" id="cform-color-label">
          Colour
        </span>
        <ColorPicker
          value={color}
          onChange={setColor}
          label="Container colour"
        />
      </div>
      {failure && (
        <p class="fx-notice fx-notice--error" role="alert">
          {failure}
        </p>
      )}
      <div class="fx-cform__actions">
        <Button onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={!check.ok || busy}
          aria-disabled={!check.ok || busy}
        >
          {submitLabel}
        </Button>
      </div>
    </form>
  );
};
