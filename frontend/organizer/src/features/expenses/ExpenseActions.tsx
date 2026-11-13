import { useId, useRef, useState } from "react";
import { Badge, Icon } from "../../components/ui";
import type { Expense } from "../../types";
import "./expenses.css";

function money(amount: number) {
  return amount.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export function ExpenseActions({ expense, onEdit, onRecordPayment, onDelete }: {
  expense: Expense;
  onEdit: () => void;
  onRecordPayment: () => void;
  onDelete: () => void;
}) {
  const fullyPaid = Math.round(expense.paid * 100) >= Math.round(expense.total * 100);
  const recordedPayments = [...(expense.payments ?? [])].reverse()
    .sort((a, b) => b.paidAt.localeCompare(a.paidAt));
  const earlierPaid = (Math.round(expense.paid * 100) -
    recordedPayments.reduce((sum, payment) => sum + Math.round(payment.amount * 100), 0)) / 100;
  const menuId = useId();
  const titleId = useId();
  const menuRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDialogElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });

  const positionMenu = (trigger: HTMLButtonElement) => {
    const rect = trigger.getBoundingClientRect();
    setPosition({
      top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 208)),
      left: Math.max(8, Math.min(rect.right - 176, window.innerWidth - 184)),
    });
  };

  const openDetails = () => {
    menuRef.current?.hidePopover();
    drawerRef.current?.showModal();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="icon-btn"
        aria-label={`Actions for ${expense.vendor}`}
        popoverTarget={menuId}
        onClick={(event) => positionMenu(event.currentTarget)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            positionMenu(event.currentTarget);
            menuRef.current?.showPopover();
            viewRef.current?.focus();
          }
        }}
      >
        <Icon name="more" />
      </button>
      <div
        id={menuId}
        ref={menuRef}
        popover="auto"
        className="expense-actions"
        aria-label={`Actions for ${expense.vendor}`}
        style={position}
      >
        <button ref={viewRef} type="button" onClick={openDetails}>
          <Icon name="receipt" size={16} /> View details
        </button>
        <button
          type="button"
          onClick={() => {
            menuRef.current?.hidePopover();
            triggerRef.current?.focus();
            onEdit();
          }}
        >
          <Icon name="edit" size={16} /> Edit expense
        </button>
        <button
          type="button" disabled={fullyPaid}
          title={fullyPaid ? "This expense is fully paid" : undefined}
          onClick={() => {
            menuRef.current?.hidePopover();
            triggerRef.current?.focus();
            onRecordPayment();
          }}
        >
          <Icon name="receipt" size={16} /> Record payment
        </button>
        <button
          type="button"
          className="expense-delete-action"
          onClick={() => {
            menuRef.current?.hidePopover();
            triggerRef.current?.focus();
            onDelete();
          }}
        >
          <Icon name="close" size={16} /> Delete expense
        </button>
      </div>
      <dialog
        ref={drawerRef}
        className="expense-drawer"
        aria-labelledby={titleId}
        onClose={() => triggerRef.current?.focus()}
        onClick={(event) => {
          if (event.target === event.currentTarget) drawerRef.current?.close();
        }}
      >
        <div className="expense-drawer-content">
          <header className="expense-drawer-head">
            <div>
              <div className="eyebrow">EventWise</div>
              <h2 id={titleId}>{expense.vendor}</h2>
              <Badge tone={expense.status === "Paid" ? "success" : expense.status === "Unpaid" ? "danger" : "warning"}>
                {expense.status}
              </Badge>
            </div>
            <button
              type="button"
              className="icon-btn"
              aria-label="Close expense details"
              onClick={() => drawerRef.current?.close()}
            >
              <Icon name="close" />
            </button>
          </header>
          <section className="expense-drawer-section">
            <h3>Expense details</h3>
            <dl>
              <div><dt>Category</dt><dd>{expense.category || "Uncategorized"}</dd></div>
              <div><dt>Due date</dt><dd>{expense.due}</dd></div>
            </dl>
          </section>
          <section className="expense-drawer-section">
            <h3>Payment summary</h3>
            <dl>
              <div><dt>Total amount</dt><dd>{money(expense.total)}</dd></div>
              <div><dt>Paid</dt><dd>{money(expense.paid)}</dd></div>
              <div><dt>Balance due</dt><dd>{money(expense.total - expense.paid)}</dd></div>
            </dl>
          </section>
          <section className="expense-drawer-section">
            <h3>Payment history</h3>
            {earlierPaid > 0 && <p>Previously paid: {money(earlierPaid)}</p>}
            {recordedPayments.length > 0 ? (
              <ul className="expense-payment-history">
                {recordedPayments.map((payment) => (
                  <li key={payment.id}>
                    <div>
                      <strong>{payment.paymentType === "DEPOSIT" ? "Deposit" : "Payment"}</strong>
                      <time dateTime={payment.paidAt}>{payment.paidAt}</time>
                    </div>
                    <span>{money(payment.amount)}</span>
                  </li>
                ))}
              </ul>
            ) : <p>{earlierPaid > 0 ? "Earlier payment details are not available." : "No payments recorded yet."}</p>}
          </section>
        </div>
      </dialog>
    </>
  );
}
