import type { ContainerInfo } from "../../background/facet";
import { ConfirmDialog } from "../components/Dialog";

/** "Delete <name>?": its tabs close and its cookies are forgotten. */
export const DeleteDialog = ({
  container,
  busy,
  onCancel,
  onConfirm,
}: {
  container: ContainerInfo;
  busy: boolean;
  onCancel(): void;
  onConfirm(): void;
}) => (
  <ConfirmDialog
    title={`Delete “${container.name}”?`}
    confirmLabel="Delete container"
    danger
    busy={busy}
    onCancel={onCancel}
    onConfirm={onConfirm}
  >
    <p>
      {container.tabCount > 0
        ? `${container.tabCount === 1 ? "Its open tab" : `Its ${container.tabCount} open tabs`} will be closed and its saved logins (cookies) forgotten.`
        : "Its saved logins (cookies) will be forgotten."}
    </p>
    <p class="fx-secondary">This cannot be undone.</p>
  </ConfirmDialog>
);
