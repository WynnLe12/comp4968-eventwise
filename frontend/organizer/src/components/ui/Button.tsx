import type { ReactNode } from "react";

import { Icon } from "./Icon";

export function Button({
  children,
  variant = "primary",
  icon,
  onClick,
  type = "button",
  disabled,
  form,
}: {
  children: ReactNode;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  icon?: string;
  onClick?: () => void;
  type?: "button" | "submit";
  disabled?: boolean;
  /** Id of the form this button submits when it sits outside the form (e.g. a modal footer). */
  form?: string;
}) {
  return (
    <button
      type={type}
      className={`btn btn-${variant}`}
      onClick={onClick}
      disabled={disabled}
      form={form}
    >
      {icon && <Icon name={icon} size={16} />} {children}
    </button>
  );
}
