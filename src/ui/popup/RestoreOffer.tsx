import type { GroupRestoreOffer } from "../../core";
import { Button } from "../components/Button";
import { IconClose } from "../icons";

/**
 * After a reinstall the tab groups SplitSession left behind stand for containers that are gone: one quiet row offers to
 * bring them back (name, colour and tabs; the logins cannot come back). "x" says no for good.
 */
export const RestoreOffer = ({
  offer,
  busy,
  onRestore,
  onDismiss,
}: {
  offer: GroupRestoreOffer;
  busy: boolean;
  onRestore(): void;
  onDismiss(): void;
}) => {
  const many = offer.groups !== 1;
  return (
    <section
      class="popup__offer"
      aria-label="Containers from an earlier install"
      data-testid="group-restore-offer"
    >
      <p class="popup__offertext">
        Found {many ? `${offer.groups} tab groups` : "1 tab group"} from an
        earlier install. Restore{" "}
        {many ? "them as containers" : "it as a container"}?
      </p>
      <Button
        small
        variant="primary"
        disabled={busy}
        onClick={onRestore}
        title="Make a container of each group and put its tabs in it"
      >
        Restore
      </Button>
      <Button
        small
        variant="ghost"
        icon
        disabled={busy}
        aria-label="Dismiss"
        title="Dismiss"
        onClick={onDismiss}
      >
        <IconClose />
      </Button>
    </section>
  );
};
