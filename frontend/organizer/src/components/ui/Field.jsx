export function Field({
  label,
  placeholder,
  type = "text",
  defaultValue,
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input type={type} placeholder={placeholder} defaultValue={defaultValue} />
    </label>
  );
}
