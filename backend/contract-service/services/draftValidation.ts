import { ApiError, invalid } from "../../expense-service/errors";
import { parseExpenseBody, parseId, validDate } from "../../expense-service/services/validation";
import type { ExpenseInput } from "../../expense-service/types";
import { DRAFT_STATUSES, SAVE_ACTIONS, type DraftPatch, type DraftQuery } from "../types";

const editable = [
  "description", "categoryId", "vendorId", "vendorName", "totalAmount",
  "depositAmount", "dueDate", "currencyCode", "saveAction", "targetExpenseId",
];

function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid("body", "Use a JSON object.");
  }
  const body = value as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) invalid(key, "Unknown writable field.");
  }
  return body;
}

export function parseCreateDraft(value: unknown): { documentId: string } {
  const body = object(value, ["documentId"]);
  return { documentId: parseId(body.documentId, "documentId") };
}

export function parseDraftVersion(value: unknown): { version: string } {
  const body = object(value, ["version"]);
  return { version: parseId(body.version, "version") };
}

export function parseDraftConfirmation(value: unknown): { version: string; expectedExpense?: ExpenseInput } {
  const body = object(value, ["version", "expectedExpense"]);
  const result: { version: string; expectedExpense?: ExpenseInput } = { version: parseId(body.version, "version") };
  if (Object.hasOwn(body, "expectedExpense")) {
    const snapshot = body.expectedExpense;
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) ||
        ["categoryId", "vendorId", "description", "committedAmount", "dueDate"].some(key => !Object.hasOwn(snapshot, key))) {
      invalid("expectedExpense", "Reload and review the selected expense before confirming.");
    }
    try {
      result.expectedExpense = parseExpenseBody(snapshot, false) as ExpenseInput;
      // Keep the exact displayed description when comparing a legacy stored value.
      result.expectedExpense.description = (snapshot as ExpenseInput).description;
    } catch (error) {
      if (error instanceof ApiError) invalid("expectedExpense", "Reload and review the selected expense before confirming.");
      throw error;
    }
  }
  return result;
}

function text(value: unknown, field: string, max: number): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.trim().length > max) {
    invalid(field, `Use at most ${max} characters, or null.`);
  }
  return value.trim() || null;
}

export function parseDraftPatch(value: unknown): DraftPatch {
  const body = object(value, ["version", ...editable]);
  const version = parseId(body.version, "version");
  if (!editable.some(key => Object.hasOwn(body, key))) {
    invalid("body", "Provide at least one editable field.");
  }
  const changes: DraftPatch["changes"] = {};
  for (const field of ["description", "vendorName"] as const) {
    if (Object.hasOwn(body, field)) changes[field] = text(body[field], field, field === "description" ? 255 : 150);
  }
  for (const field of ["categoryId", "vendorId", "targetExpenseId"] as const) {
    if (Object.hasOwn(body, field)) changes[field] = body[field] === null ? null : parseId(body[field], field);
  }
  for (const field of ["totalAmount", "depositAmount"] as const) {
    if (!Object.hasOwn(body, field)) continue;
    const amount = body[field];
    if (amount !== null && (typeof amount !== "string" || !/^(0|[1-9][0-9]{0,9})\.[0-9]{2}$/.test(amount))) {
      invalid(field, "Enter an amount of 0 or more, with 2 decimal places, or null.");
    }
    changes[field] = amount;
  }
  if (Object.hasOwn(body, "dueDate")) {
    if (body.dueDate !== null && !validDate(body.dueDate)) {
      invalid("dueDate", "Use a real YYYY-MM-DD date, or null.");
    }
    changes.dueDate = body.dueDate;
  }
  if (Object.hasOwn(body, "currencyCode")) {
    if (body.currencyCode !== null && (typeof body.currencyCode !== "string" || !/^[A-Z]{3}$/.test(body.currencyCode))) {
      invalid("currencyCode", "Use a three-letter uppercase currency code, or null.");
    }
    changes.currencyCode = body.currencyCode;
  }
  if (Object.hasOwn(body, "saveAction")) {
    if (!SAVE_ACTIONS.includes(body.saveAction as typeof SAVE_ACTIONS[number])) {
      invalid("saveAction", "Choose whether to create or update an expense.");
    }
    changes.saveAction = body.saveAction as typeof SAVE_ACTIONS[number];
  }
  return { version, changes };
}

export function parseDraftQuery(params: URLSearchParams): DraftQuery {
  for (const key of params.keys()) {
    if (!["limit", "offset", "status"].includes(key) || params.getAll(key).length !== 1) {
      invalid(key, "Unknown or repeated query parameter.");
    }
  }
  function integer(key: string, fallback: number, min: number, max: number): number {
    const raw = params.get(key);
    if (raw === null) return fallback;
    const number = Number(raw);
    if (!/^(0|[1-9][0-9]*)$/.test(raw) || !Number.isSafeInteger(number) || number < min || number > max) {
      invalid(key, `Use an integer between ${min} and ${max}.`);
    }
    return number;
  }
  const query: DraftQuery = { limit: integer("limit", 20, 1, 100), offset: integer("offset", 0, 0, 1000000) };
  const status = params.get("status");
  if (status !== null) {
    if (!DRAFT_STATUSES.includes(status as typeof DRAFT_STATUSES[number])) invalid("status", "Unknown draft status.");
    query.status = status as typeof DRAFT_STATUSES[number];
  }
  return query;
}
