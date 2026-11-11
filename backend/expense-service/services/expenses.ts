import { buildExpenseSummary } from "./summary";
import { ApiError } from "../errors";
import type { Expense, ExpenseInput, ExpenseQuery, ExpenseRepository, ExpenseRow, PaymentQuery } from "../types";
import { parsePaymentBody } from "./payment-validation";
import { cents, money, parseExpenseBody, parseId } from "./validation";

export function presentExpense(row: ExpenseRow, today: string): Expense {
  const committed = cents(row.committedAmount);
  const paid = cents(row.paidTotal);
  if (paid < 0n || paid > committed || committed < 0n) {
    throw new ApiError(500, "INTERNAL_ERROR", "Invalid stored financial value.");
  }
  const outstanding = committed - paid;
  return { ...row, committedAmount: money(committed), paidTotal: money(paid),
    outstandingAmount: money(outstanding),
    paymentStatus: outstanding === 0n ? "PAID" : paid === 0n ? "UNPAID" : "PARTIALLY_PAID",
    isOverdue: outstanding > 0n && row.dueDate !== null && row.dueDate < today };
}
function requireRow(row: ExpenseRow | null): ExpenseRow {
  if (!row) throw new ApiError(404, "NOT_FOUND", "Expense not found.");
  return row;
}
export class ExpenseService {
  constructor(private repository: ExpenseRepository, private today = () => new Date().toISOString().slice(0, 10)) {}
  private event(value: string, sub: string): void {
    parseId(value, "eventId", true);
    if (!sub) throw new ApiError(401, "UNAUTHENTICATED", "Sign in to continue.");
  }
  async summary(eventId: string, sub: string) {
    this.event(eventId, sub);
    const today = this.today();
    return this.repository.transaction(async tx => {
      await tx.assertMember(eventId, sub);
      return buildExpenseSummary(eventId, today, await tx.summaryRows(eventId, today));
    });
  }
  async list(eventId: string, sub: string, query: ExpenseQuery) {
    this.event(eventId, sub);
    const today = this.today();
    return this.repository.transaction(async tx => {
      await tx.assertMember(eventId, sub);
      const result = await tx.list(eventId, query, today);
      return { data: result.rows.map(row => presentExpense(row, today)), total: result.total, limit: query.limit, offset: query.offset };
    });
  }
  async get(eventId: string, expenseId: string, sub: string): Promise<Expense> {
    this.event(eventId, sub); parseId(expenseId, "expenseId", true);
    return this.repository.transaction(async tx => {
      await tx.assertMember(eventId, sub);
      return presentExpense(requireRow(await tx.find(eventId, expenseId)), this.today());
    });
  }
  async create(eventId: string, sub: string, body: unknown): Promise<Expense> {
    this.event(eventId, sub);
    return this.repository.transaction(async tx => {
      await tx.assertMember(eventId, sub);
      const input = parseExpenseBody(body, false) as ExpenseInput;
      await tx.validateAssociations(eventId, input);
      const id = await tx.create(eventId, input);
      return presentExpense(requireRow(await tx.find(eventId, id)), this.today());
    });
  }
  async update(eventId: string, expenseId: string, sub: string, body: unknown): Promise<Expense> {
    this.event(eventId, sub); parseId(expenseId, "expenseId", true);
    return this.repository.transaction(async tx => {
      await tx.assertMember(eventId, sub);
      const row = requireRow(await tx.find(eventId, expenseId, true));
      presentExpense(row, this.today());
      const changes = parseExpenseBody(body, true);
      const input: ExpenseInput = { categoryId: row.categoryId, vendorId: row.vendorId, description: row.description,
        committedAmount: row.committedAmount, dueDate: row.dueDate, ...changes };
      if (cents(input.committedAmount) < cents(row.paidTotal)) {
        throw new ApiError(409, "AMOUNT_BELOW_PAID", "Committed amount cannot be below net paid.");
      }
      await tx.validateAssociations(eventId, input);
      await tx.update(eventId, expenseId, input);
      return presentExpense(requireRow(await tx.find(eventId, expenseId)), this.today());
    });
  }
  async listPayments(eventId: string, expenseId: string, sub: string, query: PaymentQuery) {
    this.event(eventId, sub); parseId(expenseId, "expenseId", true);
    return this.repository.transaction(async tx => {
      await tx.assertMember(eventId, sub);
      // Prevent a concurrent delete/payment write from changing history mid-read.
      requireRow(await tx.find(eventId, expenseId, true));
      const result = await tx.listPayments(eventId, expenseId, query);
      return { data: result.rows, total: result.total, limit: query.limit, offset: query.offset };
    });
  }
  async recordPayment(eventId: string, expenseId: string, sub: string, body: unknown) {
    this.event(eventId, sub); parseId(expenseId, "expenseId", true);
    return this.repository.transaction(async tx => {
      await tx.assertMember(eventId, sub);
      // Same parent-row lock as expense updates/deletes. Always lock BEFORE reading balance.
      const row = requireRow(await tx.find(eventId, expenseId, true));
      const today = this.today();
      const current = presentExpense(row, today);
      const input = parsePaymentBody(body, today);
      if (cents(input.amount) > cents(current.outstandingAmount)) {
        throw new ApiError(409, "PAYMENT_EXCEEDS_BALANCE", "Payment exceeds the outstanding balance.");
      }
      const payment = await tx.createPayment(eventId, expenseId, input);
      const expense = presentExpense(requireRow(await tx.find(eventId, expenseId)), today);
      return { payment, expense };
    });
  }
  async remove(eventId: string, expenseId: string, sub: string): Promise<void> {
    this.event(eventId, sub); parseId(expenseId, "expenseId", true);
    return this.repository.transaction(async tx => {
      await tx.assertMember(eventId, sub);
      requireRow(await tx.find(eventId, expenseId, true));
      await tx.remove(eventId, expenseId);
    });
  }
}
