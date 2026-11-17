import { useCallback } from "react";
import { useResource } from "../../hooks/useResource";
import { expenseService } from "../../services/expenseService";
import { formatCalendarDate } from "../../utils/dateFormat";

export function ExpensePaymentHistory({ eventId, expenseId }: { eventId: string; expenseId: string }) {
  const load = useCallback(() => expenseService.listPayments(eventId, expenseId), [eventId, expenseId]);
  const { data, loading, error, reload } = useResource(load);
  if (loading) return <p role="status">Loading payment history...</p>;
  if (error) return <div role="alert"><p>{error instanceof Error ? error.message : "Couldn't load payment history."}</p>
    <button type="button" className="btn btn-secondary" onClick={reload}>Retry payment history</button></div>;
  if (!data?.length) return <p>No payments recorded yet.</p>;
  return <ul className="expense-payment-history">{data.map(payment => <li key={payment.paymentId}>
    <div><strong>{payment.paymentType === "DEPOSIT" ? "Deposit" : payment.paymentType === "REFUND" ? "Refund" : "Payment"}</strong>
      <time dateTime={payment.paidAt}>{formatCalendarDate(payment.paidAt)}</time>
      {payment.notes && <p>{payment.notes}</p>}</div>
    <span>{(Number(payment.amount) * (payment.paymentType === "REFUND" ? -1 : 1)).toLocaleString("en-US", { style: "currency", currency: "USD" })}</span>
  </li>)}</ul>;
}
