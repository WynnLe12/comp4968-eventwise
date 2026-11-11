import type { ReactNode } from "react";

import { Icon } from "./Icon";

export function Button({
  children,
  variant = "primary",
  icon,
  onClick,
  type = "button",
}: {
  children: ReactNode;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  icon?: string;
  onClick?: () => void;
  type?: "button" | "submit";
}) {
  return (
    <button type={type} className={`btn btn-${variant}`} onClick={onClick}>
      {icon && <Icon name={icon} size={16} />} {children}
    </button>
  );
}
