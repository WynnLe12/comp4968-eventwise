import { ApiError } from "../errors";
import type { CategorySummary, ExpenseSummary, SummaryRow } from "../types";
import { cents, money } from "./validation";

function count(value: number | string): number {
  if (!/^[0-9]+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
    throw new ApiError(500, "INTERNAL_ERROR", "Invalid summary count.");
  }
  return Number(value);
}
export function buildExpenseSummary(eventId: string, today: string, rows: SummaryRow[]): ExpenseSummary {
  if (!rows.length) throw new ApiError(404, "NOT_FOUND", "Event not found.");
  const eventBudget = cents(rows[0]!.eventBudget);
  if (eventBudget < 0n) throw new ApiError(500, "INTERNAL_ERROR", "Invalid event budget.");
  let allocated = 0n, committed = 0n, paid = 0n, overdue = 0n, dueMonth = 0n;
  let expenseCount = 0, openExpenseCount = 0, dueThisMonthCount = 0;
  const categories: CategorySummary[] = [];
  for (const row of rows) {
    if (count(row.invalidCount) !== 0 || cents(row.eventBudget) !== eventBudget) {
      throw new ApiError(500, "INTERNAL_ERROR", "Invalid stored financial value.");
    }
    if (row.categoryId === null) continue;
    const planned = cents(row.plannedAmount), categoryCommitted = cents(row.committedTotal), categoryPaid = cents(row.paidTotal);
    const categoryOverdue = cents(row.overdueTotal), categoryMonth = cents(row.dueThisMonthTotal);
    if (planned < 0n || categoryCommitted < 0n || categoryPaid < 0n || categoryPaid > categoryCommitted ||
        categoryOverdue < 0n || categoryMonth < 0n || categoryOverdue > categoryCommitted - categoryPaid || categoryMonth > categoryCommitted - categoryPaid) {
      throw new ApiError(500, "INTERNAL_ERROR", "Invalid stored financial value.");
    }
    allocated += planned; committed += categoryCommitted; paid += categoryPaid;
    overdue += categoryOverdue; dueMonth += categoryMonth;
    expenseCount += count(row.expenseCount); openExpenseCount += count(row.openExpenseCount); dueThisMonthCount += count(row.dueThisMonthCount);
    categories.push({ categoryId: row.categoryId, categoryName: row.categoryName ?? "",
      plannedAmount: money(planned), committedTotal: money(categoryCommitted), paidTotal: money(categoryPaid),
      outstandingTotal: money(categoryCommitted - categoryPaid), remainingBudget: money(planned - categoryCommitted),
      isOverBudget: categoryCommitted > planned, overdueTotal: money(categoryOverdue) });
  }
  if (![expenseCount, openExpenseCount, dueThisMonthCount].every(Number.isSafeInteger) ||
      openExpenseCount > expenseCount || dueThisMonthCount > openExpenseCount) {
    throw new ApiError(500, "INTERNAL_ERROR", "Invalid summary count.");
  }
  return { eventId, asOfDate: today, eventBudget: money(eventBudget), allocatedBudget: money(allocated),
    unallocatedBudget: money(eventBudget - allocated), committedTotal: money(committed), paidTotal: money(paid),
    outstandingTotal: money(committed - paid), remainingBudget: money(eventBudget - committed),
    isOverBudget: committed > eventBudget, overdueTotal: money(overdue), dueThisMonthTotal: money(dueMonth),
    expenseCount, openExpenseCount, dueThisMonthCount, categories };
}
