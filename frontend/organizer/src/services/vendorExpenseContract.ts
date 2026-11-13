import type { Vendor } from "../types";
import { mockExpenseStore } from "./mockExpenseStore";
import { expenseFromDraft } from "../features/expenses/expenseDraft";

export class ContractExpenseError extends Error {}

export function contractExpenseSummary(vendor: Vendor) {
  const expenses = mockExpenseStore.list(vendor.eventId, { vendorId: vendor.id });
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

export function canAddContractExpense(vendor: Vendor) {
  return vendor.bookingStatus === "BOOKED" && vendor.contractStatus !== "CANCELLED" &&
    vendor.contractTotal !== null && contractExpenseSummary(vendor).expenses.length === 0;
}

export function planContractExpense(vendor: Vendor, total: string | null) {
  const summary = contractExpenseSummary(vendor);
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

export function syncContractExpense(vendor: Vendor, total: string) {
  const plan = planContractExpense(vendor, total);
  if (plan.expenses.length !== 1) throw new ContractExpenseError("Review the expense breakdown instead.");
  const expense = plan.expenses[0]!;
  mockExpenseStore.save(vendor.eventId, expenseFromDraft({
    name: expense.vendor, amount: total, dueDate: expense.dueDate ?? "",
  }, expense, false));
}

export function addContractExpense(vendor: Vendor) {
  if (!canAddContractExpense(vendor)) {
    throw new ContractExpenseError("This vendor already has expenses, or its contract isn't ready. Review linked expenses.");
  }
  const expense = expenseFromDraft({
    name: vendor.name + " contract", amount: vendor.contractTotal!, dueDate: "", vendorId: vendor.id,
  });
  mockExpenseStore.save(vendor.eventId, { ...expense, eventId: vendor.eventId });
}
