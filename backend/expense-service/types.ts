export type PaymentStatus = "UNPAID" | "PARTIALLY_PAID" | "PAID";
export interface ExpenseInput {
  categoryId: string;
  vendorId: string | null;
  description: string;
  committedAmount: string;
  dueDate: string | null;
}
export interface ExpenseRow extends ExpenseInput {
  expenseId: string;
  eventId: string;
  categoryName: string;
  vendorName: string | null;
  paidTotal: string;
  createdAt: string;
  updatedAt: string;
}
export interface Expense extends ExpenseRow {
  outstandingAmount: string;
  paymentStatus: PaymentStatus;
  isOverdue: boolean;
}
export interface ExpenseQuery {
  limit: number;
  offset: number;
  categoryId?: string;
  vendorId?: string;
  paymentStatus?: PaymentStatus;
  overdue?: boolean;
  q?: string;
}
export interface ExpenseTransaction {
  assertMember(eventId: string, sub: string): Promise<void>;
  validateAssociations(eventId: string, input: ExpenseInput): Promise<void>;
  find(eventId: string, expenseId: string, lock?: boolean): Promise<ExpenseRow | null>;
  list(eventId: string, query: ExpenseQuery, today: string): Promise<{ rows: ExpenseRow[]; total: number }>;
  create(eventId: string, input: ExpenseInput): Promise<string>;
  update(eventId: string, expenseId: string, input: ExpenseInput): Promise<void>;
  remove(eventId: string, expenseId: string): Promise<void>;
}
export interface ExpenseRepository {
  transaction<T>(work: (tx: ExpenseTransaction) => Promise<T>): Promise<T>;
}
