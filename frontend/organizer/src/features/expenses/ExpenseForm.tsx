import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Icon } from "../../components/ui";
import type { Expense } from "../../types";
import { expenseFromDraft, validateExpenseDraft, type ExpenseDraft, type ExpenseDraftErrors } from "./expenseDraft";
import "./expenses.css";

export function ExpenseForm({ onSave, onClose }: {
  onSave: (expense: Expense) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [draft, setDraft] = useState<ExpenseDraft>({ name: "", amount: "", dueDate: "" });
  const [errors, setErrors] = useState<ExpenseDraftErrors>({});

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.showModal();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  const update = (field: keyof ExpenseDraft, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
    if (errors[field]) {
      setErrors((current) => ({
        ...current,
        [field]: validateExpenseDraft({ ...draft, [field]: value })[field],
      }));
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextErrors = validateExpenseDraft(draft);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      const first = Object.keys(nextErrors)[0];
      formRef.current?.querySelector<HTMLInputElement>('[name="' + first + '"]')?.focus();
      return;
    }
    onSave(expenseFromDraft(draft));
  };

  return (
    <dialog
      ref={dialogRef}
      className="expense-form-dialog"
      aria-labelledby="expense-form-title"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="expense-form-content">
        <header className="modal-head">
          <div>
            <div className="eyebrow">EventWise</div>
            <h2 id="expense-form-title">Add an expense</h2>
          </div>
          <button type="button" className="icon-btn" aria-label="Close expense form" onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        <form ref={formRef} onSubmit={submit} noValidate>
          <div className="modal-body">
            {Object.values(errors).some(Boolean) && (
              <p className="expense-form-error" role="alert">Please fix the highlighted fields and try again.</p>
            )}
            <label className="field">
              <span>Expense name *</span>
              <input
                name="name"
                value={draft.name}
                onChange={(event) => update("name", event.target.value)}
                onBlur={() => setErrors((current) => ({ ...current, name: validateExpenseDraft(draft).name }))}
                placeholder="e.g. Cake tasting fee"
                required
                maxLength={255}
                aria-invalid={Boolean(errors.name)}
                aria-describedby={errors.name ? "expense-name-error" : undefined}
              />
              {errors.name && <small id="expense-name-error" className="expense-field-error">{errors.name}</small>}
            </label>
            <div className="form-row">
              <label className="field">
                <span>Total amount *</span>
                <input
                  name="amount"
                  inputMode="decimal"
                  value={draft.amount}
                  onChange={(event) => update("amount", event.target.value)}
                  onBlur={() => setErrors((current) => ({ ...current, amount: validateExpenseDraft(draft).amount }))}
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
                {errors.dueDate && <small id="expense-date-error" className="expense-field-error">{errors.dueDate}</small>}
              </label>
            </div>
          </div>
          <footer className="modal-footer">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="submit">Add expense</Button>
          </footer>
        </form>
      </div>
    </dialog>
  );
}
