import type { Expense } from "../../types";

export function hasExpensePaymentHistory(expense: Expense): boolean {
  return Math.round(expense.paid * 100) !== 0 || Boolean(expense.payments?.length);
}

export function removeExpense(expenses: Expense[], id: string): Expense[] {
  const expense = expenses.find((row) => row.id === id);
  if (!expense) throw new Error("This expense is no longer available.");
  if (hasExpensePaymentHistory(expense)) {
    throw new Error("This expense has payment history and can't be deleted.");
  }
  return expenses.filter((row) => row.id !== id);
}
