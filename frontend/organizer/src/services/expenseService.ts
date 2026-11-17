import { requireAuthSession } from "../features/auth/services/authService";
import { apiUrl } from "./apiConfig";
import type { Expense } from "../types";

interface ApiExpense {
  expenseId: string;
  eventId: string;
  categoryId: string;
  categoryName: string;
  vendorId: string | null;
  description: string;
  committedAmount: string;
  paidTotal: string;
  dueDate: string | null;
  paymentStatus: "UNPAID" | "PARTIALLY_PAID" | "PAID";
}
interface ExpensePage { data: ApiExpense[]; total: number; limit: number; offset: number }

const invalidResponse = () => new Error("We couldn\'t read this event\'s expenses. Please try again.");
const statuses = { UNPAID: "Unpaid", PARTIALLY_PAID: "Partially paid", PAID: "Paid" };

function mapExpense(row: ApiExpense, eventId: string): Expense {
  if (!row || row.eventId !== eventId || typeof row.expenseId !== "string" ||
      typeof row.categoryId !== "string" || typeof row.categoryName !== "string" ||
      typeof row.description !== "string" || !Object.hasOwn(statuses, row.paymentStatus) ||
      ![row.committedAmount, row.paidTotal].every(value => typeof value === "string" && /^\d{1,10}\.\d{2}$/.test(value)) ||
      Number(row.paidTotal) > Number(row.committedAmount) ||
      !(row.vendorId === null || typeof row.vendorId === "string") ||
      !(row.dueDate === null || typeof row.dueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.dueDate))) throw invalidResponse();
  return {
    id: row.expenseId, eventId: row.eventId, categoryId: row.categoryId,
    category: row.categoryName, vendorId: row.vendorId, vendor: row.description,
    total: Number(row.committedAmount), paid: Number(row.paidTotal),
    dueDate: row.dueDate, due: row.dueDate ?? "No due date", status: statuses[row.paymentStatus],
  };
}

export interface CreateExpenseInput {
  categoryId: string;
  vendorId: string | null;
  description: string;
  committedAmount: string;
  dueDate: string | null;
}

export class ExpenseSaveError extends Error {
  constructor(message: string, public readonly fields: Record<string, string> = {}) {
    super(message);
    this.name = "ExpenseSaveError";
  }
}

async function saveExpenseRequest(eventId: string, input: CreateExpenseInput, expenseId?: string): Promise<Expense> {
    let token: string | undefined;
    try { token = (await requireAuthSession()).session.tokens?.accessToken?.toString(); } catch { /* Show the sign-in message below. */ }
    if (!token) throw new ExpenseSaveError("Your session has expired. Please sign in again.");
    let response: Response;
    try {
      response = await fetch(apiUrl("/events/" + encodeURIComponent(eventId) + "/expenses" + (expenseId === undefined ? "" : "/" + encodeURIComponent(expenseId))), {
        method: expenseId === undefined ? "POST" : "PATCH", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ categoryId: input.categoryId, vendorId: input.vendorId,
          description: input.description, committedAmount: input.committedAmount, dueDate: input.dueDate }),
      });
    } catch { throw new ExpenseSaveError("We couldn\'t reach the server. Check your connection and try again."); }
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 409 && body?.error?.code === "AMOUNT_BELOW_PAID") {
        throw new ExpenseSaveError("Payments have changed. Refresh the expenses before trying a lower total.", {
          amount: "Total cannot be less than the amount already paid.",
        });
      }
      if (response.status === 422) {
        const fields: Record<string, string> = {};
        const messages: Record<string, string> = {
          categoryId: "Choose a category from this event.", vendorId: "Choose a vendor from this event.",
          name: "Enter an expense name using 1 to 255 characters.",
          amount: "Enter an amount of 0 or more, with up to 2 decimals.", dueDate: "Enter a valid due date.",
        };
        const names: Record<string, string> = { categoryId: "categoryId", vendorId: "vendorId", description: "name", committedAmount: "amount", dueDate: "dueDate" };
        for (const key of Object.keys(body?.error?.fields ?? {})) {
          if (Object.hasOwn(names, key)) fields[names[key]!] = messages[names[key]!]!;
        }
        throw new ExpenseSaveError("Please check the expense details and try again.", fields);
      }
      const messages: Record<number, string> = {
        401: "Your session has expired. Please sign in again.", 403: "You don\'t have access to this event.",
        404: "This event or expense is no longer available. Refresh your events and try again.",
        409: "This expense could not be saved. Check its category and vendor, then try again.",
      };
      throw new ExpenseSaveError(messages[response.status] ?? "We couldn\'t save the expense. Please try again.");
    }
    const saved = mapExpense(body?.data, eventId);
    if (expenseId !== undefined && saved.id !== expenseId) throw invalidResponse();
    return saved;
}

