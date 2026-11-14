import { invalid } from "../errors";
import type { PaymentInput, PaymentQuery } from "../types";
import { cents, parseExpenseQuery, validDate } from "./validation";

export function parsePaymentBody(value: unknown, today: string): PaymentInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("body", "Use a JSON object.");
  const body = value as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!["amount", "paidAt", "paymentType", "notes"].includes(key)) invalid(key, "Unknown writable field.");
  }
  if (typeof body.amount !== "string" || !/^(0|[1-9][0-9]{0,9})\.[0-9]{2}$/.test(body.amount) || cents(body.amount) <= 0n) {
    invalid("amount", "Use a positive decimal string with two decimal places (maximum 9999999999.99).");
  }
  if (!validDate(body.paidAt) || body.paidAt > today) {
    invalid("paidAt", "Use a real YYYY-MM-DD date no later than today (UTC).");
  }
  const paymentType = body.paymentType === undefined ? "PAYMENT" : body.paymentType;
  if (paymentType !== "DEPOSIT" && paymentType !== "PAYMENT") {
    invalid("paymentType", "Use DEPOSIT or PAYMENT. Refund entry is outside this MVP.");
  }
  const notes = body.notes === undefined ? null : body.notes;
  if (notes !== null && (typeof notes !== "string" || notes.length > 255)) {
    invalid("notes", "Use up to 255 characters or null.");
  }
  return { amount: body.amount, paidAt: body.paidAt, paymentType, notes: notes === null ? null : notes.trim() };
}

export function parsePaymentQuery(params: URLSearchParams): PaymentQuery {
  for (const key of params.keys()) if (key !== "limit" && key !== "offset") invalid(key, "Payment history accepts only limit and offset.");
  const { limit, offset } = parseExpenseQuery(params);
  return { limit, offset };
}
