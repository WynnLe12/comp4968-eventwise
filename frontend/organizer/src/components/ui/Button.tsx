import type { ReactNode } from "react";

import { Icon } from "./Icon";

export function Button({
  children,
  variant = "primary",
  icon,
  onClick,
  type = "button",
  disabled = false,
}: {
  children: ReactNode;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  icon?: string;
  onClick?: () => void;
  type?: "button" | "submit";
  disabled?: boolean;
}) {
  return (
    <button type={type} className={`btn btn-${variant}`} onClick={onClick} disabled={disabled}>
      {icon && <Icon name={icon} size={16} />} {children}
    </button>
  );
}
