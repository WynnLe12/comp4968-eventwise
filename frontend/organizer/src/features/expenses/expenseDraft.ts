import type { Expense } from "../../types";

export interface ExpenseDraft {
  name: string;
  amount: string;
  dueDate: string;
}

export type ExpenseDraftErrors = Partial<Record<keyof ExpenseDraft, string>>;

export function validateExpenseDraft(draft: ExpenseDraft, paid = 0): ExpenseDraftErrors {
  const errors: ExpenseDraftErrors = {};
  if (!draft.name.trim() || draft.name.trim().length > 255) {
    errors.name = draft.name.trim() ? "Use 255 characters or fewer." : "Expense name is required.";
  }
  if (!/^(0|[1-9][0-9]{0,9})(\.[0-9]{1,2})?$/.test(draft.amount.trim())) {
    errors.amount = "Enter an amount of 0 or more, with up to 2 decimals.";
  }
  if (!errors.amount && Math.round(Number(draft.amount.trim()) * 100) < Math.round(paid * 100)) {
    errors.amount = "Total can't be less than " +
      paid.toLocaleString("en-US", { style: "currency", currency: "USD" }) + " already paid.";
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
export function expenseFromDraft(
  draft: ExpenseDraft,
  original?: Expense,
  dueDateChanged = true,
): Expense {
  const total = Number(draft.amount.trim());
  const paid = original?.paid ?? 0;
  const fullyPaid = Math.round(total * 100) === Math.round(paid * 100);
  const keepDueDate = original && !dueDateChanged;
  return {
    ...original,
    id: original?.id ?? crypto.randomUUID(),
    vendor: draft.name.trim(),
    category: original?.category ?? "Uncategorized",
    total,
    paid,
    due: keepDueDate ? (original.due === "Paid" ? "No due date" : original.due) : draft.dueDate || "No due date",
    dueDate: keepDueDate ? original.dueDate : draft.dueDate || null,
    status: fullyPaid ? "Paid" : paid === 0 ? "Unpaid" :
      original?.status === "Deposit paid" ? "Deposit paid" : "Partially paid",
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
