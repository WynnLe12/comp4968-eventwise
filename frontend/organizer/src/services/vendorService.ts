/**
 * Vendor service backed by in-memory mock data.
 *
 * It has the same shape as the future Event API client (list/get/create/update/remove)
 * and behaves like it: validation failures reject with a 422-style error, blocked
 * deletions reject with a typed 409-style conflict, and a failed request never
 * changes stored data. Swap the bodies for `apiRequest` calls when the API is ready.
 */
import { CURRENT_EVENT_ID, vendorsSeed } from "../data/mockData";
import type { Vendor, VendorCreateInput, VendorStoredFields, VendorUpdateInput } from "../types";
import { mockRequest, mockScenario } from "./mockClient";
import {
  amountValueError,
  applyAutomaticTransitions,
  deleteConflictFor,
  emailError,
  FIELD_LIMITS,
  nameError,
  statusViolation,
  type VendorDeleteConflict,
  type VendorField,
} from "./vendorRules";

export type { VendorDeleteConflict } from "./vendorRules";

export class VendorServiceError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "VendorServiceError";
  }
}

/** 422: the record breaks a validation or status rule. */
export class VendorValidationError extends VendorServiceError {
  constructor(
    message: string,
    public readonly field?: VendorField,
  ) {
    super(message, 422);
    this.name = "VendorValidationError";
  }
}

/** 409: the vendor can't be deleted. */
export class VendorDeleteConflictError extends VendorServiceError {
  constructor(
    message: string,
    public readonly conflict: VendorDeleteConflict,
  ) {
    super(message, 409);
    this.name = "VendorDeleteConflictError";
  }
}

let vendors: Vendor[] = structuredClone(vendorsSeed);
const accessibleEvents = new Set([CURRENT_EVENT_ID]);

const STORED_FIELDS = [
  "eventId",
  "name",
  "category",
  "contactName",
  "email",
  "phone",
  "quoteAmount",
  "contractTotal",
  "bookingStatus",
  "contractStatus",
] as const satisfies readonly VendorField[];

const EMPTY_VENDOR: VendorStoredFields = {
  eventId: "",
  name: "",
  category: "",
  contactName: "",
  email: "",
  phone: "",
  quoteAmount: null,
  contractTotal: null,
  bookingStatus: "researching",
  contractStatus: "none",
};

/** Keeps only stored fields; computed fields (paidTotal, balance, ...) are ignored. */
function pickStoredFields(input: object): Partial<VendorStoredFields> {
  const source = input as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const field of STORED_FIELDS) {
    if (source[field] !== undefined) picked[field] = source[field];
  }
  return picked as Partial<VendorStoredFields>;
}

function assertEventAccess(eventId: string) {
  if (mockScenario() === "forbidden" || !accessibleEvents.has(eventId)) {
    throw new VendorServiceError("You don't have access to this event.", 403);
  }
}

/** Merges changes onto a record, applies automatic transitions, and validates the result. */
function buildRecord(changes: Partial<VendorStoredFields>, existing: VendorStoredFields) {
  const merged: VendorStoredFields = { ...existing, ...changes };
  for (const field of ["name", "category", "contactName", "email", "phone"] as const) {
    merged[field] = String(merged[field] ?? "").trim();
  }

  const fieldErrors: [VendorField, string][] = [
    ["name", nameError(merged.name)],
    ["email", emailError(merged.email)],
    ["quoteAmount", amountValueError(merged.quoteAmount, "Quote amount")],
    ["contractTotal", amountValueError(merged.contractTotal, "Contract total")],
  ];
  for (const field of ["category", "contactName", "email", "phone"] as const) {
    if (merged[field].length > FIELD_LIMITS[field]) {
      fieldErrors.push([field, `Keep this under ${FIELD_LIMITS[field]} characters.`]);
    }
  }
  const firstError = fieldErrors.find(([, message]) => message);
  if (firstError) throw new VendorValidationError(firstError[1], firstError[0]);

  const record = applyAutomaticTransitions(merged, changes);
  const violation = statusViolation(record);
  if (violation) throw new VendorValidationError(violation.message, violation.field);
  return record;
}

/** Stand-in for the server's expense roll-up. The UI never computes these. */
function withComputedFields(record: VendorStoredFields, id: string, existing?: Vendor): Vendor {
  const paidTotal = existing?.paidTotal ?? 0;
  const balance =
    record.contractTotal === null ? null : Math.max(record.contractTotal - paidTotal, 0);
  return {
    ...record,
    id,
    paidTotal,
    balance,
    nextDueDate: balance !== null && balance > 0 ? (existing?.nextDueDate ?? null) : null,
  };
}

function findVendor(id: string) {
  const vendor = vendors.find((item) => item.id === id);
  if (!vendor) throw new VendorServiceError("This vendor no longer exists.", 404);
  return vendor;
}

function newVendorId() {
  return `vendor-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export const vendorService = {
  list: (eventId: string) =>
    mockRequest(() => {
      assertEventAccess(eventId);
      if (mockScenario() === "error") {
        throw new VendorServiceError("We couldn't load your vendors. Please try again.", 500);
      }
      if (mockScenario() === "empty") return [];
      return vendors.filter((vendor) => vendor.eventId === eventId);
    }),

  get: (id: string) =>
    mockRequest(() => {
      const vendor = findVendor(id);
      assertEventAccess(vendor.eventId);
      return vendor;
    }),

  create: (input: VendorCreateInput) =>
    mockRequest(() => {
      const changes = pickStoredFields(input);
      assertEventAccess(changes.eventId ?? "");
      if (mockScenario() === "save-error") {
        throw new VendorServiceError("Something went wrong while saving. Please try again.", 500);
      }
      const record = buildRecord(changes, EMPTY_VENDOR);
      const vendor = withComputedFields(record, newVendorId());
      vendors = [...vendors, vendor];
      return vendor;
    }),

  update: (id: string, input: VendorUpdateInput) =>
    mockRequest(() => {
      const existing = findVendor(id);
      assertEventAccess(existing.eventId);
      if (mockScenario() === "save-error") {
        throw new VendorServiceError("Something went wrong while saving. Please try again.", 500);
      }
      // A vendor can't be moved to another event through an update.
      const { eventId: _ignored, ...changes } = pickStoredFields(input);
      const record = buildRecord(changes, existing);
      const vendor = withComputedFields(record, id, existing);
      vendors = vendors.map((item) => (item.id === id ? vendor : item));
      return vendor;
    }),

  remove: (id: string) =>
    mockRequest(() => {
      const vendor = findVendor(id);
      assertEventAccess(vendor.eventId);
      const conflict = deleteConflictFor(vendor);
      if (conflict === "signed-contract") {
        throw new VendorDeleteConflictError(
          `${vendor.name} is booked with a signed contract and can't be deleted.`,
          conflict,
        );
      }
      if (conflict === "recorded-expenses") {
        throw new VendorDeleteConflictError(
          `${vendor.name} has expenses recorded and can't be deleted.`,
          conflict,
        );
      }
      vendors = vendors.filter((item) => item.id !== id);
      return { id };
    }),
};
