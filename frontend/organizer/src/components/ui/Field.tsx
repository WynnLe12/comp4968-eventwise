import type { InputHTMLAttributes } from "react";

export function Field({
  label,
  type = "text",
  ...inputProps
}: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input {...inputProps} type={type} />
    </label>
  );
}
