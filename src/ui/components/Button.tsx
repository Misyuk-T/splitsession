import type { ButtonHTMLAttributes, ComponentChildren } from "preact";

export interface ButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "size" | "type"
> {
  variant?: "secondary" | "primary" | "danger" | "ghost";
  small?: boolean;
  icon?: boolean;
  block?: boolean;
  type?: "button" | "submit";
  children?: ComponentChildren;
}

export const Button = ({
  variant = "secondary",
  small,
  icon,
  block,
  type = "button",
  class: cls,
  className,
  children,
  ...rest
}: ButtonProps) => {
  const classes = [
    "fx-btn",
    variant !== "secondary" && `fx-btn--${variant}`,
    small && "fx-btn--small",
    icon && "fx-btn--icon",
    block && "fx-btn--block",
    cls as string | undefined,
    className as string | undefined,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    // eslint-disable-next-line react/button-has-type -- `type` is typed "button" | "submit" | "reset"
    <button type={type} class={classes} {...rest}>
      {children}
    </button>
  );
};

export const Dot = ({ color }: { color: string }) => (
  <span class="fx-dot" style={{ background: color }} aria-hidden="true" />
);
