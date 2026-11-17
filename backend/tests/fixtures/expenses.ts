import { ApiError, invalid } from "../../expense-service/errors";
import { ExpenseService } from "../../expense-service/services/expenses";
import { cents, money } from "../../expense-service/services/validation";
import type { ExpenseInput, ExpenseQuery, ExpenseRepository, ExpenseRow, ExpenseTransaction, Payment, PaymentInput, PaymentQuery, SummaryRow } from "../../expense-service/types";

export const input: ExpenseInput = { categoryId: "4001", vendorId: "4001", description: "Venue", committedAmount: "1200.00", dueDate: "2026-11-10" };
export function row(overrides: Partial<ExpenseRow> = {}): ExpenseRow {
  return { ...input, expenseId: "4001", eventId: "400", categoryName: "Venue", vendorName: "Vendor", paidTotal: "200.00",
    createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", ...overrides };
}
export class MemoryRepository implements ExpenseRepository, ExpenseTransaction {
  rows = new Map<string, ExpenseRow>([["4001", row()], ["4010", row({ expenseId: "4010", eventId: "401" })]]);
  payments: Payment[] = [{ paymentId: "1", expenseId: "4001", amount: "200.00", paidAt: "2026-11-01", paymentType: "DEPOSIT", notes: null, createdAt: "2026-11-01T00:00:00Z" }];
  nextPayment = 9007199254740993n;
  locks = 0;
  async transaction<T>(work: (tx: ExpenseTransaction) => Promise<T>): Promise<T> {
    const snapshot = structuredClone(this.rows);
    const paymentSnapshot = structuredClone(this.payments);
    try { return await work(this); } catch (e) { this.rows = snapshot; this.payments = paymentSnapshot; throw e; }
  }
  async assertMember(event: string, sub: string) {
    if (!(event === "400" && ["owner", "planner"].includes(sub))) throw new ApiError(403, "FORBIDDEN", "No access.");
  }
  async summaryRows(event: string, today: string): Promise<SummaryRow[]> {
    const rows = [...this.rows.values()].filter(row => row.eventId === event);
    const outstanding = (r: ExpenseRow) => cents(r.committedAmount) - cents(r.paidTotal);
    const sum = (values: bigint[]) => money(values.reduce((a, b) => a + b, 0n));
    return [{ eventBudget: "2000.00", categoryId: "4001", categoryName: "Venue", plannedAmount: "1000.00",
      committedTotal: sum(rows.map(r => cents(r.committedAmount))), paidTotal: sum(rows.map(r => cents(r.paidTotal))),
      overdueTotal: sum(rows.filter(r => r.dueDate !== null && r.dueDate < today && outstanding(r) > 0n).map(outstanding)),
      dueThisMonthTotal: sum(rows.filter(r => r.dueDate?.slice(0, 7) === today.slice(0, 7) && outstanding(r) > 0n).map(outstanding)),
      expenseCount: rows.length, openExpenseCount: rows.filter(r => outstanding(r) > 0n).length,
      dueThisMonthCount: rows.filter(r => r.dueDate?.slice(0, 7) === today.slice(0, 7) && outstanding(r) > 0n).length, invalidCount: 0 }];
  }
  async validateAssociations(event: string, data: ExpenseInput) {
    if (event !== "400" || data.categoryId !== "4001") invalid("categoryId", "Wrong event.");
    if (data.vendorId !== null && data.vendorId !== "4001") invalid("vendorId", "Wrong event.");
  }
  async find(event: string, id: string, lock = false) {
    if (lock) this.locks++;
    const found = this.rows.get(id);
    return found?.eventId === event ? structuredClone(found) : null;
  }
  async list(event: string, query: ExpenseQuery) {
    const all = [...this.rows.values()].filter(r => r.eventId === event);
    return { rows: all.slice(query.offset, query.offset + query.limit), total: all.length };
  }
  async create(event: string, data: ExpenseInput) {
    const id = "9007199254740993";
    this.rows.set(id, row({ ...data, expenseId: id, eventId: event, paidTotal: "0.00" }));
    return id;
  }
  async update(event: string, id: string, data: ExpenseInput) {
    const old = await this.find(event, id);
    if (old) this.rows.set(id, { ...old, ...data });
  }
  async listPayments(event: string, id: string, query: PaymentQuery) {
    const all = (await this.find(event, id) ? this.payments.filter(p => p.expenseId === id) : [])
      .sort((a, b) => b.paidAt.localeCompare(a.paidAt) || (BigInt(a.paymentId) > BigInt(b.paymentId) ? -1 : 1));
    return { rows: all.slice(query.offset, query.offset + query.limit), total: all.length };
  }
  async createPayment(event: string, id: string, input: PaymentInput) {
    const expense = await this.find(event, id);
    if (!expense) throw new ApiError(404, "NOT_FOUND", "Not found.");
    const payment: Payment = { ...input, paymentId: String(this.nextPayment++), expenseId: id, createdAt: "2026-11-11T00:00:00Z" };
    this.payments.push(payment);
    this.rows.set(id, { ...expense, paidTotal: money(cents(expense.paidTotal) + cents(input.amount)) });
    return payment;
  }
  async remove(event: string, id: string) { if (await this.find(event, id)) this.rows.delete(id); }
}
export function setup() {
  const repository = new MemoryRepository();
  return { repository, service: new ExpenseService(repository, () => "2026-11-11") };
}
