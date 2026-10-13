import type { ContainerInfo } from "../../background/facet";
import type { RestoreStatus } from "../../background/restore";
import { CONTAINER_HEX } from "../../core";
import { Button } from "../components/Button";
import { MenuButton } from "../components/Menu";
import { IconChevron, IconMore, IconSwap } from "../icons";
import { NONE } from "./ids";

/** Waiting tabs listed by name in the banner; the rest are counted. */
const HELD_ROWS = 3;

type Held = RestoreStatus["held"][number];

/** "github.com/org/repo?tab=1" for a waiting tab (its title is the address while nothing has loaded). */
function shortAddress(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname === "/" ? "" : u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

const heldName = (h: Held) =>
  h.title && h.title !== h.url ? h.title : shortAddress(h.url);

/** Tabs the restore holds for the user: restore them in one click, open them as ordinary tabs, or choose per tab. */
export const HeldBanner = ({
  restore,
  containers,
  busy,
  open,
  onToggle,
  onResolve,
  onChoose,
}: {
  restore: RestoreStatus;
  containers: ContainerInfo[];
  busy: boolean;
  open: boolean;
  onToggle(): void;
  onResolve(action: "restore" | "plain"): void;
  onChoose(tabId: number, choice: string): void;
}) => {
  const { held } = restore;
  const nameOf = (id: string) =>
    containers.find((c) => c.id === id)?.name ?? id;
  const heldLabel =
    held.length === 1 ? "1 tab waiting" : `${held.length} tabs waiting`;
  return (
    <section
      class="popup__held"
      aria-label="Tabs waiting"
      data-testid="restore-banner"
    >
      <div class="popup__heldline">
        <button
          type="button"
          class="popup__heldmain"
          aria-expanded={open}
          aria-controls="popup-held-list"
          onClick={onToggle}
        >
          <span class="popup__helddot" aria-hidden="true" />
          <span>{heldLabel}</span>
          <span class={`fx-chevron${open ? " fx-chevron--open" : ""}`}>
            <IconChevron />
          </span>
        </button>
        {restore.oneClick > 0 && (
          <Button
            small
            variant="primary"
            disabled={busy}
            aria-label={`Restore ${restore.oneClick === 1 ? "1 container tab" : `${restore.oneClick} container tabs`}`}
            title="Put the tabs SplitSession is sure about back in their containers"
            onClick={() => onResolve("restore")}
          >
            Restore
          </Button>
        )}
        <MenuButton
          ariaLabel="Waiting tabs options"
          menuLabel="Waiting tabs"
          items={[
            {
              id: "plain",
              label:
                restore.oneClick > 0
                  ? "Open the rest as ordinary tabs"
                  : "Open as ordinary tabs",
              disabled: busy,
            },
          ]}
          onSelect={() => onResolve("plain")}
          align="end"
          variant="ghost"
          small
          icon
        >
          <IconMore />
        </MenuButton>
      </div>
      {open && (
        <ul id="popup-held-list" class="popup__heldrows">
          {held.slice(0, HELD_ROWS).map((h) => (
            <li key={h.tabId} class="popup__heldrow" data-testid="held-tab">
              <span class="popup__heldtext">
                <span class="popup__heldname" title={h.url}>
                  {heldName(h)}
                </span>
                <span class="fx-secondary popup__heldname">
                  {h.candidates.map(nameOf).join(" or ")}?
                </span>
              </span>
              <MenuButton
                ariaLabel={`Open ${heldName(h)} in`}
                menuLabel="Open this tab in"
                items={[
                  ...h.candidates.map((id) => {
                    const c = containers.find((x) => x.id === id);
                    return {
                      id,
                      label: c?.name ?? id,
                      ...(c ? { dot: CONTAINER_HEX[c.color] } : {}),
                    };
                  }),
                  {
                    id: NONE,
                    label: "Ordinary tab",
                    separatorBefore: true,
                  },
                ]}
                onSelect={(id) => onChoose(h.tabId, id)}
                align="end"
                variant="ghost"
                small
                icon
              >
                <IconSwap />
              </MenuButton>
            </li>
          ))}
          {held.length > HELD_ROWS && (
            <li class="fx-secondary popup__heldmore">
              and {held.length - HELD_ROWS} more
            </li>
          )}
        </ul>
      )}
    </section>
  );
};
