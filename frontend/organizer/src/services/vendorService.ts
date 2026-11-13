/**
 * Vendor service backed by in-memory mock data.
 *
 * Each function matches one route in docs/api/vendors.md and behaves like it:
 * same JSON shape (uppercase statuses, money strings, null for empty text), same
 * automatic status changes, 422 with per-field messages, 409 SIGNED_CONTRACT /
 * HAS_EXPENSES on delete, 403 for events you aren't a member of, 404 for unknown
 * vendors. A failed request never changes stored data.
 *
 * To wire the real API, replace each body with the request in its comment and turn
 * the `{ error: { code, message, fields } }` body into the matching error class below.
 */
import {
  CURRENT_EVENT_ID,
  type MockVendorRecord,
  vendorsSeed,
} from "../data/mockData";
import type {
  Money,
  Vendor,
  VendorCreateInput,
  VendorFieldErrors,
  VendorFields,
  VendorUpdateInput,
} from "../types";
import { mockRequest, mockScenario } from "./mockClient";
import { mockExpenseStore } from "./mockExpenseStore";
import { applyStatusRules, MONEY_FIELDS, validateFields, type VendorDeleteConflict } from "./vendorRules";

export type { VendorDeleteConflict } from "./vendorRules";

/** Any non-2xx response. `code` is the API's `error.code` (absent for API Gateway's 401). */
export class VendorServiceError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "VendorServiceError";
  }
}

/** 422 VALIDATION_ERROR: `fields` maps each invalid field to the message shown under it. */
export class VendorValidationError extends VendorServiceError {
  constructor(
    message: string,
    public readonly fields: VendorFieldErrors,
  ) {
    super(message, 422, "VALIDATION_ERROR");
    this.name = "VendorValidationError";
  }
}

/** 409 SIGNED_CONTRACT or HAS_EXPENSES from DELETE. */
export class VendorDeleteConflictError extends VendorServiceError {
  constructor(
    message: string,
    public readonly conflict: VendorDeleteConflict,
  ) {
    super(message, 409, conflict);
    this.name = "VendorDeleteConflictError";
  }
}

// ---------------------------------------------------------------------------
// Mock store
// ---------------------------------------------------------------------------

let records: MockVendorRecord[] = vendorsSeed.map((seed) => structuredClone(seed.record));
const memberOf = new Set([CURRENT_EVENT_ID]);
let lastVendorId = Math.max(...records.map((record) => Number(record.id)));

const EDITABLE_FIELDS = [
  "name",
  "category",
  "contactName",
  "email",
  "phone",
  "quoteAmount",
  "contractTotal",
  "bookingStatus",
  "contractStatus",
  "notes",
] as const satisfies readonly (keyof VendorFields)[];

const NEW_VENDOR: VendorFields = {
  name: "",
  category: null,
  contactName: null,
  email: null,
  phone: null,
  quoteAmount: null,
  contractTotal: null,
  bookingStatus: "RESEARCHING",
  contractStatus: "NOT_STARTED",
  notes: null,
};


/**
 * Like the server's cleanInput: keeps only editable fields, trims strings, turns empty
 * strings into null and money numbers into strings. Everything else is ignored.
 */
function cleanInput(body: object): Partial<VendorFields> {
  const source = body as Record<string, unknown>;
  const changes: Record<string, unknown> = {};
  for (const key of EDITABLE_FIELDS) {
    if (!Object.hasOwn(source, key)) continue;
    let value = source[key];
    if (typeof value === "string") {
      value = value.trim() || null;
    } else if (
      typeof value === "number" &&
      Number.isFinite(value) &&
      (MONEY_FIELDS as readonly string[]).includes(key)
    ) {
      value = String(value);
    }
    changes[key] = value;
  }
  return changes as Partial<VendorFields>;
}

/** Stores money with exactly 2 decimals, the way MySQL DECIMAL(12,2) returns it. */
function storedMoney(value: Money | null): Money | null {
  return value === null ? null : Number(value).toFixed(2);
}

function cents(value: Money) {
  return Math.round(Number(value) * 100);
}

/** Validates and returns the fields to save, or throws 422 with every problem by field. */
function prepare(current: VendorFields, body: object): VendorFields {
  const { next, fields: ruleErrors } = applyStatusRules(current, cleanInput(body));
  const fields: VendorFieldErrors = { ...ruleErrors, ...validateFields(next) };
  if (Object.keys(fields).length > 0) {
    throw new VendorValidationError("Check the submitted fields.", fields);
  }
  return {
    ...next,
    quoteAmount: storedMoney(next.quoteAmount),
    contractTotal: storedMoney(next.contractTotal),
  };
}

