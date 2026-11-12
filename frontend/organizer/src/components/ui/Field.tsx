import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";

function FieldMessage({ id, error, hint }: { id: string; error?: string; hint?: ReactNode }) {
  if (error) {
    return (
      <small className="field-error" id={id}>
        {error}
      </small>
    );
  }
  if (hint) {
    return (
      <small className="field-hint" id={id}>
        {hint}
      </small>
    );
  }
  return null;
}

type FieldProps = {
  label: string;
  /** Inline validation message shown below the input. */
  error?: string;
  /** Helper text shown below the input when there is no error. */
  hint?: ReactNode;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "children">;

export function Field({ label, error, hint, type = "text", ...inputProps }: FieldProps) {
  const messageId = useId();
  const hasMessage = Boolean(error || hint);
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type={type}
        {...inputProps}
        aria-invalid={error ? true : undefined}
        aria-describedby={hasMessage ? messageId : undefined}
      />
      <FieldMessage id={messageId} error={error} hint={hint} />
    </label>
  );
}

type SelectFieldProps = {
  label: string;
  error?: string;
  hint?: ReactNode;
  options: { value: string; label: string; disabled?: boolean }[];
} & Omit<SelectHTMLAttributes<HTMLSelectElement>, "children">;

export function SelectField({ label, error, hint, options, ...selectProps }: SelectFieldProps) {
  const messageId = useId();
  const hasMessage = Boolean(error || hint);
  return (
    <label className="field">
      <span>{label}</span>
      <select
        {...selectProps}
        aria-invalid={error ? true : undefined}
        aria-describedby={hasMessage ? messageId : undefined}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      <FieldMessage id={messageId} error={error} hint={hint} />
    </label>
  );
}
