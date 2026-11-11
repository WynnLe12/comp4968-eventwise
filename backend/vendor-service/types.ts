// Vendor types shared by the vendor service. See docs/api/vendors.md for the contract.

export const BOOKING_STATUSES = [
  "RESEARCHING",
  "QUOTED",
  "BOOKED",
  "DECLINED",
] as const;
export const CONTRACT_STATUSES = [
  "NOT_STARTED",
  "PENDING",
  "SIGNED",
  "CANCELLED",
] as const;

export type BookingStatus = (typeof BOOKING_STATUSES)[number];
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

/** Money is kept as a string ("12800.00") so DECIMAL values stay exact. */
export type Money = string;

/** The fields a client may send in POST and PATCH. Everything else is ignored. */
export const EDITABLE_FIELDS = [
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
] as const;

export type EditableField = (typeof EDITABLE_FIELDS)[number];

/** A vendor's stored, editable fields after validation. */
export interface VendorFields {
  name: string;
  category: string | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  quoteAmount: Money | null;
  contractTotal: Money | null;
  bookingStatus: BookingStatus;
  contractStatus: ContractStatus;
  notes: string | null;
}

/**
 * A vendor as it will be saved, before validation. Values come from the request
 * body, so their types aren't known yet.
 */
export type VendorDraft = Record<EditableField, unknown>;

/** The editable fields present in a request body, cleaned but not yet validated. */
export type VendorChanges = Partial<VendorDraft>;

/** Field name -> message, shown under that field in the UI (422 `error.fields`). */
export type FieldErrors = Partial<Record<EditableField, string>>;

/** What a new vendor starts as before the request's fields are applied. */
export const NEW_VENDOR: VendorDraft = {
  name: null,
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
