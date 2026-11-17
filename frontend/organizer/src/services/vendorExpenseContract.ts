import type { Expense, Vendor } from "../types";

export class ContractExpenseError extends Error {}

// Mutations use the real APIs. Planning helpers only inspect an explicit event snapshot.
export const CONTRACT_EXPENSES_ENABLED = false;

export function contractExpenseSummary(vendor: Vendor, source?: readonly Expense[]) {
  const expenses = source !== undefined
    ? source.filter(expense => expense.eventId === vendor.eventId && expense.vendorId === vendor.id)
    : [];
  const totalCents = expenses.reduce((sum, expense) => sum + Math.round(expense.total * 100), 0);
  const paidCents = expenses.reduce((sum, expense) => sum + Math.round(expense.paid * 100), 0);
  return {
    expenses,
    total: (totalCents / 100).toFixed(2),
    paidCents,
    mismatch: expenses.length > 0 && vendor.contractTotal !== null &&
      Math.round(Number(vendor.contractTotal) * 100) !== totalCents,
  };
}

export function canAddContractExpense(vendor: Vendor, source?: readonly Expense[]) {
  return (source !== undefined || CONTRACT_EXPENSES_ENABLED) && vendor.bookingStatus === "BOOKED" && vendor.contractStatus !== "CANCELLED" &&
    vendor.contractTotal !== null && contractExpenseSummary(vendor, source).expenses.length === 0;
}

export function planContractExpense(vendor: Vendor, total: string | null, source?: readonly Expense[]) {
  const summary = contractExpenseSummary(vendor, source);
  if (total === null) return { ...summary, mode: "none" as const, total: null };
  const amountCents = Math.round(Number(total) * 100);
  if (!Number.isFinite(amountCents) || amountCents < 0) throw new ContractExpenseError("Enter a valid contract amount.");
  if (amountCents < summary.paidCents) {
    throw new ContractExpenseError("Contract amount can't be less than " +
      (summary.paidCents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" }) + " already paid.");
  }
  const linkedTotal = summary.total;
  const mode = summary.expenses.length === 0 ? "create" :
    amountCents === Math.round(Number(linkedTotal) * 100) ? "none" :
    summary.expenses.length === 1 ? "single" : "multiple";
  return { ...summary, mode, total: (amountCents / 100).toFixed(2), linkedTotal };
}
export type ContractExpensePlan = ReturnType<typeof planContractExpense>;
export type ContractExpenseChoice = "keep" | "sync" | "review" | "create";
