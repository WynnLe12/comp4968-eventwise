import assert from "node:assert/strict";
import { test } from "node:test";
import { buildExpenseSummary } from "../expense-service/services/summary";
import type { SummaryRow } from "../expense-service/types";
import { ApiError } from "../expense-service/errors";
function row(overrides: Partial<SummaryRow> = {}): SummaryRow {
  return { eventBudget: "2000.00", categoryId: "4001", categoryName: "Venue", plannedAmount: "1000.00",
    committedTotal: "1200.00", paidTotal: "200.00", overdueTotal: "1000.00", dueThisMonthTotal: "1000.00",
    expenseCount: "1", openExpenseCount: "1", dueThisMonthCount: "1", invalidCount: "0", ...overrides };
}
function empty(overrides: Partial<SummaryRow> = {}): SummaryRow {
  return row({ plannedAmount: "0.00", committedTotal: "0.00", paidTotal: "0.00", overdueTotal: "0.00", dueThisMonthTotal: "0.00",
    expenseCount: 0, openExpenseCount: 0, dueThisMonthCount: 0, ...overrides });
}
test("summary reproduces all fixed fixture totals and preserves category order", () => {
  const result = buildExpenseSummary("400", "2026-11-11", [row(),
    row({ categoryId: "4002", categoryName: "Supplies", plannedAmount: "500.00", committedTotal: "500.30", paidTotal: "300.30", overdueTotal: "0.00", dueThisMonthTotal: "200.00", expenseCount: 3 }),
    row({ categoryId: "4003", categoryName: "Other", plannedAmount: "500.00", committedTotal: "600.00", paidTotal: "80.00", overdueTotal: "420.00", dueThisMonthTotal: "420.00", expenseCount: 3, openExpenseCount: 2 }),
    empty({ categoryId: "4004", categoryName: "Empty category" })]);
  assert.deepEqual({ ...result, categories: undefined }, {
    eventId: "400", asOfDate: "2026-11-11", eventBudget: "2000.00", allocatedBudget: "2000.00", unallocatedBudget: "0.00",
    committedTotal: "2300.30", paidTotal: "580.30", outstandingTotal: "1720.00", remainingBudget: "-300.30", isOverBudget: true,
    overdueTotal: "1420.00", dueThisMonthTotal: "1620.00", expenseCount: 7, openExpenseCount: 4, dueThisMonthCount: 3, categories: undefined });
  assert.deepEqual(result.categories.map(c => c.categoryId), ["4001", "4002", "4003", "4004"]);
  assert.equal(result.categories[1]?.remainingBudget, "-0.30");
  assert.equal(result.categories[3]?.outstandingTotal, "0.00");
  assert.equal(result.categories[3]?.isOverBudget, false);
});
test("category-less and empty events retain their budgets and zero totals", () => {
  const bare = buildExpenseSummary("402", "2026-11-11", [empty({ categoryId: null, categoryName: null, eventBudget: "50.00" })]);
  assert.equal(bare.categories.length, 0); assert.equal(bare.unallocatedBudget, "50.00");
  assert.equal(bare.remainingBudget, "50.00"); assert.equal(bare.expenseCount, 0);
  const category = buildExpenseSummary("402", "2026-11-11", [empty({ eventBudget: "50.00", plannedAmount: "10.00" })]);
  assert.equal(category.categories.length, 1); assert.equal(category.unallocatedBudget, "40.00");
});
test("over-allocation is separate from an actual committed budget overrun", () => {
  const result = buildExpenseSummary("400", "2026-11-11", [empty({ eventBudget: "50.00", plannedAmount: "60.00" })]);
  assert.equal(result.unallocatedBudget, "-10.00"); assert.equal(result.isOverBudget, false);
  assert.equal(result.remainingBudget, "50.00");
});
test("summary sums beyond a single DECIMAL column limit without precision loss", () => {
  const base = empty({ eventBudget: "9999999999.99", plannedAmount: "9999999999.99", committedTotal: "9999999999.99", expenseCount: 1, openExpenseCount: 1 });
  const result = buildExpenseSummary("400", "2026-11-11", [base, { ...base, categoryId: "4002" }]);
  assert.equal(result.committedTotal, "19999999999.98"); assert.equal(result.remainingBudget, "-9999999999.99");
});
test("invalid per-expense invariants cannot cancel out inside aggregate totals", () => {
  assert.throws(() => buildExpenseSummary("400", "2026-11-11", [row({ invalidCount: 1 })]), e => e instanceof ApiError && e.status === 500);
  assert.throws(() => buildExpenseSummary("400", "2026-11-11", [row({ expenseCount: "9007199254740992" })]));
  assert.throws(() => buildExpenseSummary("400", "2026-11-11", [row({ paidTotal: "1200.01" })]));
  assert.throws(() => buildExpenseSummary("400", "2026-11-11", []), e => e instanceof ApiError && e.status === 404);
});
