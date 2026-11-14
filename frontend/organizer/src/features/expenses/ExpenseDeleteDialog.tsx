import { useEffect, useRef, useState } from "react";
import { Button, Icon } from "../../components/ui";
import type { Expense } from "../../types";
import { hasExpensePaymentHistory } from "./expenseDeletion";
import "./expenses.css";

export function ExpenseDeleteDialog({ expense, onConfirm, onClose }: {
  expense: Expense;
  onConfirm: () => string | undefined;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState("");
  const blocked = hasExpensePaymentHistory(expense);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.showModal();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="expense-form-dialog"
      aria-labelledby="expense-delete-title"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="expense-form-content">
        <header className="modal-head">
          <div>
            <div className="eyebrow">EventWise</div>
            <h2 id="expense-delete-title">{blocked ? "Expense can't be deleted" : "Delete expense?"}</h2>
          </div>
          <button type="button" className="icon-btn" aria-label="Close delete dialog" onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        <div className="modal-body">
          <p><strong>{expense.vendor}</strong></p>
          {blocked ? (
            <p>This expense has recorded payments. Keep it to preserve its payment history, even when fully paid.</p>
          ) : (
            <p>
              Delete this expense for {expense.total.toLocaleString("en-US", { style: "currency", currency: "USD" })}?
              {" "}This can't be undone.
            </p>
          )}
          {error && <p className="expense-form-error" role="alert">{error}</p>}
        </div>
        <footer className="modal-footer">
          <button type="button" className="btn btn-secondary" autoFocus onClick={onClose}>
            {blocked ? "Close" : "Cancel"}
          </button>
          {!blocked && (
            <Button variant="danger" onClick={() => {
              const message = onConfirm();
              if (message) setError(message);
            }}>
              Delete expense
            </Button>
          )}
        </footer>
      </div>
    </dialog>
  );
}
