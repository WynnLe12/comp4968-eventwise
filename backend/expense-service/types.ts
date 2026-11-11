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
  summaryRows(eventId: string, today: string): Promise<SummaryRow[]>;
  validateAssociations(eventId: string, input: ExpenseInput): Promise<void>;
  find(eventId: string, expenseId: string, lock?: boolean): Promise<ExpenseRow | null>;
  list(eventId: string, query: ExpenseQuery, today: string): Promise<{ rows: ExpenseRow[]; total: number }>;
  create(eventId: string, input: ExpenseInput): Promise<string>;
  update(eventId: string, expenseId: string, input: ExpenseInput): Promise<void>;
  remove(eventId: string, expenseId: string): Promise<void>;
  listPayments(eventId: string, expenseId: string, query: PaymentQuery): Promise<{ rows: Payment[]; total: number }>;
  createPayment(eventId: string, expenseId: string, input: PaymentInput): Promise<Payment>;
}
export interface ExpenseRepository {
  transaction<T>(work: (tx: ExpenseTransaction) => Promise<T>): Promise<T>;
}

export interface PaymentInput {
  amount: string;
  paidAt: string;
  paymentType: "DEPOSIT" | "PAYMENT";
  notes: string | null;
}
export interface Payment {
  paymentId: string;
  expenseId: string;
  amount: string;
  paidAt: string;
  paymentType: "DEPOSIT" | "PAYMENT" | "REFUND";
  notes: string | null;
  createdAt: string;
}
export interface PaymentQuery {
  limit: number;
  offset: number;
}

// One SQL snapshot row per category; a category-less event returns one null-category row.
export interface SummaryRow {
  eventBudget: string;
  categoryId: string | null;
  categoryName: string | null;
  plannedAmount: string;
  committedTotal: string;
  paidTotal: string;
  overdueTotal: string;
  dueThisMonthTotal: string;
  expenseCount: string | number;
  openExpenseCount: string | number;
  dueThisMonthCount: string | number;
  invalidCount: string | number;
}
export interface CategorySummary {
  categoryId: string;
  categoryName: string;
  plannedAmount: string;
  committedTotal: string;
  paidTotal: string;
  outstandingTotal: string;
  remainingBudget: string;
  isOverBudget: boolean;
  overdueTotal: string;
}
export interface ExpenseSummary {
  eventId: string;
  asOfDate: string;
  eventBudget: string;
  allocatedBudget: string;
  unallocatedBudget: string;
  committedTotal: string;
  paidTotal: string;
  outstandingTotal: string;
  remainingBudget: string;
  isOverBudget: boolean;
  overdueTotal: string;
  dueThisMonthTotal: string;
  expenseCount: number;
  openExpenseCount: number;
  dueThisMonthCount: number;
  categories: CategorySummary[];
}
