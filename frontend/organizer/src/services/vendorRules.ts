/**
 * Vendor rules shared by the mock vendor service and the UI.
 *
 * These mirror the backend (backend/vendor-service/services/statusRules.ts and
 * validation.ts) and the API contract in docs/api/vendors.md, messages included,
 * so what the form and menus allow matches what the server accepts. The server is
 * the final check. the UI uses these for instant feedback and to disable options.
 */
import type {
  BookingStatus,
  ContractStatus,
  Money,
  Vendor,
  VendorField,
  VendorFieldErrors,
  VendorFields,
} from "../types";

export const BOOKING_STATUSES: readonly BookingStatus[] = [
  "RESEARCHING",
  "QUOTED",
  "BOOKED",
  "DECLINED",
];
export const CONTRACT_STATUSES: readonly ContractStatus[] = [
  "NOT_STARTED",
  "PENDING",
  "SIGNED",
  "CANCELLED",
];

/** UI labels, from the contract's "UI labels for statuses" table. */
export const bookingLabels: Record<BookingStatus, string> = {
  RESEARCHING: "Researching",
  QUOTED: "Quoted",
  BOOKED: "Booked",
  DECLINED: "Declined",
};

export const contractLabels: Record<ContractStatus, string> = {
  NOT_STARTED: "Not started",
  PENDING: "Pending",
  SIGNED: "Signed",
  CANCELLED: "Cancelled",
};

/** Maximum text lengths, matching the column sizes in eventwise_schema.sql. */
export const MAX_LENGTH = {
  name: 150,
  category: 100,
  contactName: 150,
  email: 254,
  phone: 40,
  notes: 2000,
} as const;

export type TextField = keyof typeof MAX_LENGTH;
export const TEXT_FIELDS = Object.keys(MAX_LENGTH) as TextField[];
export const MONEY_FIELDS = ["quoteAmount", "contractTotal"] as const;

/** 0 to 9999999999.99 (DECIMAL(12,2)), at most 2 decimals, no minus sign. */
const MONEY = /^\d{1,10}(\.\d{1,2})?$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const MONEY_MESSAGE =
  "Enter an amount of 0 or more, with up to 2 decimals";

/** A contract that has been sent (pending) or signed. */
export function hasActiveContract(status: ContractStatus) {
  return status === "PENDING" || status === "SIGNED";
}