/** Stand-in for the server's vendor query, which reads the totals from vendor_payment_totals. */
function toVendor(record: MockVendorRecord): Vendor {
  const expenses = mockExpenseStore.vendorTotals(record.eventId, record.id);
  const balance =
    record.contractTotal === null
      ? null
      : ((cents(record.contractTotal) - cents(expenses.paidTotal)) / 100).toFixed(2);
  return {
    ...record,
    paidTotal: expenses.paidTotal,
    balance,
    nextDueDate: expenses.nextDueDate,
  };
}

function editableFields(record: MockVendorRecord): VendorFields {
  const fields = {} as Record<string, unknown>;
  for (const key of EDITABLE_FIELDS) fields[key] = record[key];
  return fields as unknown as VendorFields;
}

function requireMember(eventId: string) {
  if (mockScenario() === "forbidden" || !memberOf.has(eventId)) {
    throw new VendorServiceError("You don't have access to this event.", 403, "FORBIDDEN");
  }
}

/** A vendor from another event is a 404, so the API never reveals that it exists. */
function findRecord(eventId: string, vendorId: string) {
  const record = records.find((item) => item.id === vendorId && item.eventId === eventId);
  if (!record) throw new VendorServiceError("This vendor no longer exists.", 404, "NOT_FOUND");
  return record;
}

function failIfSaveErrorScenario() {
  if (mockScenario() === "save-error") {
    throw new VendorServiceError("Something went wrong. Please try again.", 500, "INTERNAL_ERROR");
  }
}

function now() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const vendorService = {
  /** GET /events/{eventId}/vendors -> 200, sorted by name. */
  list: (eventId: string) =>
    mockRequest(() => {
      requireMember(eventId);
      if (mockScenario() === "error") {
        throw new VendorServiceError("We couldn't load your vendors. Please try again.", 500, "INTERNAL_ERROR");
      }
      if (mockScenario() === "empty") return [];
      return records
        .filter((record) => record.eventId === eventId)
        .map(toVendor)
        .sort((a, b) => a.name.localeCompare(b.name));
    }),

  /** GET /events/{eventId}/vendors/{vendorId} -> 200. */
  get: (eventId: string, vendorId: string) =>
    mockRequest(() => {
      requireMember(eventId);
      return toVendor(findRecord(eventId, vendorId));
    }),

  /** POST /events/{eventId}/vendors -> 201. The event comes from the URL, never the body. */
  create: (eventId: string, input: VendorCreateInput) =>
    mockRequest(() => {
      requireMember(eventId);
      failIfSaveErrorScenario();
      const fields = prepare(NEW_VENDOR, input);
      const timestamp = now();
      lastVendorId += 1;
      const record: MockVendorRecord = {
        ...fields,
        id: String(lastVendorId),
        eventId,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      records = [...records, record];
      return toVendor(record);
    }),

  /** PATCH /events/{eventId}/vendors/{vendorId} with only the changed fields -> 200. */
  update: (eventId: string, vendorId: string, input: VendorUpdateInput) =>
    mockRequest(() => {
      requireMember(eventId);
      const existing = findRecord(eventId, vendorId);
      failIfSaveErrorScenario();
      const fields = prepare(editableFields(existing), input);
      const record: MockVendorRecord = { ...existing, ...fields, updatedAt: now() };
      records = records.map((item) => (item.id === vendorId ? record : item));
      return toVendor(record);
    }),

  /** DELETE /events/{eventId}/vendors/{vendorId} -> 204. The first conflict that applies wins. */
  remove: (eventId: string, vendorId: string) =>
    mockRequest(() => {
      requireMember(eventId);
      const record = findRecord(eventId, vendorId);
      if (record.bookingStatus === "BOOKED" && record.contractStatus === "SIGNED") {
        throw new VendorDeleteConflictError(
          "This vendor is booked with a signed contract. Mark it as cancelled instead.",
          "SIGNED_CONTRACT",
        );
      }
      if (mockExpenseStore.vendorTotals(eventId, vendorId).expenseCount > 0) {
        throw new VendorDeleteConflictError(
          "This vendor has expenses. Remove or move them to another vendor first.",
          "HAS_EXPENSES",
        );
      }
      records = records.filter((item) => item.id !== vendorId);
    }),
};