export class ExpenseDeleteError extends Error {
  constructor(message: string, public readonly code?: string) { super(message); this.name = "ExpenseDeleteError"; }
}

export interface SavedExpensePayment {
  paymentId: string;
  expenseId: string;
  amount: string;
  paidAt: string;
  paymentType: "PAYMENT" | "DEPOSIT" | "REFUND";
  notes: string | null;
}
export interface RecordPaymentInput {
  amount: string;
  paidAt: string;
  paymentType: "PAYMENT" | "DEPOSIT";
}
function checkPayment(payment: SavedExpensePayment, expenseId: string): SavedExpensePayment {
  if (!payment || payment.expenseId !== expenseId || typeof payment.paymentId !== "string" ||
      typeof payment.amount !== "string" || !/^\d{1,10}\.\d{2}$/.test(payment.amount) || Number(payment.amount) <= 0 ||
      typeof payment.paidAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(payment.paidAt) ||
      !["PAYMENT", "DEPOSIT", "REFUND"].includes(payment.paymentType) ||
      !(payment.notes === null || typeof payment.notes === "string")) throw invalidResponse();
  return payment;
}
async function paymentRequest(eventId: string, expenseId: string, offset?: number, input?: RecordPaymentInput) {
  let token: string | undefined;
  try { token = (await requireAuthSession()).session.tokens?.accessToken?.toString(); } catch { /* Show the sign-in message below. */ }
  if (!token) throw new ExpenseSaveError("Your session has expired. Please sign in again.");
  let response: Response;
  try {
    response = await fetch(apiUrl("/events/" + encodeURIComponent(eventId) + "/expenses/" + encodeURIComponent(expenseId) + "/payments" +
      (input ? "" : "?limit=100&offset=" + offset)), {
      method: input ? "POST" : "GET", headers: { Authorization: "Bearer " + token, ...(input ? { "Content-Type": "application/json" } : {}) },
      body: input ? JSON.stringify({ amount: input.amount, paidAt: input.paidAt, paymentType: input.paymentType, notes: null }) : undefined,
    });
  } catch { throw new ExpenseSaveError("We couldn't reach the server. Check your connection and try again."); }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 409 && body?.error?.code === "PAYMENT_EXCEEDS_BALANCE") {
      throw new ExpenseSaveError("The remaining balance has changed. Close this form and refresh before recording another payment.", { amount: "Payment cannot exceed the remaining balance." });
    }
    if (response.status === 422) {
      const fields: Record<string, string> = {};
      const messages: Record<string, string> = { amount: "Enter a valid payment greater than 0, with up to 2 decimals.", paidAt: "Enter a valid payment date no later than today.", paymentType: "Choose Payment or Deposit." };
      for (const field of Object.keys(body?.error?.fields ?? {})) if (Object.hasOwn(messages, field)) fields[field] = messages[field]!;
      throw new ExpenseSaveError("Please check the payment details and try again.", fields);
    }
    const messages: Record<number, string> = { 401: "Your session has expired. Please sign in again.", 403: "You don't have access to this event.", 404: "This expense is no longer available. Refresh the page." };
    throw new ExpenseSaveError(messages[response.status] ?? (input ? "We couldn't record this payment. Please try again." : "We couldn't load payment history. Please try again."));
  }
  if (!body) throw invalidResponse();
  return body;
}

