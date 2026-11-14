// All the vendor SQL. Every query filters by event_id, so a vendor ID from another
// event never matches. Values always go through ? placeholders, never string-built SQL.
// The shared pool returns BIGINT IDs and DECIMAL money as strings, and dates as text.
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { getDatabasePool } from "../../shared/db/pool";
import type { BookingStatus, ContractStatus, Money, VendorFields } from "../types";

/** A vendors row joined with its totals, as the shared pool returns it. */
export interface VendorRow extends RowDataPacket {
  vendor_id: string;
  event_id: string;
  name: string;
  category: string | null;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  quote_amount: Money | null;
  contract_total: Money | null;
  booking_status: BookingStatus;
  contract_status: ContractStatus;
  notes: string | null;
  paid_total: Money;
  balance: Money | null;
  next_due_date: string | null;
  created_at: string;
  updated_at: string;
}

// paid_total and next_due_date come only from the vendor_payment_totals view (contract §3),
// so the vendor page and the payment alerts always agree.
const SELECT_WITH_TOTALS = `
  SELECT v.vendor_id, v.event_id, v.name, v.category, v.contact_name, v.email, v.phone,
         v.quote_amount, v.contract_total, v.booking_status, v.contract_status, v.notes,
         COALESCE(t.paid_total, 0.00) AS paid_total,
         CASE WHEN v.contract_total IS NULL THEN NULL
              ELSE v.contract_total - COALESCE(t.paid_total, 0.00) END AS balance,
         t.next_due_date,
         v.created_at, v.updated_at
  FROM vendors v
  LEFT JOIN vendor_payment_totals t
    ON t.vendor_id = v.vendor_id AND t.event_id = v.event_id
  WHERE v.event_id = ?`;

/** All of an event's vendors, sorted by name. */
export async function listVendors(eventId: string): Promise<VendorRow[]> {
  const [rows] = await getDatabasePool().execute<VendorRow[]>(
    `${SELECT_WITH_TOTALS} ORDER BY v.name, v.vendor_id`,
    [eventId],
  );
  return rows;
}

/** One vendor, or null if it doesn't exist in this event. */
export async function findVendor(eventId: string, vendorId: string): Promise<VendorRow | null> {
  const [rows] = await getDatabasePool().execute<VendorRow[]>(
    `${SELECT_WITH_TOTALS} AND v.vendor_id = ?`,
    [eventId, vendorId],
  );
  return rows[0] ?? null;
}

function fieldValues(v: VendorFields): (string | null)[] {
  return [
    v.name, v.category, v.contactName, v.email, v.phone,
    v.quoteAmount, v.contractTotal, v.bookingStatus, v.contractStatus, v.notes,
  ];
}

/** Returns the new vendor's ID. */
export async function insertVendor(eventId: string, v: VendorFields): Promise<string> {
  const [result] = await getDatabasePool().execute<ResultSetHeader>(
    `INSERT INTO vendors (event_id, name, category, contact_name, email, phone,
       quote_amount, contract_total, booking_status, contract_status, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [eventId, ...fieldValues(v)],
  );
  return String(result.insertId);
}

export async function updateVendor(eventId: string, vendorId: string, v: VendorFields): Promise<void> {
  await getDatabasePool().execute(
    `UPDATE vendors SET name = ?, category = ?, contact_name = ?, email = ?, phone = ?,
       quote_amount = ?, contract_total = ?, booking_status = ?, contract_status = ?, notes = ?
     WHERE vendor_id = ? AND event_id = ?`,
    [...fieldValues(v), vendorId, eventId],
  );
}

/** Whether any expense (paid or not) is linked to the vendor. */
export async function vendorHasExpenses(eventId: string, vendorId: string): Promise<boolean> {
  const [rows] = await getDatabasePool().execute<RowDataPacket[]>(
    "SELECT 1 FROM expenses WHERE vendor_id = ? AND event_id = ? LIMIT 1",
    [vendorId, eventId],
  );
  return rows.length > 0;
}

export async function deleteVendor(eventId: string, vendorId: string): Promise<void> {
  await getDatabasePool().execute(
    "DELETE FROM vendors WHERE vendor_id = ? AND event_id = ?",
    [vendorId, eventId],
  );
}
