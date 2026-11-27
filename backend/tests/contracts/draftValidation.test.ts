import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../../expense-service/errors";
import { parseCreateDraft, parseDraftConfirmation, parseDraftPatch, parseDraftQuery, parseDraftVersion } from "../../contract-service/services/draftValidation";

function invalid(field?: string) {
  return (error: unknown) => error instanceof ApiError && error.status === 422 &&
    error.code === "VALIDATION_ERROR" && (field === undefined || Boolean(error.fields?.[field]));
}

test("contract drafts require exact document IDs and reject caller-controlled identity and fingerprints", () => {
  assert.deepEqual(parseCreateDraft({ documentId: "18446744073709551615" }), { documentId: "18446744073709551615" });
  for (const documentId of [undefined, null, 1, "0", "01", "-1", "1e3", "18446744073709551616"]) {
    assert.throws(() => parseCreateDraft({ documentId }), invalid("documentId"));
  }
  for (const key of ["eventId", "sub", "status", "contentSha256", "confirmedExpenseId", "extractedJson"]) {
    assert.throws(() => parseCreateDraft({ documentId: "1", [key]: "forged" }), invalid(key));
  }
  for (const body of [null, [], "1"]) assert.throws(() => parseCreateDraft(body), invalid("body"));
});

test("draft edits permit missing values and clearing fields without treating a deposit as paid", () => {
  assert.deepEqual(parseDraftPatch({ version: "1", description: "  DJ contract  ", vendorName: "  DJ  ", totalAmount: "5000.00", depositAmount: "1000.00" }), {
    version: "1", changes: { description: "DJ contract", vendorName: "DJ", totalAmount: "5000.00", depositAmount: "1000.00" },
  });
  assert.deepEqual(parseDraftPatch({ version: "2", description: " ", vendorName: null, categoryId: null, vendorId: null,
    totalAmount: null, depositAmount: null, dueDate: null, currencyCode: null, targetExpenseId: null }), {
    version: "2", changes: { description: null, vendorName: null, categoryId: null, vendorId: null,
      totalAmount: null, depositAmount: null, dueDate: null, currencyCode: null, targetExpenseId: null },
  });
  for (const key of ["paidTotal", "paymentType", "status", "versionOverride", "documentId", "confirmedExpenseId", "contentSha256"]) {
    assert.throws(() => parseDraftPatch({ version: "1", [key]: "forged" }), invalid(key));
  }
});

test("draft edits and discard requests require a version and cannot submit an empty patch", () => {
  assert.deepEqual(parseDraftVersion({ version: "9007199254740993" }), { version: "9007199254740993" });
  for (const version of [undefined, null, 1, "0", "01", "1.0", "18446744073709551616"]) {
    assert.throws(() => parseDraftPatch({ version, description: "Contract" }), invalid("version"));
    assert.throws(() => parseDraftVersion({ version }), invalid("version"));
  }
  assert.throws(() => parseDraftPatch({ version: "1" }), invalid("body"));
  assert.throws(() => parseDraftVersion({ version: "1", status: "REJECTED" }), invalid("status"));
});

