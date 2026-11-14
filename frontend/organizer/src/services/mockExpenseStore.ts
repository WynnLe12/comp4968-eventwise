import { expensesSeed } from "../data/mockData";
import type { Expense } from "../types";
import { removeExpense } from "../features/expenses/expenseDeletion";

/**
 * Shared session-only adapter. Feature pages link by eventId/vendorId, never names.
 * A future HTTP service can map these IDs to the existing event-scoped expense API;
 * authentication, membership and vendor/category ownership must be enforced there.
 */
let records: Expense[] = structuredClone(expensesSeed);

export const mockExpenseStore = {
  list(eventId: string, query: { vendorId?: string | null } = {}): Expense[] {
    return structuredClone(records.filter((expense) =>
      expense.eventId === eventId && (!query.vendorId || expense.vendorId === query.vendorId),
    ));
  },
  save(eventId: string, expense: Expense): void {
    if (expense.eventId !== eventId ||
        records.some((record) => record.id === expense.id && record.eventId !== eventId)) {
      throw new Error("This expense belongs to another event.");
    }
    const saved = structuredClone(expense);
    const index = records.findIndex((record) => record.id === expense.id && record.eventId === eventId);
    records = index < 0 ? [...records, saved] : records.map((record, i) => i === index ? saved : record);
  },
  remove(eventId: string, id: string): void {
    const remaining = removeExpense(this.list(eventId), id);
    records = [...records.filter((record) => record.eventId !== eventId), ...remaining];
  },
  vendorTotals(eventId: string, vendorId: string) {
    const expenses = this.list(eventId, { vendorId });
    const paidCents = expenses.reduce((sum, expense) => sum + Math.round(expense.paid * 100), 0);
    const dates = expenses
      .filter((expense) => Math.round(expense.total * 100) > Math.round(expense.paid * 100))
      .map((expense) => expense.dueDate)
      .filter((date): date is string => Boolean(date))
      .sort();
    return { paidTotal: (paidCents / 100).toFixed(2), nextDueDate: dates[0] ?? null, expenseCount: expenses.length };
  },
};
