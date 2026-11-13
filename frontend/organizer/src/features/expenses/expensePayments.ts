import type { Expense, ExpensePayment } from "../../types";

export interface PaymentDraft {
  amount: string;
  paidAt: string;
  paymentType: ExpensePayment["paymentType"];
}
export type PaymentErrors = Partial<Record<keyof PaymentDraft, string>>;

export function validateExpensePayment(
  expense: Expense,
  draft: PaymentDraft,
  today = new Date().toISOString().slice(0, 10),
): PaymentErrors {
  const errors: PaymentErrors = {};
  const amount = draft.amount.trim();
  const amountCents = Math.round(Number(amount) * 100);
  const balanceCents = Math.round(expense.total * 100) - Math.round(expense.paid * 100);
  if (!/^(0|[1-9][0-9]{0,9})(\.[0-9]{1,2})?$/.test(amount) || amountCents <= 0) {
    errors.amount = "Enter an amount greater than 0, with up to 2 decimals.";
  } else if (amountCents > balanceCents) {
    errors.amount = "Payment can't exceed the remaining balance.";
  }
  const parsed = new Date(draft.paidAt + "T00:00:00Z");
  if (
    !/^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}$/.test(draft.paidAt) ||
    Number.isNaN(parsed.valueOf()) ||
    parsed.toISOString().slice(0, 10) !== draft.paidAt ||
    draft.paidAt > today
  ) {
    errors.paidAt = "Enter a valid payment date no later than today.";
  }
  if (draft.paymentType !== "PAYMENT" && draft.paymentType !== "DEPOSIT") {
    errors.paymentType = "Choose Payment or Deposit.";
  }
  return errors;
}

export function recordExpensePayment(expense: Expense, draft: PaymentDraft, today?: string): Expense {
  const errors = validateExpensePayment(expense, draft, today);
  if (Object.values(errors).some(Boolean)) throw new Error(Object.values(errors)[0]);
  const amountCents = Math.round(Number(draft.amount.trim()) * 100);
  const paidCents = Math.round(expense.paid * 100) + amountCents;
  return {
    ...expense,
    paid: paidCents / 100,
    status: paidCents === Math.round(expense.total * 100) ? "Paid" :
      draft.paymentType === "DEPOSIT" ? "Deposit paid" : "Partially paid",
    payments: [
      ...(expense.payments ?? []),
      { id: crypto.randomUUID(), amount: amountCents / 100, paidAt: draft.paidAt, paymentType: draft.paymentType },
    ],
  };
}
