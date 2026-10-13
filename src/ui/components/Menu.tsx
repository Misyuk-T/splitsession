import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

import { Dot } from "./Button";
import {
  useOutsidePress,
  usePopoverPlacement,
  useTypeahead,
  useUid,
} from "./hooks";

export interface MenuItem {
  id: string;
  label: string;
  /** Colour dot in front of the label. */
  dot?: string;
  danger?: boolean;
  disabled?: boolean;
  /** Draws a divider above the item. */
  separatorBefore?: boolean;
  /** Marks the current choice (announced as checked). */
  checked?: boolean;
  /** With `checked`: an independent on/off item (`menuitemcheckbox`) instead of one choice among several (`menuitemradio`). */
  toggle?: boolean;
}

interface MenuButtonProps {
  /** Button content. */
  children: ComponentChildren;
  /** Accessible name when the content is not text (an icon). */
  ariaLabel?: string;
  items: readonly MenuItem[];
  onSelect(id: string): void;
  menuLabel?: string;
  align?: "start" | "end";
  variant?: "secondary" | "primary" | "ghost";
  small?: boolean;
  icon?: boolean;
  block?: boolean;
  disabled?: boolean;
  id?: string;
  /** Tooltip; an icon-only button (one with `ariaLabel`) gets its name by default. */
  title?: string;
}

/**
 * Menu button (ARIA menu pattern): ArrowDown/ArrowUp open it and move, Home/End jump, Enter/Space choose, Escape closes
 * and returns focus to the button, Tab closes, typing a letter jumps to a matching item.
 */
export const MenuButton = ({
  children,
  ariaLabel,
  items,
  onSelect,
  menuLabel,
  align = "start",
  variant = "secondary",
  small,
  icon,
  block,
  disabled,
  id,
  title,
}: MenuButtonProps) => {
  const uid = useUid("menu");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const restoreFocus = useRef(false);
  const placement = usePopoverPlacement(trigger, popover, open, align);
  const enabled = items
    .map((item, index) => (item.disabled ? -1 : index))
    .filter((index) => index >= 0);
  const typeahead = useTypeahead(
    items.map((i) => i.label),
    active,
  );

  useOutsidePress([trigger, popover], () => setOpen(false), open);

  useEffect(() => {
    if (open && placement && !restoreFocus.current)
      itemRefs.current[active]?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `placement` is tracked as "is placed" so focus moves once the popover is positioned, not on every reposition
  }, [open, active, placement !== null]);

  const openAt = (position: "first" | "last" | "checked") => {
    if (enabled.length === 0) return;
    const checked = items.findIndex((i) => i.checked && !i.disabled);
    setActive(
      position === "last"
        ? enabled[enabled.length - 1]!
        : position === "checked" && checked >= 0
          ? checked
          : enabled[0]!,
    );
    setOpen(true);
  };
  // Focus goes back to the button once the menu is gone, whatever its last render was doing meanwhile
  // (an item may be about to take focus as the menu closes).
  useEffect(() => {
    if (!open && restoreFocus.current) {
      restoreFocus.current = false;
      trigger.current?.focus();
    }
  }, [open]);
  const close = (returnFocus: boolean) => {
    restoreFocus.current = returnFocus;
    setOpen(false);
    if (returnFocus) trigger.current?.focus();
  };
  const move = (delta: number) => {
    const at = enabled.indexOf(active);
    setActive(enabled[(at + delta + enabled.length) % enabled.length]!);
  };
  const choose = (index: number) => {
    const item = items[index];
    if (!item || item.disabled) return;
    close(true);
    // After focus is back on the button, so a dialog opened by the action remembers it as its return target.
    queueMicrotask(() => onSelect(item.id));
  };

  const classes = [
    "fx-btn",
    variant !== "secondary" && `fx-btn--${variant}`,
    small && "fx-btn--small",
    icon && "fx-btn--icon",
    block && "fx-btn--block",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      <button
        ref={trigger}
        id={id}
        type="button"
        class={classes}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? uid : undefined}
        aria-label={ariaLabel}
        title={title ?? ariaLabel}
        disabled={disabled}
        onClick={() => (open ? close(false) : openAt("checked"))}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            openAt("first");
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            openAt("last");
          } else if (event.key === "Escape" && open) {
            // Focus has not reached the first item yet (it moves there once the menu is placed).
            event.preventDefault();
            event.stopPropagation();
            close(true);
          }
        }}
      >
        {children}
      </button>
      {open && (
        // eslint-disable-next-line jsx-a11y/interactive-supports-focus -- focus lives on the menu items (arrow-key roving), not on the popover
        <div
          ref={popover}
          id={uid}
          class="fx-popover"
          role="menu"
          aria-label={menuLabel ?? ariaLabel}
          style={
            placement
              ? {
                  left: `${placement.left}px`,
                  top: `${placement.top}px`,
                  ...(placement.maxHeight > 0
                    ? { maxHeight: `${placement.maxHeight}px` }
                    : {}),
                }
              : { left: "0px", top: "0px", visibility: "hidden" }
          }
          onKeyDown={(event) => {
            switch (event.key) {
              case "ArrowDown":
                event.preventDefault();
                move(1);
                break;
              case "ArrowUp":
                event.preventDefault();
                move(-1);
                break;
              case "Home":
                event.preventDefault();
                setActive(enabled[0]!);
                break;
              case "End":
                event.preventDefault();
                setActive(enabled[enabled.length - 1]!);
                break;
              case "Escape":
                event.preventDefault();
                event.stopPropagation();
                close(true);
                break;
              case "Tab":
                close(false);
                break;
              default:
                if (
                  event.key.length === 1 &&
                  !event.ctrlKey &&
                  !event.metaKey &&
                  !event.altKey &&
                  event.key !== " "
                ) {
                  const hit = typeahead(event.key);
                  if (hit >= 0 && !items[hit]!.disabled) setActive(hit);
                }
            }
          }}
        >
          {items.map((item, index) => (
            <div key={item.id} role="none">
              {item.separatorBefore && (
                <div class="fx-popover__sep" role="separator" />
              )}
              <button
                ref={(el) => {
                  itemRefs.current[index] = el;
                }}
                type="button"
                role={
                  item.checked !== undefined
                    ? item.toggle
                      ? "menuitemcheckbox"
                      : "menuitemradio"
                    : "menuitem"
                }
                aria-checked={
                  item.checked !== undefined ? item.checked : undefined
                }
                class={`fx-popover__item${item.danger ? " fx-popover__item--danger" : ""}`}
                data-active={index === active}
                tabIndex={index === active ? 0 : -1}
                disabled={item.disabled}
                onClick={() => choose(index)}
                onMouseMove={() =>
                  !item.disabled && index !== active && setActive(index)
                }
              >
                {item.dot && <Dot color={item.dot} />}
                <span>{item.label}</span>
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
};
