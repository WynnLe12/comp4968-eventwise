import type { HTMLInputTypeAttribute } from "react";

export function Field({
  label,
  placeholder,
  type = "text",
  defaultValue,
}: {
  label: string;
  placeholder?: string;
  type?: HTMLInputTypeAttribute;
  defaultValue?: string | number;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input type={type} placeholder={placeholder} defaultValue={defaultValue} />
    </label>
  );
}
