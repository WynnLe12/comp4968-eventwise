import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { VendorRow } from "../../vendor-service/repositories/vendorRepository";
import { editableFields, toIsoUtc, toVendor } from "../../vendor-service/services/vendorMapper";

/** A row as the shared pool returns it: BIGINT and DECIMAL as strings, dates as text. */
const row = {
  vendor_id: "17",
  event_id: "42",
  name: "The Willow House",
  category: "Venue & Catering",
  contact_name: "Grace Hill",
  email: "events@thewillowhouse.example",
  phone: "(555) 014-2280",
  quote_amount: "12800.00",
  contract_total: "12800.00",
  booking_status: "BOOKED",
  contract_status: "SIGNED",
  notes: "Final headcount due 30 days before the event.",
  paid_total: "5000.00",
  balance: "7800.00",
  next_due_date: "2027-06-15",
  created_at: "2026-11-12 17:30:02",
  updated_at: "2026-11-12 18:04:11",
} as unknown as VendorRow;

describe("vendorMapper", () => {
  test("toVendor gives the contract's JSON: camelCase, string IDs and money, ISO UTC timestamps", () => {
    assert.deepEqual(toVendor(row), {
      id: "17",
      eventId: "42",
      name: "The Willow House",
      category: "Venue & Catering",
      contactName: "Grace Hill",
      email: "events@thewillowhouse.example",
      phone: "(555) 014-2280",
      quoteAmount: "12800.00",
      contractTotal: "12800.00",
      bookingStatus: "BOOKED",
      contractStatus: "SIGNED",
      notes: "Final headcount due 30 days before the event.",
      paidTotal: "5000.00",
      balance: "7800.00",
      nextDueDate: "2027-06-15",
      createdAt: "2026-11-12T17:30:02Z",
      updatedAt: "2026-11-12T18:04:11Z",
    });
  });

  test("toVendor keeps nulls as null", () => {
    const vendor = toVendor({ ...row, category: null, contract_total: null, balance: null, next_due_date: null } as VendorRow);
    assert.deepEqual([vendor.category, vendor.contractTotal, vendor.balance, vendor.nextDueDate], [null, null, null, null]);
  });

  test("toIsoUtc", () => {
    assert.equal(toIsoUtc("2027-01-05 09:03:00"), "2027-01-05T09:03:00Z");
  });

  test("editableFields drops the read-only fields", () => {
    assert.deepEqual(Object.keys(editableFields(toVendor(row))).sort(), [
      "bookingStatus", "category", "contactName", "contractStatus", "contractTotal",
      "email", "name", "notes", "phone", "quoteAmount",
    ]);
  });
});
