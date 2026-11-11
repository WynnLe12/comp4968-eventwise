import { ApiError, invalid } from "../errors";
import type { ExpenseInput, ExpenseQuery, PaymentStatus } from "../types";

export function parseId(value: unknown, field: string, path = false): string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/.test(value) || BigInt(value) > 18446744073709551615n) {
    if (path) throw new ApiError(400, "BAD_REQUEST", `Invalid ${field}.`);
    invalid(field, "Use a positive decimal ID string.");
  }
  return value;
}
export function cents(value: string): bigint {
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  if (!whole || !/^[0-9]+$/.test(whole) || !/^[0-9]{0,2}$/.test(fraction)) {
    throw new ApiError(500, "INTERNAL_ERROR", "Invalid stored financial value.");
  }
  return (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"))) * (negative ? -1n : 1n);
}
export function money(value: bigint): string {
  const sign = value < 0 ? "-" : "";
  const absolute = value < 0 ? -value : value;
  return `${sign}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}`;
}
export function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}
const fields = ["categoryId", "vendorId", "description", "committedAmount", "dueDate"];
export function parseExpenseBody(value: unknown, patch: boolean): Partial<ExpenseInput> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("body", "Use a JSON object.");
  const body = value as Record<string, unknown>;
  for (const field of Object.keys(body)) if (!fields.includes(field)) invalid(field, "Unknown writable field.");
  if (patch && Object.keys(body).length === 0) invalid("body", "Provide at least one editable field.");
  if (!patch) for (const key of ["categoryId", "description", "committedAmount"]) {
    if (!(key in body)) invalid(key, "This field is required.");
  }
  const result: Partial<ExpenseInput> = {};
  if ("categoryId" in body) result.categoryId = parseId(body.categoryId, "categoryId");
  if ("vendorId" in body) result.vendorId = body.vendorId === null ? null : parseId(body.vendorId, "vendorId");
  else if (!patch) result.vendorId = null;
  if ("description" in body) {
    if (typeof body.description !== "string" || body.description.trim().length < 1 || body.description.trim().length > 255) {
      invalid("description", "Use 1-255 characters.");
    }
    result.description = body.description.trim();
  }
  if ("committedAmount" in body) {
    if (typeof body.committedAmount !== "string" || !/^(0|[1-9][0-9]{0,9})\.[0-9]{2}$/.test(body.committedAmount)) {
      invalid("committedAmount", "Use a nonnegative decimal string with two decimal places (maximum 9999999999.99).");
    }
    result.committedAmount = body.committedAmount;
  }
  if ("dueDate" in body) {
    if (body.dueDate !== null && !validDate(body.dueDate)) invalid("dueDate", "Use a real YYYY-MM-DD date (1000-9999) or null.");
    result.dueDate = body.dueDate;
  } else if (!patch) result.dueDate = null;
  return result;
}
export function parseExpenseQuery(params: URLSearchParams): ExpenseQuery {
  const allowed = ["limit", "offset", "categoryId", "vendorId", "paymentStatus", "overdue", "q"];
  for (const key of params.keys()) {
    if (!allowed.includes(key) || params.getAll(key).length !== 1) invalid(key, "Unknown or repeated query parameter.");
  }
  function integer(key: string, fallback: number, min: number, max: number): number {
    const raw = params.get(key);
    if (raw === null) return fallback;
    if (!/^[0-9]+$/.test(raw)) invalid(key, "Use an integer.");
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) invalid(key, `Use a value between ${min} and ${max}.`);
    return value;
  }
  const query: ExpenseQuery = { limit: integer("limit", 50, 1, 100), offset: integer("offset", 0, 0, Number.MAX_SAFE_INTEGER) };
  for (const key of ["categoryId", "vendorId"] as const) {
    const raw = params.get(key);
    if (raw !== null) query[key] = parseId(raw, key);
  }
  const status = params.get("paymentStatus");
  if (status !== null) {
    if (!["UNPAID", "PARTIALLY_PAID", "PAID"].includes(status)) invalid("paymentStatus", "Unknown payment status.");
    query.paymentStatus = status as PaymentStatus;
  }
  const overdue = params.get("overdue");
  if (overdue !== null) {
    if (overdue !== "true" && overdue !== "false") invalid("overdue", "Use true or false.");
    query.overdue = overdue === "true";
  }
  const q = params.get("q");
  if (q !== null) {
    if (q.trim().length > 100) invalid("q", "Maximum 100 characters.");
    query.q = q.trim();
  }
  return query;
}
