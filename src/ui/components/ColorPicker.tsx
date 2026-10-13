import { useRef } from "preact/hooks";

import {
  CONTAINER_COLORS,
  CONTAINER_HEX,
  type ContainerColor,
} from "../../core";
import { useUid } from "./hooks";

const COLS = CONTAINER_COLORS.length;
const label = (color: string) => color[0]!.toUpperCase() + color.slice(1);

/**
 * Fixed palette of 8 colours (the ones Chrome tab groups can show) as a radio group: one tab stop, arrow keys move
 * and select, Home/End jump.
 */
export const ColorPicker = ({
  value,
  onChange,
  label: groupLabel = "Colour",
}: {
  value: ContainerColor;
  onChange(next: ContainerColor): void;
  label?: string;
}) => {
  const uid = useUid("colors");
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const select = (index: number) => {
    const next = CONTAINER_COLORS[(index + COLS) % COLS]!;
    onChange(next);
    refs.current[(index + COLS) % COLS]?.focus();
  };
  const current = Math.max(0, CONTAINER_COLORS.indexOf(value));
  return (
    <div class="fx-colors" role="radiogroup" aria-label={groupLabel} id={uid}>
      {CONTAINER_COLORS.map((color, index) => (
        <button
          key={color}
          ref={(el) => {
            refs.current[index] = el;
          }}
          type="button"
          role="radio"
          class="fx-color"
          aria-checked={color === value}
          aria-label={label(color)}
          title={label(color)}
          tabIndex={index === current ? 0 : -1}
          style={{ "--swatch": CONTAINER_HEX[color] } as never}
          onClick={() => onChange(color)}
          onKeyDown={(event) => {
            const step =
              event.key === "ArrowRight" || event.key === "ArrowDown"
                ? 1
                : event.key === "ArrowLeft" || event.key === "ArrowUp"
                  ? -1
                  : 0;
            if (step !== 0) {
              event.preventDefault();
              select(index + step);
            } else if (event.key === "Home") {
              event.preventDefault();
              select(0);
            } else if (event.key === "End") {
              event.preventDefault();
              select(COLS - 1);
            }
          }}
        />
      ))}
    </div>
  );
};
