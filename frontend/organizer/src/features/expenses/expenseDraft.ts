import type { Expense } from "../../types";

export interface ExpenseDraft {
  name: string;
  amount: string;
  dueDate: string;
}

export type ExpenseDraftErrors = Partial<Record<keyof ExpenseDraft, string>>;

export function validateExpenseDraft(draft: ExpenseDraft): ExpenseDraftErrors {
  const errors: ExpenseDraftErrors = {};
  if (!draft.name.trim() || draft.name.trim().length > 255) {
    errors.name = "Enter an expense name using 1 to 255 characters.";
  }
  if (!/^(0|[1-9][0-9]{0,9})(\.[0-9]{1,2})?$/.test(draft.amount.trim())) {
    errors.amount = "Enter an amount from 0 to 9,999,999,999.99 with up to 2 decimals.";
  }
  if (draft.dueDate) {
    const parsed = new Date(draft.dueDate + "T00:00:00Z");
    if (
      !/^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}$/.test(draft.dueDate) ||
      Number.isNaN(parsed.valueOf()) ||
      parsed.toISOString().slice(0, 10) !== draft.dueDate
    ) {
      errors.dueDate = "Enter a valid due date.";
    }
  }
  return errors;
}

// The local model still uses vendor as the table's combined vendor/expense label.
export function expenseFromDraft(draft: ExpenseDraft): Expense {
  const total = Number(draft.amount.trim());
  return {
    id: crypto.randomUUID(),
    vendor: draft.name.trim(),
    category: "Uncategorized",
    total,
    paid: 0,
    due: draft.dueDate || "No due date",
    dueDate: draft.dueDate || null,
    status: total === 0 ? "Paid" : "Unpaid",
  };
}

export function expenseSummary(expenses: Expense[], today = new Date()) {
  const cents = (amount: number) => Math.round(amount * 100);
  const total = expenses.reduce((sum, expense) => sum + cents(expense.total), 0);
  const paid = expenses.reduce((sum, expense) => sum + cents(expense.paid), 0);
  const open = expenses.filter((expense) => cents(expense.total) > cents(expense.paid));
  const month = String(today.getFullYear()) + "-" + String(today.getMonth() + 1).padStart(2, "0");
  // Legacy sample rows have month/day labels without a year; don't invent a date for them.
  const due = open.filter((expense) => expense.dueDate?.startsWith(month));
  return {
    total: total / 100,
    paid: paid / 100,
    outstanding: (total - paid) / 100,
    paidPercent: total === 0 ? 0 : Math.round(paid / total * 100),
    openCount: open.length,
    dueCount: due.length,
    dueThisMonth: due.reduce((sum, expense) => sum + cents(expense.total) - cents(expense.paid), 0) / 100,
  };
}
