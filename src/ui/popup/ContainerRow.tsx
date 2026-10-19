import type { ContainerInfo } from "../../background/facet";
import { CONTAINER_HEX, type ContainerColor } from "../../core";
import { Button, Dot } from "../components/Button";
import { ContainerForm } from "../components/ContainerForm";
import { plural, tabsLabel } from "../format";
import { IconMoveIn, IconPencil, IconPlus, IconTrash } from "../icons";
import { rowId } from "./ids";

/**
 * One container: its main button (go to its tabs, or open one), and the row icons (new tab, move this tab in, edit,
 * delete). While edited, the row is the edit form (the same list item, so focus and layout stay put).
 */
export const ContainerRow = ({
  container: c,
  editing,
  isCurrent,
  canMoveHere,
  names,
  onGo,
  onNewTab,
  onMoveHere,
  onEdit,
  onDelete,
  onCancelEdit,
  onSave,
  onForgetSaved,
}: {
  container: ContainerInfo;
  editing: boolean;
  /** The current tab is in this container. */
  isCurrent: boolean;
  /** The current tab is a web page outside this container. */
  canMoveHere: boolean;
  names: string[];
  onGo(): void;
  onNewTab(): void;
  onMoveHere(): void;
  onEdit(): void;
  onDelete(): void;
  onCancelEdit(): void;
  onSave(value: { name: string; color: ContainerColor }): Promise<void>;
  /** Forget the saved tabs (offered in the edit form while the container has some). */
  onForgetSaved(): void;
}) => {
  // No open tab and some saved: a click brings them back.
  const reopening = c.tabCount === 0 && c.savedCount > 0;
  return editing ? (
    <li class="popup__row popup__row--editing">
      <ContainerForm
        existingNames={names}
        initial={{ name: c.name, color: c.color }}
        submitLabel="Save"
        onCancel={onCancelEdit}
        onSubmit={onSave}
      />
      {c.savedCount > 0 && (
        <div class="popup__forget">
          <span class="fx-secondary">
            {plural(c.savedCount, "saved tab")} for this container.
          </span>
          <Button
            small
            data-testid="forget-saved"
            aria-label={`Forget saved tabs of ${c.name}`}
            onClick={onForgetSaved}
          >
            Forget saved tabs
          </Button>
        </div>
      )}
    </li>
  ) : (
    <li
      class={`popup__row${canMoveHere ? " popup__row--move" : ""}`}
      data-testid="container-row"
      data-current={isCurrent ? "true" : undefined}
    >
      <button
        type="button"
        id={rowId(c.id)}
        class="popup__rowmain"
        aria-label={
          c.tabCount > 0
            ? `Go to ${c.name}`
            : reopening
              ? `Reopen ${plural(c.savedCount, "saved tab")} of ${c.name}`
              : `Open ${c.name}`
        }
        title={
          c.tabCount > 0
            ? `Go to ${c.name} (${tabsLabel(c.tabCount)} open)`
            : reopening
              ? `Reopen ${plural(c.savedCount, "saved tab")}`
              : `Open ${c.name} in a new tab`
        }
        onClick={onGo}
      >
        <Dot color={CONTAINER_HEX[c.color]} />
        <span class="popup__rowname">{c.name}</span>
        {c.tabCount > 0 && (
          <span
            class="fx-secondary popup__rowtabs"
            data-testid="container-tabs"
          >
            {tabsLabel(c.tabCount)}
          </span>
        )}
        {reopening && (
          <span
            class="fx-secondary popup__rowtabs"
            data-testid="container-saved"
          >
            {c.savedCount} saved
          </span>
        )}
      </button>
      {/* Over the tab count, same place: they appear on hover and on keyboard focus (focusable the whole time). */}
      <div class="popup__acts" role="group" aria-label={`${c.name} actions`}>
        <Button
          variant="ghost"
          icon
          class="popup__act"
          aria-label={`New tab in ${c.name}`}
          title={`New tab in ${c.name}`}
          onClick={onNewTab}
        >
          <IconPlus />
        </Button>
        {canMoveHere && (
          <Button
            variant="ghost"
            icon
            class="popup__act"
            aria-label={`Move this tab to ${c.name}`}
            title={`Move this tab to ${c.name}`}
            onClick={onMoveHere}
          >
            <IconMoveIn />
          </Button>
        )}
        <Button
          variant="ghost"
          icon
          class="popup__act"
          aria-label={`Edit ${c.name}`}
          title={`Edit ${c.name}`}
          onClick={onEdit}
        >
          <IconPencil />
        </Button>
        <Button
          variant="ghost"
          icon
          class="popup__act popup__act--danger"
          aria-label={`Delete ${c.name}`}
          title={`Delete ${c.name}`}
          onClick={onDelete}
        >
          <IconTrash />
        </Button>
      </div>
    </li>
  );
};
