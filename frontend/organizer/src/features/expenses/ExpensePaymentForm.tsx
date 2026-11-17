import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Icon } from "../../components/ui";
import type { Expense } from "../../types";
import { ExpenseSaveError } from "../../services/expenseService";
import { validateExpensePayment, type PaymentDraft, type PaymentErrors } from "./expensePayments";
import "./expenses.css";

export function ExpensePaymentForm({ expense, onSave, onClose }: {
  expense: Expense;
  onSave: (draft: PaymentDraft) => PaymentErrors | Promise<PaymentErrors>;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const today = new Date().toISOString().slice(0, 10);
  const [draft, setDraft] = useState<PaymentDraft>({ amount: "", paidAt: today, paymentType: "PAYMENT" });
  const [errors, setErrors] = useState<PaymentErrors>({});
  const pendingRef = useRef(false);
  const activeRef = useRef(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const close = () => { if (!pendingRef.current) onClose(); };
  const balance = (Math.round(expense.total * 100) - Math.round(expense.paid * 100)) / 100;

  useEffect(() => {
    activeRef.current = true;
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.showModal();
    return () => { activeRef.current = false; if (previous?.isConnected) previous.focus(); };
  }, []);

  const update = (field: keyof PaymentDraft, value: string) => {
    if (pendingRef.current) return;
    setSaveError("");
    const next = { ...draft, [field]: value };
    setDraft(next);
    if (errors[field]) setErrors((current) => ({ ...current, [field]: validateExpensePayment(expense, next)[field] }));
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pendingRef.current) return;
    setSaveError("");
    const nextErrors = validateExpensePayment(expense, draft);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      formRef.current?.querySelector<HTMLElement>('[name="' + Object.keys(nextErrors)[0] + '"]')?.focus();
      return;
    }
    pendingRef.current = true; setSaving(true);
    try {
      const fields = await onSave(draft);
      if (activeRef.current) setErrors(fields);
    } catch (failure) {
      if (activeRef.current) {
        setSaveError(failure instanceof Error ? failure.message : "Couldn't record payment. Please try again.");
        if (failure instanceof ExpenseSaveError) setErrors(failure.fields);
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
      aria-labelledby="expense-payment-title"
      onCancel={(event) => { event.preventDefault(); close(); }}
      onClick={(event) => { if (event.target === event.currentTarget) close(); }}
    >
      <div className="expense-form-content">
        <header className="modal-head">
          <div>
            <div className="eyebrow">EventWise</div>
            <h2 id="expense-payment-title">Record payment</h2>
          </div>
          <button type="button" className="icon-btn" aria-label="Close payment form" disabled={saving} onClick={close}>
            <Icon name="close" />
          </button>
        </header>
        <form ref={formRef} onSubmit={submit} noValidate aria-busy={saving}>
          <div className="modal-body">
            {saveError && <p className="expense-form-error" role="alert">{saveError}</p>}
            <fieldset disabled={saving} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
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
            </fieldset>
          </div>
          <footer className="modal-footer">
            <Button variant="secondary" disabled={saving} onClick={close}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? "Saving..." : "Record payment"}</Button>
          </footer>
        </form>
      </div>
    </dialog>
  );
}