export const expenseService = {
  async recordPayment(eventId: string, expenseId: string, input: RecordPaymentInput): Promise<Expense> {
    const body = await paymentRequest(eventId, expenseId, undefined, input);
    checkPayment(body.data?.payment, expenseId);
    const expense = mapExpense(body.data?.expense, eventId);
    if (expense.id !== expenseId) throw invalidResponse();
    return expense;
  },
  async listPayments(eventId: string, expenseId: string): Promise<SavedExpensePayment[]> {
    const payments: SavedExpensePayment[] = [], ids = new Set<string>();
    let offset = 0;
    while (true) {
      const page = await paymentRequest(eventId, expenseId, offset);
      if (!Array.isArray(page.data) || !Number.isSafeInteger(page.total) || page.total < 0 || page.offset !== offset ||
          !Number.isInteger(page.limit) || page.limit < 1 || page.limit > 100 || page.data.length > page.limit) throw invalidResponse();
      for (const row of page.data) {
        const payment = checkPayment(row, expenseId);
        if (ids.has(payment.paymentId)) throw invalidResponse();
        ids.add(payment.paymentId); payments.push(payment);
      }
      offset += page.data.length;
      if (offset >= page.total) return payments;
      if (!page.data.length) throw invalidResponse();
    }
  },
  async remove(eventId: string, expenseId: string): Promise<void> {
    let token: string | undefined;
    try { token = (await requireAuthSession()).session.tokens?.accessToken?.toString(); } catch { /* Show the sign-in message below. */ }
    if (!token) throw new ExpenseDeleteError("Your session has expired. Please sign in again.");
    let response: Response;
    try {
      response = await fetch(apiUrl("/events/" + encodeURIComponent(eventId) + "/expenses/" + encodeURIComponent(expenseId)), {
        method: "DELETE", headers: { Authorization: "Bearer " + token },
      });
    } catch { throw new ExpenseDeleteError("We couldn\'t reach the server. Check your connection and try again."); }
    if (response.status === 204) return;
    const body = await response.json().catch(() => null);
    if (response.status === 409 && body?.error?.code === "HAS_PAYMENTS") {
      throw new ExpenseDeleteError("This expense has payment history and cannot be deleted, even when fully paid or refunded.", "HAS_PAYMENTS");
    }
    const messages: Record<number, string> = {
      401: "Your session has expired. Please sign in again.", 403: "You don\'t have access to this event.",
      404: "This expense is no longer available. Refresh the page to update the list.",
    };
    throw new ExpenseDeleteError(messages[response.status] ?? "We couldn\'t delete the expense. Please try again.");
  },
  create: (eventId: string, input: CreateExpenseInput) => saveExpenseRequest(eventId, input),
  update: (eventId: string, expenseId: string, input: CreateExpenseInput) => saveExpenseRequest(eventId, input, expenseId),
  async list(eventId: string): Promise<Expense[]> {
    let token: string | undefined;
    try { token = (await requireAuthSession()).session.tokens?.accessToken?.toString(); } catch { /* Show a sign-in message below. */ }
    if (!token) throw new Error("Your session has expired. Please sign in again.");
    const expenses: Expense[] = [];
    const ids = new Set<string>();
    let offset = 0;
    while (true) {
      let response: Response;
      try {
        response = await fetch(apiUrl("/events/" + encodeURIComponent(eventId) + "/expenses?limit=100&offset=" + offset), {
          headers: { Authorization: "Bearer " + token },
        });
      } catch { throw new Error("We couldn\'t reach the server. Check your connection and try again."); }
      if (!response.ok) {
        const messages: Record<number, string> = {
          401: "Your session has expired. Please sign in again.",
          403: "You don\'t have access to this event.",
          404: "Expenses are unavailable for this event.",
        };
        throw new Error(messages[response.status] ?? "We couldn\'t load expenses. Please try again.");
      }
      const page: ExpensePage = await response.json().catch(() => { throw invalidResponse(); });
      if (!page || !Array.isArray(page.data) || !Number.isSafeInteger(page.total) || page.total < 0 ||
          page.offset !== offset || !Number.isInteger(page.limit) || page.limit < 1 || page.limit > 100 ||
          page.data.length > page.limit) throw invalidResponse();
      for (const row of page.data) {
        const expense = mapExpense(row, eventId);
        if (ids.has(expense.id)) throw invalidResponse();
        ids.add(expense.id);
        expenses.push(expense);
      }
      offset += page.data.length;
      if (offset >= page.total) return expenses;
      if (page.data.length === 0) throw invalidResponse();
    }
  },
};
