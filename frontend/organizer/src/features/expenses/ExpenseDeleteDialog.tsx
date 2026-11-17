import { useEffect, useRef, useState } from "react";
import { Button, Icon } from "../../components/ui";
import type { Expense } from "../../types";
import { ExpenseDeleteError } from "../../services/expenseService";
import { hasExpensePaymentHistory } from "./expenseDeletion";
import "./expenses.css";

export function ExpenseDeleteDialog({ expense, onConfirm, onClose }: {
  expense: Expense;
  onConfirm: () => string | undefined | void | Promise<string | undefined | void>;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState("");
  const pendingRef = useRef(false);
  const activeRef = useRef(true);
  const [deleting, setDeleting] = useState(false);
  const [hasPaymentConflict, setHasPaymentConflict] = useState(false);
  const blocked = hasExpensePaymentHistory(expense) || hasPaymentConflict;
  const close = () => { if (!pendingRef.current) onClose(); };
  const confirm = async () => {
    if (pendingRef.current || blocked) return;
    pendingRef.current = true;
    setDeleting(true);
    setError("");
    try {
      const message = await onConfirm();
      if (activeRef.current && message) setError(message);
    } catch (failure) {
      if (activeRef.current) {
        if (failure instanceof ExpenseDeleteError && failure.code === "HAS_PAYMENTS") setHasPaymentConflict(true);
        setError(failure instanceof Error ? failure.message : "Couldn\'t delete this expense. Please try again.");
      }
    } finally {
      pendingRef.current = false;
      if (activeRef.current) setDeleting(false);
    }
  };

  useEffect(() => {
    activeRef.current = true;
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.showModal();
    return () => { activeRef.current = false; if (previous?.isConnected) previous.focus(); };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="expense-form-dialog"
      aria-labelledby="expense-delete-title"
      onCancel={(event) => { event.preventDefault(); close(); }}
      onClick={(event) => { if (event.target === event.currentTarget) close(); }}
    >
      <div className="expense-form-content">
        <header className="modal-head">
          <div>
            <div className="eyebrow">EventWise</div>
            <h2 id="expense-delete-title">{blocked ? "Expense can't be deleted" : "Delete expense?"}</h2>
          </div>
          <button type="button" className="icon-btn" aria-label="Close delete dialog" disabled={deleting} onClick={close}>
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
          <button type="button" className="btn btn-secondary" autoFocus disabled={deleting} onClick={close}>
            {blocked ? "Close" : "Cancel"}
          </button>
          {!blocked && (
            <Button variant="danger" disabled={deleting} onClick={() => { void confirm(); }}>
              {deleting ? "Deleting..." : "Delete expense"}
            </Button>
          )}
        </footer>
      </div>
    </dialog>
  );
}
