// Database row (snake_case) -> API JSON (camelCase), the shape in docs/api/vendors.md 2.
import type { VendorRow } from "../repositories/vendorRepository";
import { EDITABLE_FIELDS, type Money, type VendorFields } from "../types";

/** A vendor as the API returns it. IDs are strings, like every EventWise API. */
export interface Vendor extends VendorFields {
  id: string;
  eventId: string;
  paidTotal: Money;
  balance: Money | null;
  nextDueDate: string | null;
  createdAt: string;
  updatedAt: string;
}

/** "2026-11-12 17:30:02" (UTC, from MySQL) -> "2026-11-12T17:30:02Z". */
export function toIsoUtc(timestamp: string): string {
  return `${timestamp.replace(" ", "T")}Z`;
}

export function toVendor(row: VendorRow): Vendor {
  return {
    id: String(row.vendor_id),
    eventId: String(row.event_id),
    name: row.name,
    category: row.category,
    contactName: row.contact_name,
    email: row.email,
    phone: row.phone,
    quoteAmount: row.quote_amount,
    contractTotal: row.contract_total,
    bookingStatus: row.booking_status,
    contractStatus: row.contract_status,
    notes: row.notes,
    paidTotal: row.paid_total,
    balance: row.balance,
    nextDueDate: row.next_due_date,
    createdAt: toIsoUtc(row.created_at),
    updatedAt: toIsoUtc(row.updated_at),
  };
}

/** Only the editable fields of a vendor, e.g. the current values before a PATCH. */
export function editableFields(vendor: VendorFields): VendorFields {
  const fields = {} as Record<string, unknown>;
  for (const key of EDITABLE_FIELDS) fields[key] = vendor[key];
  return fields as unknown as VendorFields;
}
