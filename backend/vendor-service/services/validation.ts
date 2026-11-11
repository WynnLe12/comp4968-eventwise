// Field rules for vendors. Pure functions: no database, no AWS.
// Messages match docs/api/vendors.md so the UI can show them as-is.
import {
  BOOKING_STATUSES,
  CONTRACT_STATUSES,
  EDITABLE_FIELDS,
  type FieldErrors,
  type VendorChanges,
  type VendorDraft,
} from "../types";

/** Maximum lengths, matching the column sizes in eventwise_schema.sql (notes is TEXT - 2000 is our limit). */
export const MAX_LENGTH = {
  name: 150,
  category: 100,
  contactName: 150,
  email: 254,
  phone: 40,
  notes: 2000,
} as const;

const TEXT_FIELDS = Object.keys(MAX_LENGTH) as (keyof typeof MAX_LENGTH)[];
const MONEY_FIELDS = ["quoteAmount", "contractTotal"] as const;

/** 0 to 9999999999.99 (DECIMAL(12,2)), at most 2 decimals, no minus sign. */
const MONEY = /^\d{1,10}(\.\d{1,2})?$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MONEY_MESSAGE = "Enter an amount of 0 or more, with up to 2 decimals";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Keep only the editable fields from a request body.
 * - Strings are trimmed, and an empty string becomes null.
 * - A finite number for a money field becomes a string ("500").
 * - Anything else in the body (id, eventId, paidTotal, balance, unknown keys) is ignored.
 * - A body that isn't an object gives no changes.
 */
export function cleanInput(body: unknown): VendorChanges {
  const changes: VendorChanges = {};
  if (!isPlainObject(body)) return changes;

  for (const key of EDITABLE_FIELDS) {
    if (!Object.hasOwn(body, key)) continue;
    let value = body[key];
    if (typeof value === "string") {
      value = value.trim();
      if (value === "") value = null;
    } else if (
      typeof value === "number" &&
      Number.isFinite(value) &&
      (MONEY_FIELDS as readonly string[]).includes(key)
    ) {
      value = String(value);
    }
    changes[key] = value;
  }
  return changes;
}

/** Check every field of the vendor as it will be saved. Returns an empty object when all are valid. */
export function validateFields(v: VendorDraft): FieldErrors {
  const fields: FieldErrors = {};

  if (v.name == null) fields.name = "Business name is required";

  for (const key of TEXT_FIELDS) {
    const value = v[key];
    if (value == null || fields[key]) continue;
    if (typeof value !== "string") fields[key] = "Enter text";
    else if (value.length > MAX_LENGTH[key])
      fields[key] = `Keep this under ${MAX_LENGTH[key]} characters`;
  }

  if (typeof v.email === "string" && !fields.email && !EMAIL.test(v.email)) {
    fields.email = "Enter a valid email address";
  }

  for (const key of MONEY_FIELDS) {
    const value = v[key];
    if (value != null && (typeof value !== "string" || !MONEY.test(value)))
      fields[key] = MONEY_MESSAGE;
  }

  if (!(BOOKING_STATUSES as readonly unknown[]).includes(v.bookingStatus)) {
    fields.bookingStatus = "Choose a valid booking status";
  }
  if (!(CONTRACT_STATUSES as readonly unknown[]).includes(v.contractStatus)) {
    fields.contractStatus = "Choose a valid contract status";
  }

  return fields;
}
