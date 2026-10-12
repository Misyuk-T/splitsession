import { useEffect, useRef, useState } from 'preact/hooks';
import { Dot } from './Button';
import { useOutsidePress, usePopoverPlacement, useTypeahead, useUid } from './hooks';

export interface SelectOption {
  value: string;
  label: string;
  dot?: string;
}

interface SelectProps {
  /** Accessible name (a visible label should point at `id` with `for`/aria-labelledby too). */
  label: string;
  value: string | null;
  options: readonly SelectOption[];
  onChange(next: string): void;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  id?: string;
  emptyText?: string;
}

/**
 * Custom replacement for `<select>`: an ARIA select-only combobox with a listbox popup. Focus stays on the combobox and
 * `aria-activedescendant` names the highlighted option. Enter/Space/ArrowDown open it; arrows, Home/End and
 * type-ahead move; Enter or Space picks; Escape closes; Tab picks nothing and moves on.
 */
export function Select({ label, value, options, onChange, placeholder = 'Choose…', disabled, invalid, id, emptyText = 'Nothing to choose from.' }: SelectProps) {
  const uid = useUid('select');
  const listId = `${uid}-list`;
  const [open, setOpen] = useState(false);
  const selected = options.findIndex((o) => o.value === value);
  const [active, setActive] = useState(Math.max(0, selected));
  const trigger = useRef<HTMLDivElement>(null);
  const popover = useRef<HTMLUListElement>(null);
  const placement = usePopoverPlacement(trigger, popover, open, 'start', true);
  const typeahead = useTypeahead(options.map((o) => o.label), active);
  const current = selected >= 0 ? options[selected] : undefined;

  useOutsidePress([trigger, popover], () => setOpen(false), open);
  useEffect(() => {
    if (open && placement) document.getElementById(`${uid}-opt-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active, placement !== null]);

  const openList = () => {
    if (disabled) return;
    setActive(Math.max(0, selected));
    setOpen(true);
  };
  const pick = (index: number) => {
    const option = options[index];
    setOpen(false);
    if (option) onChange(option.value);
    trigger.current?.focus();
  };
  const last = options.length - 1;

  return (
    <div class="fx-select-wrap">
      <div
        ref={trigger}
        id={id}
        class="fx-select"
        role="combobox"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && options.length > 0 ? `${uid}-opt-${active}` : undefined}
        aria-disabled={disabled ? true : undefined}
        aria-invalid={invalid ? 'true' : undefined}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={(event) => {
          if (disabled) return;
          if (!open) {
            if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
              event.preventDefault();
              openList();
            }
            return;
          }
          switch (event.key) {
            case 'ArrowDown':
              event.preventDefault();
              setActive(Math.min(last, active + 1));
              break;
            case 'ArrowUp':
              event.preventDefault();
              setActive(Math.max(0, active - 1));
              break;
            case 'Home':
              event.preventDefault();
              setActive(0);
              break;
            case 'End':
              event.preventDefault();
              setActive(last);
              break;
            case 'Enter':
            case ' ':
              event.preventDefault();
              if (options.length > 0) pick(active);
              else setOpen(false);
              break;
            case 'Escape':
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
              break;
            case 'Tab':
              setOpen(false);
              break;
            default:
              if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
                const hit = typeahead(event.key);
                if (hit >= 0) setActive(hit);
              }
          }
        }}
      >
        {current?.dot && <Dot color={current.dot} />}
        <span class={`fx-select__value${current ? '' : ' fx-select__placeholder'}`}>{current ? current.label : placeholder}</span>
        <svg class="fx-select__chevron" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3 5l4 4 4-4" />
        </svg>
      </div>
      {open && (
        <ul
          ref={popover}
          id={listId}
          class="fx-popover"
          role="listbox"
          aria-label={label}
          style={
            placement
              ? { left: `${placement.left}px`, top: `${placement.top}px`, minWidth: `${placement.minWidth}px`, ...(placement.maxHeight > 0 ? { maxHeight: `${placement.maxHeight}px` } : {}), margin: 0, listStyle: 'none' }
              : { left: '0px', top: '0px', visibility: 'hidden', margin: 0, listStyle: 'none' }
          }
        >
          {options.length === 0 && <li class="fx-popover__empty fx-secondary" role="presentation">{emptyText}</li>}
          {options.map((option, index) => (
            <li
              key={option.value}
              id={`${uid}-opt-${index}`}
              role="option"
              class="fx-popover__item"
              aria-selected={option.value === value}
              data-active={index === active}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => pick(index)}
              onMouseMove={() => index !== active && setActive(index)}
            >
              {option.dot && <Dot color={option.dot} />}
              <span>{option.label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
