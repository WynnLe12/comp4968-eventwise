import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { NEW_VENDOR, type VendorDraft } from "../../vendor-service/types";
import { prepareVendor } from "../../vendor-service/services/prepareVendor";
import { cleanInput, validateFields } from "../../vendor-service/services/validation";

/** A valid vendor with only a name, plus any overrides. */
function draft(overrides: Partial<VendorDraft> = {}): VendorDraft {
  return { ...NEW_VENDOR, name: "Rosewood Rentals", ...overrides };
}

describe("cleanInput", () => {
  test("keeps only editable fields; read-only and unknown keys are ignored", () => {
    const changes = cleanInput({
      name: "Rosewood",
      id: 99,
      eventId: 2,
      paidTotal: "100.00",
      balance: "5.00",
      nextDueDate: "2027-01-01",
      updatedAt: "2026-11-11T00:00:00Z",
      website: "rosewood.example",
    });
    assert.deepEqual(changes, { name: "Rosewood" });
  });

  test("trims text, including notes", () => {
    assert.deepEqual(cleanInput({ name: "  Rosewood  ", notes: "\n Call after 5pm \t" }), {
      name: "Rosewood",
      notes: "Call after 5pm",
    });
  });

  test("an empty or whitespace-only string becomes null", () => {
    assert.deepEqual(cleanInput({ email: "", phone: "   " }), { email: null, phone: null });
  });

  test("a money number becomes a string; other numbers are left for validation", () => {
    assert.deepEqual(cleanInput({ quoteAmount: 500, contractTotal: 12.5, name: 7 }), {
      quoteAmount: "500",
      contractTotal: "12.5",
      name: 7,
    });
  });

  test("a body that isn't an object gives no changes", () => {
    for (const body of [null, undefined, "text", 42, ["name"]]) {
      assert.deepEqual(cleanInput(body), {});
    }
  });
});

describe("validateFields", () => {
  test("a vendor with only a name is valid", () => {
    assert.deepEqual(validateFields(draft()), {});
  });

  test("name is required", () => {
    assert.equal(validateFields(draft({ name: null })).name, "Business name is required");
  });

  test("a blank name (spaces only) is required, via cleanInput", () => {
    const result = prepareVendor(NEW_VENDOR, { name: "   " });
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.fields.name, "Business name is required");
  });

  test("name up to 150 characters is allowed; 151 is not", () => {
    assert.deepEqual(validateFields(draft({ name: "a".repeat(150) })), {});
    assert.equal(validateFields(draft({ name: "a".repeat(151) })).name, "Keep this under 150 characters");
  });

  test("every text field has its maximum length", () => {
    const fields = validateFields(
      draft({
        category: "c".repeat(101),
        contactName: "n".repeat(151),
        phone: "1".repeat(41),
        notes: "x".repeat(2001),
      }),
    );
    assert.deepEqual(fields, {
      category: "Keep this under 100 characters",
      contactName: "Keep this under 150 characters",
      phone: "Keep this under 40 characters",
      notes: "Keep this under 2000 characters",
    });
  });

  test("a text field that isn't a string is rejected", () => {
    assert.equal(validateFields(draft({ name: 123 })).name, "Enter text");
    assert.equal(validateFields(draft({ phone: ["555"] })).phone, "Enter text");
  });

  test("email must look like an email; empty is allowed", () => {
    for (const bad of ["not-an-email", "a@b", "a b@c.com", "@example.com"]) {
      assert.equal(validateFields(draft({ email: bad })).email, "Enter a valid email address", bad);
    }
    assert.deepEqual(validateFields(draft({ email: "events@thewillowhouse.example" })), {});
    assert.deepEqual(validateFields(draft({ email: null })), {});
  });

  test("money: valid amounts", () => {
    for (const ok of ["0", "500", "500.5", "500.50", "9999999999.99"]) {
      const fields = validateFields(draft({ bookingStatus: "QUOTED", quoteAmount: ok }));
      assert.deepEqual(fields, {}, ok);
    }
  });

  test("money: negative, 3 decimals, text, too large and non-strings are rejected", () => {
    const message = "Enter an amount of 0 or more, with up to 2 decimals";
    for (const bad of ["-5", "12.345", "abc", "10000000000", "1e5", "", " 5", "5.", true, {}]) {
      const fields = validateFields(draft({ bookingStatus: "QUOTED", quoteAmount: bad }));
      assert.equal(fields.quoteAmount, message, String(bad));
    }
    assert.equal(
      validateFields(draft({ bookingStatus: "QUOTED", contractStatus: "PENDING", contractTotal: "-1" })).contractTotal,
      message,
    );
  });

  test("a money number from JSON is accepted after cleanInput", () => {
    const result = prepareVendor(NEW_VENDOR, { name: "Rosewood", quoteAmount: 500 });
    assert.equal(result.ok && result.vendor.quoteAmount, "500");
  });

  test("old and lowercase status values are rejected", () => {
    for (const bad of ["none", "sent", "booked", "Researching", null, 1]) {
      assert.equal(validateFields(draft({ bookingStatus: bad })).bookingStatus, "Choose a valid booking status", String(bad));
      assert.equal(validateFields(draft({ contractStatus: bad })).contractStatus, "Choose a valid contract status", String(bad));
    }
  });

  test("reports every invalid field at once", () => {
    const result = prepareVendor(NEW_VENDOR, { name: "", email: "not-an-email", quoteAmount: "-5" });
    assert.equal(result.ok, false);
    assert.deepEqual(!result.ok && result.fields, {
      name: "Business name is required",
      email: "Enter a valid email address",
      quoteAmount: "Enter an amount of 0 or more, with up to 2 decimals",
    });
  });
});
