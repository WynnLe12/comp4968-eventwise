import { Icon } from "./Icon.jsx";

export function Button({
  children,
  variant = "primary",
  icon,
  onClick,
  type = "button",
}) {
  return (
    <button type={type} className={`btn btn-${variant}`} onClick={onClick}>
      {icon && <Icon name={icon} size={16} />} {children}
    </button>
  );
}