test("draft money, dates, currency, text and selected record IDs reject malformed supplied values", () => {
  for (const field of ["totalAmount", "depositAmount"]) {
    for (const value of [0.1, "-0.01", "0.001", "1e3", "NaN", "10000000000.00", "01.00", ""]) {
      assert.throws(() => parseDraftPatch({ version: "1", [field]: value }), invalid(field));
    }
    assert.equal(parseDraftPatch({ version: "1", [field]: "9999999999.99" }).changes[field as "totalAmount"], "9999999999.99");
  }
  for (const dueDate of ["2026-02-29", "2026-04-31", "11/25/2026", "0999-01-01", "2026-01-01T00:00:00Z"]) {
    assert.throws(() => parseDraftPatch({ version: "1", dueDate }), invalid("dueDate"));
  }
  assert.equal(parseDraftPatch({ version: "1", dueDate: "2028-02-29" }).changes.dueDate, "2028-02-29");
  for (const currencyCode of ["cad", "$", "", 1]) assert.throws(() => parseDraftPatch({ version: "1", currencyCode }), invalid("currencyCode"));
  assert.equal(parseDraftPatch({ version: "1", currencyCode: "CAD" }).changes.currencyCode, "CAD");
  for (const field of ["description", "vendorName"]) {
    const max = field === "description" ? 255 : 150;
    assert.throws(() => parseDraftPatch({ version: "1", [field]: "x".repeat(max + 1) }), invalid(field));
    assert.throws(() => parseDraftPatch({ version: "1", [field]: false }), invalid(field));
  }
  for (const field of ["categoryId", "vendorId", "targetExpenseId"]) {
    assert.throws(() => parseDraftPatch({ version: "1", [field]: 1 }), invalid(field));
    assert.equal(parseDraftPatch({ version: "1", [field]: "9007199254740993" }).changes[field as "categoryId"], "9007199254740993");
  }
  assert.equal(parseDraftPatch({ version: "1", saveAction: "UPDATE_EXPENSE", targetExpenseId: "12" }).changes.saveAction, "UPDATE_EXPENSE");
  for (const saveAction of ["update", null, "CONFIRM"]) assert.throws(() => parseDraftPatch({ version: "1", saveAction }), invalid("saveAction"));
});

test("draft listings use bounded pagination and reject repeated or unsupported filters", () => {
  assert.deepEqual(parseDraftQuery(new URLSearchParams()), { limit: 20, offset: 0 });
  assert.deepEqual(parseDraftQuery(new URLSearchParams("limit=5&offset=10&status=CONFIRMED")), { limit: 5, offset: 10, status: "CONFIRMED" });
  for (const query of ["limit=0", "limit=101", "offset=-1", "offset=1000001", "offset=1e3", "status=ready", "limit=1&limit=2", "status=DRAFT&status=DRAFT", "eventId=2"]) {
    assert.throws(() => parseDraftQuery(new URLSearchParams(query)), invalid());
  }
});

test("confirmation requests preserve exact reviewed expense snapshots and reject incomplete or forged baselines", () => {
  const expectedExpense = { categoryId: "9007199254740993", vendorId: "4",
    description: "Existing expense", committedAmount: "500.10", dueDate: null };
  assert.deepEqual(parseDraftConfirmation({ version: "1" }), { version: "1" });
  assert.deepEqual(parseDraftConfirmation({ version: "2", expectedExpense }), { version: "2", expectedExpense });
  for (const snapshot of [null, [], {}, { ...expectedExpense, committedAmount: 500.1 },
    { ...expectedExpense, eventId: "13" }, { ...expectedExpense, paidTotal: "0.00" },
    { categoryId: "1", description: "Missing optional-looking keys", committedAmount: "1.00" }]) {
    assert.throws(() => parseDraftConfirmation({ version: "1", expectedExpense: snapshot }), invalid("expectedExpense"));
  }
  assert.throws(() => parseDraftConfirmation({ version: "1", status: "CONFIRMED" }), invalid("status"));
  assert.throws(() => parseDraftConfirmation({ version: 1 }), invalid("version"));
});

test("confirmation requires a real boolean for the explicit create-vendor choice", () => {
  assert.deepEqual(parseDraftConfirmation({ version: "1", createVendor: true }), { version: "1", createVendor: true });
  assert.deepEqual(parseDraftConfirmation({ version: "1", createVendor: false }), { version: "1", createVendor: false });
  for (const createVendor of ["true", 1, null, {}, []]) {
    assert.throws(() => parseDraftConfirmation({ version: "1", createVendor }), invalid("createVendor"));
  }
  assert.throws(() => parseDraftConfirmation({ version: "1", createVendor: true, vendorName: "Unreviewed" }), invalid("vendorName"));
  assert.throws(() => parseDraftPatch({ version: "1", createVendor: true }), invalid("createVendor"));
});
