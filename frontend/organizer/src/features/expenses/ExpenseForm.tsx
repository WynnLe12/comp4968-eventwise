import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Icon } from "../../components/ui";
import type { Expense, Vendor } from "../../types";
import { expenseFromDraft, validateExpenseDraft, type ExpenseDraft, type ExpenseDraftErrors } from "./expenseDraft";
import "./expenses.css";
import { ExpenseSaveError } from "../../services/expenseService";
import { CategorySelect } from "../categories/CategorySelect";
import { useEventCategories } from "../categories/useEventCategories";

export function ExpenseForm({ eventId, accountId, expense, vendors, defaultVendorId, initialDraft, lockVendor = false, onSave, onClose }: {
  eventId: string;
  accountId: string;
  vendors: Vendor[];
  defaultVendorId?: string;
  initialDraft?: Pick<ExpenseDraft, "name" | "amount">;
  lockVendor?: boolean;
  expense?: Expense;
  onSave: (expense: Expense) => void | Promise<void>;
  onClose: () => void;
}) {
  const { categories, loading: categoriesLoading, error: categoriesError, retry: retryCategories } = useEventCategories(eventId, accountId);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [draft, setDraft] = useState<ExpenseDraft>({
    categoryId: expense?.categoryId ?? "",
    name: expense?.vendor ?? initialDraft?.name ?? "",
    vendorId: expense ? expense.vendorId ?? "" : defaultVendorId ?? "",
    amount: expense ? expense.total.toFixed(2) : initialDraft?.amount ?? "",
    dueDate: expense?.dueDate ?? "",
  });
  const [dueDateChanged, setDueDateChanged] = useState(false);
  const validate = (value: ExpenseDraft) => {
    const fields = validateExpenseDraft(value, expense?.paid ?? 0);
    if (categoriesLoading || categoriesError) fields.categoryId = "Load this event's categories before saving.";
    else if (!value.categoryId || !categories.some(category => category.categoryId === value.categoryId)) {
      fields.categoryId = "Choose a category from this event.";
    }
    if (expense && expense.eventId !== eventId) fields.categoryId = "Reopen this expense in its own event.";
    if (value.vendorId && !vendors.some((vendor) => vendor.id === value.vendorId && vendor.eventId === eventId)) {
      fields.vendorId = "Choose a vendor from this event.";
    }
    return fields;
  };
  const pendingRef = useRef(false);
  const activeRef = useRef(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const close = () => { if (!pendingRef.current) onClose(); };
  const [errors, setErrors] = useState<ExpenseDraftErrors>({});

  useEffect(() => {
    activeRef.current = true;
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.showModal();
    return () => {
      activeRef.current = false;
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  const update = (field: keyof ExpenseDraft, value: string) => {
    if (pendingRef.current) return;
    setSaveError("");
    if (field === "dueDate") setDueDateChanged(true);
    setDraft((current) => ({ ...current, [field]: value }));
    if (errors[field]) {
      setErrors((current) => ({
        ...current,
        [field]: validate({ ...draft, [field]: value })[field],
      }));
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pendingRef.current) return;
    setSaveError("");
    const nextErrors = validate(draft);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      const first = Object.keys(nextErrors)[0];
      formRef.current?.querySelector<HTMLInputElement>('[name="' + first + '"]')?.focus();
      return;
    }
    const category = categories.find(category => category.categoryId === draft.categoryId)!;
    pendingRef.current = true;
    setSaving(true);
    try {
      await onSave({ ...expenseFromDraft({ ...draft, categoryName: category.name }, expense, dueDateChanged), eventId });
    } catch (error) {
      if (activeRef.current) {
        setSaveError(error instanceof Error ? error.message : "Couldn\'t save this expense. Please try again.");
        if (error instanceof ExpenseSaveError) setErrors(error.fields);
      }
    } finally {
      pendingRef.current = false;
      if (activeRef.current) setSaving(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="expense-form-dialog"
      aria-labelledby="expense-form-title"
      onCancel={(event) => { event.preventDefault(); close(); }}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className="expense-form-content">
        <header className="modal-head">
          <div>
            <div className="eyebrow">EventWise</div>
            <h2 id="expense-form-title">{expense ? "Edit expense" : "Add an expense"}</h2>
          </div>
          <button type="button" className="icon-btn" aria-label="Close expense form" disabled={saving} onClick={close}>
            <Icon name="close" />
          </button>
        </header>
        <form ref={formRef} onSubmit={submit} noValidate aria-busy={saving}>
          <div className="modal-body">
            {saveError && <p className="expense-form-error" role="alert">{saveError}</p>}
            <fieldset disabled={saving} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            {Object.values(errors).some(Boolean) && (
              <p className="expense-form-error" role="alert">Please fix the highlighted fields and try again.</p>
            )}
            <label className="field">
              <span>Expense name *</span>
              <input
                name="name"
                value={draft.name}
                onChange={(event) => update("name", event.target.value)}
                onBlur={() => setErrors((current) => ({ ...current, name: validate(draft).name }))}
                placeholder="e.g. Cake tasting fee"
                required
                maxLength={255}
                aria-invalid={Boolean(errors.name)}
                aria-describedby={errors.name ? "expense-name-error" : undefined}
              />
              {errors.name && <small id="expense-name-error" className="expense-field-error">{errors.name}</small>}
            </label>
            <CategorySelect categories={categories} value={draft.categoryId ?? ""}
              onChange={id => update("categoryId", id)} loading={categoriesLoading}
              loadError={categoriesError} onRetry={retryCategories} error={errors.categoryId} />
            <label className="field">
              <span>Vendor (optional)</span>
              <select
                className="expense-vendor-select"
                name="vendorId"
                disabled={lockVendor}
                value={draft.vendorId ?? ""}
                onChange={(event) => update("vendorId", event.target.value)}
                aria-invalid={Boolean(errors.vendorId)}
                aria-describedby={errors.vendorId ? "expense-vendor-error" : undefined}
              >
                <option value="">No vendor linked</option>
                {vendors.filter(vendor => vendor.eventId === eventId).map((vendor) => <option key={vendor.id} value={vendor.id}>{vendor.name}</option>)}
              </select>
              {errors.vendorId && <small id="expense-vendor-error" className="expense-field-error">{errors.vendorId}</small>}
            </label>
            <div className="form-row">
              <label className="field">
                <span>Total amount *</span>
                <input
                  name="amount"
                  inputMode="decimal"
                  value={draft.amount}
                  onChange={(event) => update("amount", event.target.value)}
                  onBlur={() => setErrors((current) => ({ ...current, amount: validate(draft).amount }))}
                  placeholder="0.00"
                  required
                  aria-invalid={Boolean(errors.amount)}
                  aria-describedby={errors.amount ? "expense-amount-error" : undefined}
                />
                {errors.amount && <small id="expense-amount-error" className="expense-field-error">{errors.amount}</small>}
              </label>
              <label className="field">
                <span>Due date (optional)</span>
                <input
                  name="dueDate"
                  type="date"
                  min="1000-01-01"
                  max="9999-12-31"
                  value={draft.dueDate}
                  onChange={(event) => update("dueDate", event.target.value)}
                  aria-invalid={Boolean(errors.dueDate)}
                  aria-describedby={errors.dueDate ? "expense-date-error" : undefined}
                />
                {expense && !expense.dueDate && expense.due !== "Paid" && expense.due !== "No due date" && !dueDateChanged && (
                  <small>Current due date: {expense.due}. Choose a full date to replace it.</small>
                )}
                {(draft.dueDate || (expense && expense.due !== "Paid" && expense.due !== "No due date" && !dueDateChanged)) && (
                  <button type="button" className="btn btn-ghost" onClick={() => update("dueDate", "")}>
                    Remove due date
                  </button>
                )}
                {errors.dueDate && <small id="expense-date-error" className="expense-field-error">{errors.dueDate}</small>}
              </label>
            </div>
            </fieldset>
          </div>
          <footer className="modal-footer">
            <Button variant="secondary" disabled={saving} onClick={close}>Cancel</Button>
            <Button type="submit" disabled={saving || categoriesLoading || Boolean(categoriesError) || categories.length === 0}>{saving ? "Saving..." : expense ? "Save changes" : "Add expense"}</Button>
          </footer>
        </form>
      </div>
    </dialog>
  );
}
