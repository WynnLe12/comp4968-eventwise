import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Icon } from "../../components/ui";
import type { Expense } from "../../types";
import { validateExpensePayment, type PaymentDraft, type PaymentErrors } from "./expensePayments";
import "./expenses.css";

export function ExpensePaymentForm({ expense, onSave, onClose }: {
  expense: Expense;
  onSave: (draft: PaymentDraft) => PaymentErrors;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const today = new Date().toISOString().slice(0, 10);
  const [draft, setDraft] = useState<PaymentDraft>({ amount: "", paidAt: today, paymentType: "PAYMENT" });
  const [errors, setErrors] = useState<PaymentErrors>({});
  const balance = (Math.round(expense.total * 100) - Math.round(expense.paid * 100)) / 100;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.showModal();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);

  const update = (field: keyof PaymentDraft, value: string) => {
    const next = { ...draft, [field]: value };
    setDraft(next);
    if (errors[field]) setErrors((current) => ({ ...current, [field]: validateExpensePayment(expense, next)[field] }));
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    let nextErrors = validateExpensePayment(expense, draft);
    if (!Object.keys(nextErrors).length) nextErrors = onSave(draft);
    if (!Object.keys(nextErrors).length) return;
    setErrors(nextErrors);
    formRef.current?.querySelector<HTMLElement>('[name="' + Object.keys(nextErrors)[0] + '"]')?.focus();
  };

  return (
    <dialog
      ref={dialogRef}
      className="expense-form-dialog"
      aria-labelledby="expense-payment-title"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="expense-form-content">
        <header className="modal-head">
          <div>
            <div className="eyebrow">EventWise</div>
            <h2 id="expense-payment-title">Record payment</h2>
          </div>
          <button type="button" className="icon-btn" aria-label="Close payment form" onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        <form ref={formRef} onSubmit={submit} noValidate>
          <div className="modal-body">
            <p className="expense-payment-context">
              <strong>{expense.vendor}</strong><br />
              Remaining balance: {balance.toLocaleString("en-US", { style: "currency", currency: "USD" })}
            </p>
            {Object.values(errors).some(Boolean) && (
              <p className="expense-form-error" role="alert">Please fix the highlighted fields and try again.</p>
            )}
            <div className="form-row">
              <label className="field">
                <span>Payment amount *</span>
                <input
                  name="amount" inputMode="decimal" placeholder="0.00" required
                  value={draft.amount}
                  onChange={(event) => update("amount", event.target.value)}
                  onBlur={() => setErrors((current) => ({ ...current, amount: validateExpensePayment(expense, draft).amount }))}
                  aria-invalid={Boolean(errors.amount)}
                  aria-describedby={errors.amount ? "payment-amount-error" : undefined}
                />
                {errors.amount && <small id="payment-amount-error" className="expense-field-error">{errors.amount}</small>}
              </label>
              <label className="field">
                <span>Payment date *</span>
                <input
                  name="paidAt" type="date" required min="1000-01-01" max={today}
                  value={draft.paidAt}
                  onChange={(event) => update("paidAt", event.target.value)}
                  aria-invalid={Boolean(errors.paidAt)}
                  aria-describedby={errors.paidAt ? "payment-date-error" : undefined}
                />
                {errors.paidAt && <small id="payment-date-error" className="expense-field-error">{errors.paidAt}</small>}
              </label>
            </div>
            <label className="field">
              <span>Payment type *</span>
              <select
                className="expense-payment-type" name="paymentType" value={draft.paymentType}
                onChange={(event) => update("paymentType", event.target.value)}
                aria-invalid={Boolean(errors.paymentType)}
                aria-describedby={errors.paymentType ? "payment-type-error" : undefined}
              >
                <option value="PAYMENT">Payment</option>
                <option value="DEPOSIT">Deposit</option>
              </select>
              {errors.paymentType && <small id="payment-type-error" className="expense-field-error">{errors.paymentType}</small>}
            </label>
          </div>
          <footer className="modal-footer">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="submit">Record payment</Button>
          </footer>
        </form>
      </div>
    </dialog>
  );
}
