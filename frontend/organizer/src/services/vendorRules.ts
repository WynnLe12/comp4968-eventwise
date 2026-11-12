/**
 * Vendor business rules shared by the vendor service (mock API) and the UI.
 *
 * The service is the authority: it applies the automatic status changes and
 * rejects invalid records. The UI uses the same helpers to disable options and
 * explain why, so what the user can pick always matches what the service accepts.
 * The status rules mirror the CHECK constraints on the `vendors` table.
 */
import type { BookingStatus, ContractStatus, Vendor, VendorStoredFields } from "../types";

export const BOOKING_STATUSES: BookingStatus[] = ["researching", "quoted", "booked", "declined"];
export const CONTRACT_STATUSES: ContractStatus[] = ["none", "sent", "signed", "cancelled"];

export const bookingLabels: Record<BookingStatus, string> = {
  researching: "Researching",
  quoted: "Quoted",
  booked: "Booked",
  declined: "Declined",
};

export const contractLabels: Record<ContractStatus, string> = {
  none: "No contract",
  sent: "Contract sent",
  signed: "Contract signed",
  cancelled: "Contract cancelled",
};

export const FIELD_LIMITS = {
  name: 150,
  category: 100,
  contactName: 150,
  email: 254,
  phone: 40,
} as const;

/** Largest value a DECIMAL(12,2) column can hold. */
const MAX_AMOUNT = 9_999_999_999.99;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type VendorField = keyof VendorStoredFields;

interface StatusState {
  bookingStatus: BookingStatus;
  contractStatus: ContractStatus;
}

/** A sent or signed contract is "active"; it must be cancelled before stepping back. */
export function hasActiveContract(status: ContractStatus) {
  return status === "sent" || status === "signed";
}

function canHoldContract(status: BookingStatus) {
  return status === "quoted" || status === "booked";
}

// ---------------------------------------------------------------------------
// Field validation (used on blur, on submit and again in the service)
// ---------------------------------------------------------------------------

export function nameError(value: string) {
  if (!value.trim()) return "Business name is required.";
  if (value.trim().length > FIELD_LIMITS.name)
    return `Business name must be ${FIELD_LIMITS.name} characters or fewer.`;
  return "";
}

export function emailError(value: string) {
  const email = value.trim();
  if (email && !EMAIL_PATTERN.test(email)) return "Enter a valid email address.";
  return "";
}

/** Validates a numeric amount (or null for "not set"). */
export function amountValueError(value: number | null, label: string) {
  if (value === null) return "";
  if (!Number.isFinite(value)) return `Enter a valid ${label.toLowerCase()}.`;
  if (value < 0) return `${label} can't be negative.`;
  if (Math.abs(value * 100 - Math.round(value * 100)) > 1e-7)
    return `${label} can have at most two decimal places.`;
  if (value > MAX_AMOUNT) return `${label} is too large.`;
  return "";
}

/** Parses an amount typed into a form. Empty text means "not set" (null). */
export function parseAmount(text: string, label: string): { value: number | null; error: string } {
  const cleaned = text.trim().replace(/[$,]/g, "");
  if (!cleaned) return { value: null, error: "" };
  if (!/^-?\d*\.?\d+$|^-?\d+\.$/.test(cleaned)) {
    return { value: null, error: `Enter a valid ${label.toLowerCase()}.` };
  }
  const value = Number(cleaned);
  if (value < 0) return { value, error: `${label} can't be negative.` };
  const decimals = cleaned.split(".")[1] ?? "";
  if (decimals.length > 2) return { value, error: `${label} can have at most two decimal places.` };
  return { value, error: amountValueError(value, label) };
}

// ---------------------------------------------------------------------------
// Status rules
// ---------------------------------------------------------------------------

/** Why a booking status can't be chosen from the current state ("" when it can). */
export function bookingOptionDisabledReason(target: BookingStatus, state: StatusState) {
  if (target === state.bookingStatus) return "";
  if ((target === "researching" || target === "declined") && hasActiveContract(state.contractStatus)) {
    return "Cancel the contract first";
  }
  if (target === "quoted" && state.contractStatus === "signed") {
    return "A signed contract keeps this vendor booked. Cancel the contract first";
  }
  return "";
}

/** Why a contract status can't be chosen from the current state ("" when it can). */
export function contractOptionDisabledReason(target: ContractStatus, state: StatusState) {
  if (target === state.contractStatus || target === "none") return "";
  if (canHoldContract(state.bookingStatus)) return "";
  return state.bookingStatus === "researching"
    ? "Add a quote first. Researching vendors can't have a contract"
    : "Declined vendors can't take on a contract";
}

/**
 * Moving back to Researching clears the quote and any cancelled contract, so it
 * needs confirmation when either exists. (Sent/signed contracts block it entirely.)
 */
export function researchingNeedsConfirmation(hasQuote: boolean, contractStatus: ContractStatus) {
  return hasQuote || contractStatus === "cancelled";
}

/** Fields that reset a vendor to a clean Researching state. */
export const RESET_TO_RESEARCHING = {
  bookingStatus: "researching",
  quoteAmount: null,
  contractStatus: "none",
  contractTotal: null,
} as const satisfies Partial<VendorStoredFields>;

/**
 * Applies the automatic transitions for the fields the caller is changing:
 * entering a quote on a researching vendor makes it Quoted, and signing a
 * contract makes it Booked.
 */
export function applyAutomaticTransitions(
  record: VendorStoredFields,
  changes: Partial<VendorStoredFields>,
): VendorStoredFields {
  const next = { ...record };
  if (changes.quoteAmount != null && next.bookingStatus === "researching") {
    next.bookingStatus = "quoted";
  }
  if (changes.contractStatus === "signed") {
    next.bookingStatus = "booked";
  }
  return next;
}

/** The first status rule the record breaks, or null when it is valid. */
export function statusViolation(
  record: VendorStoredFields,
): { field: VendorField; message: string } | null {
  if (record.contractTotal !== null && record.contractStatus === "none") {
    return { field: "contractTotal", message: "Add a contract before entering a contract total." };
  }
  if (record.bookingStatus === "researching" && record.quoteAmount !== null) {
    return {
      field: "quoteAmount",
      message: "A quote amount is only allowed for quoted, booked, or declined vendors.",
    };
  }
  if (record.bookingStatus === "researching" && record.contractStatus !== "none") {
    return { field: "contractStatus", message: "Researching vendors can't have a contract." };
  }
  if (hasActiveContract(record.contractStatus) && !canHoldContract(record.bookingStatus)) {
    return {
      field: "contractStatus",
      message: "A sent or signed contract needs a quoted or booked vendor.",
    };
  }
  if (record.contractStatus === "signed" && record.bookingStatus !== "booked") {
    return { field: "bookingStatus", message: "A vendor with a signed contract must be booked." };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

export type VendorDeleteConflict = "signed-contract" | "recorded-expenses";

/** Why a vendor can't be deleted, or null. The signed-contract conflict wins when both apply. */
export function deleteConflictFor(vendor: Vendor): VendorDeleteConflict | null {
  if (vendor.bookingStatus === "booked" && vendor.contractStatus === "signed") {
    return "signed-contract";
  }
  if (vendor.paidTotal > 0 || vendor.nextDueDate !== null) return "recorded-expenses";
  return null;
}
