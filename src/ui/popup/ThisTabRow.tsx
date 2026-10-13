import type { ContainerInfo } from "../../background/facet";
import { CONTAINER_HEX } from "../../core";
import { Dot } from "../components/Button";
import { MenuButton } from "../components/Menu";
import { hostOf } from "../format";
import { IconSwap } from "../icons";
import { NONE } from "./ids";

/** "This tab": the container of the current tab, and "Reopen in…" another container or none. */
export const ThisTabRow = ({
  current,
  containers,
  tabUrl,
  onReopen,
}: {
  current: ContainerInfo;
  containers: ContainerInfo[];
  tabUrl: string | undefined;
  onReopen(id: string): void;
}) => (
  <section
    class="popup__tab"
    aria-label="This tab"
    data-testid="current-container"
  >
    <Dot color={CONTAINER_HEX[current.color]} />
    <div class="popup__tabtext">
      <strong class="popup__tabname">{current.name}</strong>
      <span class="fx-secondary popup__tabsite">{hostOf(tabUrl)}</span>
    </div>
    <MenuButton
      items={[
        ...containers.map((c) => ({
          id: c.id,
          label: c.name,
          dot: CONTAINER_HEX[c.color],
          checked: c.id === current.id,
        })),
        {
          id: NONE,
          label: "No container",
          separatorBefore: containers.length > 0,
          checked: false,
        },
      ]}
      onSelect={onReopen}
      ariaLabel="Reopen in…"
      menuLabel="Reopen this tab in"
      align="end"
      variant="ghost"
      small
      icon
    >
      <IconSwap />
    </MenuButton>
  </section>
);
