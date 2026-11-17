import { useId } from "react";
import { Link } from "react-router-dom";
import type { CategoryOption } from "./useEventCategories";

export function CategorySelect({ categories, value, onChange, loading, loadError, onRetry, error, disabled = false }: {
  categories: CategoryOption[];
  value: string;
  onChange: (id: string) => void;
  loading: boolean;
  loadError: string;
  onRetry: () => void;
  error?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const missing = Boolean(value && !categories.some(category => category.categoryId === value));
  const empty = !loading && !loadError && categories.length === 0;
  const message = error || (missing && !loading && !loadError ? "Choose a category from this event." : "");
  return <div>
    <label className="field" htmlFor={id}>
      <span>Category *</span>
      <select id={id} name="categoryId" className="expense-vendor-select"
        required value={value} disabled={disabled || loading || Boolean(loadError) || empty}
        aria-invalid={Boolean(message)} aria-describedby={id + "-message"}
        onChange={event => onChange(event.target.value)}>
        <option value="">{loading ? "Loading categories..." : empty ? "No categories available" : "Select a category"}</option>
        {missing && <option value={value} disabled>Previous category unavailable</option>}
        {categories.map(category => <option key={category.categoryId} value={category.categoryId}>{category.name}</option>)}
      </select>
    </label>
    <div id={id + "-message"}>
      {loadError ? <p role="alert">{loadError} <button className="btn btn-ghost" type="button" onClick={onRetry}>Retry categories</button></p>
        : loading ? <small role="status">Loading this event's budget categories...</small>
        : empty ? <p role="status">Add a budget category in <Link to="/app/budget">Budget</Link> before creating an expense.</p>
        : message ? <small className="expense-field-error" role="alert">{message}</small> : null}
    </div>
  </div>;
}