function canHoldActiveContract(status: BookingStatus) {
  return status === "QUOTED" || status === "BOOKED";
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * Normalizes what a person types ("$1,250.5") to the API's money format ("1250.50").
 * Returns null for an empty value and undefined when it isn't a valid amount.
 */
export function toMoney(text: string): Money | null | undefined {
  const cleaned = text.replace(/[$,\s]/g, "");
  if (!cleaned) return null;
  if (!MONEY.test(cleaned)) return undefined;
  const [whole, decimals = ""] = cleaned.split(".");
  return `${String(Number(whole))}.${decimals.padEnd(2, "0")}`;
}

/** Money string -> number, for display, sorting and progress bars only. */
export function moneyToNumber(value: Money | null) {
  return value === null ? null : Number(value);
}

// ---------------------------------------------------------------------------
// Field validation (on blur and submit in the form, and again in the service)
// ---------------------------------------------------------------------------

export function textError(field: TextField, value: string | null) {
  if (value && value.length > MAX_LENGTH[field]) {
    return `Keep this under ${MAX_LENGTH[field]} characters`;
  }
  return "";
}

export function nameError(value: string | null) {
  if (!value?.trim()) return "Business name is required";
  return textError("name", value.trim());
}

export function emailError(value: string | null) {
  const email = value?.trim() ?? "";
  if (!email) return "";
  return (
    textError("email", email) ||
    (EMAIL.test(email) ? "" : "Enter a valid email address")
  );
}

/** Checks typed text for a money field. */
export function moneyTextError(text: string) {
  return toMoney(text) === undefined ? MONEY_MESSAGE : "";
}

/** Checks every field of a vendor as it will be saved. Empty when all are valid. */
export function validateFields(vendor: VendorFields): VendorFieldErrors {
  const fields: VendorFieldErrors = {};
  const name = nameError(vendor.name);
  if (name) fields.name = name;
  for (const field of TEXT_FIELDS) {
    const message = textError(field, vendor[field]);
    if (message) fields[field] ??= message;
  }
  const email = emailError(vendor.email);
  if (email) fields.email ??= email;
  for (const field of MONEY_FIELDS) {
    const value = vendor[field];
    if (value !== null && !MONEY.test(value)) fields[field] = MONEY_MESSAGE;
  }
  if (!BOOKING_STATUSES.includes(vendor.bookingStatus)) {
    fields.bookingStatus = "Choose a valid booking status";
  }
  if (!CONTRACT_STATUSES.includes(vendor.contractStatus)) {
    fields.contractStatus = "Choose a valid contract status";
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Status rules
// ---------------------------------------------------------------------------

/**
 * Applies the automatic status changes, then reports combinations that aren't
 * allowed (docs/api/vendors.md section 4). `changes` is what the request sends;
 * the result is the vendor as it will be saved.
 *
 * 1. Moving to Researching clears the quote and contract, unless the contract is
 *    still pending or signed.
 * 2. Setting a quote on a Researching vendor moves it to Quoted.
 * 3. Signing a contract moves a Quoted vendor to Booked (not Researching or Declined).
 */
export function applyStatusRules(
  current: VendorFields,
  changes: Partial<VendorFields>,
): { next: VendorFields; fields: VendorFieldErrors } {
  const next: VendorFields = { ...current, ...changes };
  const fields: VendorFieldErrors = {};

  const movingToResearching =
    changes.bookingStatus === "RESEARCHING" &&
    current.bookingStatus !== "RESEARCHING";
  if (movingToResearching) {
    if (hasActiveContract(next.contractStatus)) {
      fields.bookingStatus = "Cancel the contract first";
      next.bookingStatus = current.bookingStatus;
    } else {
      next.contractStatus = "NOT_STARTED";
      // A quote or total sent together with Researching is refused below, not cleared.
      if (!("quoteAmount" in changes)) next.quoteAmount = null;
      if (!("contractTotal" in changes)) next.contractTotal = null;
    }
  }

  if (
    next.bookingStatus === "RESEARCHING" &&
    next.quoteAmount !== null &&
    !movingToResearching
  ) {
    next.bookingStatus = "QUOTED";
  }

  if (
    changes.contractStatus === "SIGNED" &&
    current.contractStatus !== "SIGNED" &&
    next.bookingStatus === "QUOTED"
  ) {
    next.bookingStatus = "BOOKED";
  }

  if (next.quoteAmount !== null && next.bookingStatus === "RESEARCHING") {
    fields.quoteAmount ??= "Researching vendors can't have a quote yet";
  }
  if (next.contractTotal !== null && next.contractStatus === "NOT_STARTED") {
    fields.contractTotal ??= "Add a contract first";
  }
  if (
    next.contractStatus !== "NOT_STARTED" &&
    next.bookingStatus === "RESEARCHING"
  ) {
    fields.contractStatus ??= "Researching vendors can't have a contract";
  }
  const activeContractNotAllowed =
    hasActiveContract(next.contractStatus) &&
    !canHoldActiveContract(next.bookingStatus);
  const signedButNotBooked =
    next.contractStatus === "SIGNED" && next.bookingStatus !== "BOOKED";
  if (activeContractNotAllowed || signedButNotBooked) {
    // Reported under the field the request changed.
    const contractChanged =
      "contractStatus" in changes &&
      changes.contractStatus !== current.contractStatus;
    if (contractChanged) {
      fields.contractStatus ??=
        "Only quoted or booked vendors can have an active contract";
    } else if (next.contractStatus === "SIGNED") {
      fields.bookingStatus ??=
        "A vendor with a signed contract is booked. Cancel the contract first";
    } else {
      fields.bookingStatus ??= "Cancel the contract first";
    }
  }

  return { next, fields };
}

/** Why a booking status can't be chosen right now ("" when it can). Same messages as the server. */
export function bookingOptionDisabledReason(
  target: BookingStatus,
  current: VendorFields,
) {
  if (target === current.bookingStatus) return "";
  return (
    applyStatusRules(current, { bookingStatus: target }).fields.bookingStatus ??
    ""
  );
}

/** Why a contract status can't be chosen right now ("" when it can). Same messages as the server. */
export function contractOptionDisabledReason(
  target: ContractStatus,
  current: VendorFields,
) {
  if (target === current.contractStatus) return "";
  return (
    applyStatusRules(current, contractStatusChange(target)).fields
      .contractStatus ?? ""
  );
}

/** The PATCH body for a contract status change. Not started also clears the contract total. */
export function contractStatusChange(
  status: ContractStatus,
): Partial<VendorFields> {
  return status === "NOT_STARTED"
    ? { contractStatus: status, contractTotal: null }
    : { contractStatus: status };
}

/**
 * The server clears the quote and contract when a vendor moves back to Researching,
 * so the UI confirms first when there is something to clear.
 */
export function researchingNeedsConfirmation(
  vendor: Pick<VendorFields, "quoteAmount" | "contractStatus">,
) {
  return vendor.quoteAmount !== null || vendor.contractStatus === "CANCELLED";
}

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

/** The 409 codes DELETE can return. */
export type VendorDeleteConflict = "SIGNED_CONTRACT" | "HAS_EXPENSES";

/**
 * A best guess at whether DELETE will be refused, so the UI can explain first instead
 * of asking "Delete?". Signed contracts are known for sure. Expenses are only known
 * when they show up in the totals; an unpaid expense with no due date doesn't, so the
 * server's 409 HAS_EXPENSES stays the real check and the page handles it after Delete.
 */
export function predictDeleteConflict(
  vendor: Vendor,
): VendorDeleteConflict | null {
  if (vendor.bookingStatus === "BOOKED" && vendor.contractStatus === "SIGNED") {
    return "SIGNED_CONTRACT";
  }
  if (Number(vendor.paidTotal) !== 0 || vendor.nextDueDate !== null)
    return "HAS_EXPENSES";
  return null;
}

export type { VendorField };
