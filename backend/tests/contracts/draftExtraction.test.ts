import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../../expense-service/errors";
import type { Draft } from "../../contract-service/types";
import { draftExtractionPatch } from "../../contract-service/extraction/draftExtractionPatch";
import { DraftExtractionService, type DraftExtractionStore } from "../../contract-service/extraction/draftExtractionService";
import { suggestContractFields } from "../../contract-service/extraction/contractFieldSuggestions";
import { PdfTextError, type PdfTextResult } from "../../contract-service/extraction/pdfTextTypes";

const draft: Draft = { draftId: "1", eventId: "3", documentId: "9", documentFilename: "invoice.pdf", documentContentType: "application/pdf",
  status: "DRAFT", version: "1", description: null, categoryId: null, vendorId: null, vendorName: null,
  totalAmount: null, depositAmount: null, dueDate: null, currencyCode: null, saveAction: "CREATE_EXPENSE", targetExpenseId: null,
  confirmedExpenseId: null, createdAt: "2026-11-26 12:00:00", updatedAt: "2026-11-26 12:00:00", confirmedAt: null };
const text: PdfTextResult = { pageCount: 1, text: "Vendor: Example DJ\nTotal: 630.00\nDeposit required: 100.00\nDue date: Dec 10, 2026", emptyPageNumbers: [],
  pages: [{ pageNumber: 1, text: "Vendor: Example DJ\nTotal: 630.00\nDeposit required: 100.00\nDue date: Dec 10, 2026" }] };
const suggestions = suggestContractFields(text);
const document = { eventId: "3", documentId: "9", s3ObjectKey: "events/3/documents/12345678-1234-1234-1234-123456789abc", contentType: "application/pdf", sizeBytes: "100", contentSha256: "a".repeat(64) };

test("blank draft fields receive only the four supported suggestions", () => {
  const fill = draftExtractionPatch(draft, suggestions);
  assert.deepEqual(fill.changes, { vendorName: "Example DJ", totalAmount: "630.00", depositAmount: "100.00", dueDate: "2026-12-10" });
  assert.deepEqual(fill.skippedFields, []);
  for (const name of ["description", "vendorId", "categoryId", "currencyCode", "paidTotal", "saveAction"]) assert.equal(Object.hasOwn(fill.changes, name), false);
});

test("reviewed values including zero totals and existing vendor links are preserved", () => {
  const reviewed = { ...draft, vendorName: "Reviewed DJ", vendorId: "7", totalAmount: "0.00", depositAmount: "0.00", dueDate: "2027-01-15" };
  const before = structuredClone(reviewed);
  const fill = draftExtractionPatch(reviewed, suggestions);
  assert.deepEqual(fill.changes, {}); assert.deepEqual(reviewed, before);
  assert.equal(fill.skippedFields.length, 4);
  assert.ok(fill.warnings.some(warning => warning.field === "vendorName" && warning.code === "LINKED_VENDOR_KEPT"));
});

test("missing or ambiguous suggestions never clear saved values", () => {
  const empty = suggestContractFields({ ...text, text: "Invoice", pages: [{ pageNumber: 1, text: "Invoice" }] });
  assert.deepEqual(draftExtractionPatch({ ...draft, totalAmount: "500.00" }, empty).changes, {});
});

test("merging suggestions cannot reduce a total below a saved deposit or add a deposit above a reviewed total", () => {
  const lower = draftExtractionPatch({ ...draft, depositAmount: "700.00" }, suggestions);
  assert.equal(lower.changes.totalAmount, undefined);
  assert.ok(lower.warnings.some(warning => warning.field === "totalAmount" && warning.code === "AMOUNT_CONFLICT"));
  const higher = draftExtractionPatch({ ...draft, totalAmount: "50.00" }, suggestions);
  assert.equal(higher.changes.depositAmount, undefined);
  assert.ok(higher.warnings.some(warning => warning.field === "depositAmount" && warning.code === "AMOUNT_CONFLICT"));
});

test("provider output is validated before any draft mutation", () => {
  assert.throws(() => draftExtractionPatch(draft, { ...suggestions, fields: { ...suggestions.fields, totalAmount: "-1.00" } }), error => error instanceof ApiError && error.status === 422);
});

test("extraction orchestration authorizes first and preserves the displayed version through read and apply", async () => {
  const calls: string[] = [];
  const snapshot = { draft, document };
  const store: DraftExtractionStore = {
    async snapshot(eventId, draftId, sub, version) { assert.deepEqual([eventId, draftId, sub, version], ["3", "1", "owner", "1"]); calls.push("snapshot"); return snapshot; },
    async apply(value, sub, result) { assert.equal(value, snapshot); assert.equal(sub, "owner"); assert.deepEqual(result.fields, suggestions.fields); calls.push("apply"); return { draft, ...draftExtractionPatch(draft, result) }; },
  };
  const service = new DraftExtractionService(store, async value => { assert.equal(value, document); calls.push("read"); return text; });
  await service.extract("3", "1", "owner", { version: "1" });
  assert.deepEqual(calls, ["snapshot", "read", "apply"]);
});

test("invalid identities, forged request fields and access failures never reach file reading", async () => {
  let reads = 0;
  const store: DraftExtractionStore = { async snapshot() { throw new ApiError(403, "FORBIDDEN", "No event access."); }, async apply() { assert.fail("No apply expected"); } };
  const service = new DraftExtractionService(store, async () => { reads++; return text; });
  for (const body of [{ version: "1", sub: "owner" }, { version: "0" }, { version: "1", documentId: "99" }]) await assert.rejects(service.extract("3", "1", "owner", body));
  await assert.rejects(service.extract("3", "1", "", { version: "1" }), error => error instanceof ApiError && error.status === 401);
  await assert.rejects(service.extract("3", "1", "outsider", { version: "1" }), error => error instanceof ApiError && error.status === 403);
  assert.equal(reads, 0);
});

test("parser failures provide manual-entry guidance and unexpected errors hide private details", async () => {
  const store: DraftExtractionStore = { async snapshot() { return { draft, document }; }, async apply() { assert.fail("No apply expected"); } };
  const scanned = new DraftExtractionService(store, async () => { throw new PdfTextError("PDF_NO_TEXT"); });
  await assert.rejects(scanned.extract("3", "1", "owner", { version: "1" }), error => error instanceof ApiError && error.status === 422 && error.code === "PDF_NO_TEXT");
  const failed = new DraftExtractionService(store, async () => { throw new Error("private SQL and storage key"); });
  await assert.rejects(failed.extract("3", "1", "owner", { version: "1" }), error => error instanceof ApiError && error.code === "EXTRACTION_FAILED" && !error.message.includes("private"));
});
