import assert from "node:assert/strict";
import { test } from "node:test";
import { suggestContractFields } from "../../contract-service/extraction/contractFieldSuggestions";
import { extractPdfText } from "../../contract-service/extraction/pdfText";
import { PDF_TEXT_LIMITS, PdfTextError, type PdfTextResult } from "../../contract-service/extraction/pdfTextTypes";
import { contractPdf } from "../fixtures/contractPdf";

function source(...pages: string[]): PdfTextResult {
  return { pageCount: pages.length, pages: pages.map((text, index) => ({ pageNumber: index + 1, text })), text: pages.join("\n\n"), emptyPageNumbers: pages.flatMap((text, index) => text.trim() ? [] : [index + 1]) };
}
const evergreen = [
  "EVERGREEN SOUND & EVENTS", "Wedding DJ and event production", "INVOICE SAMPLE / NOT PAYABLE", "FROM", "Evergreen Sound & Events",
  "BILL TO", "Demo Wedding", "ISSUE DATE", "Nov 26, 2026", "PAYMENT DUE DATE", "Dec 10, 2026",
  "Event: June 12, 2027", "Subtotal $600.00", "GST (5%) $30.00", "Total (CAD) $630.00", "Amount paid $0.00", "BALANCE DUE $630.00",
].join("\n");
const florist = [
  "WILLOW & BLOOM", "Floral Design Studio", "INVOICE", "BILL TO", "Demo Couple", "Invoice date: November 26, 2026",
  "Due date: December 18, 2026", "Event date: June 19, 2027", "Subtotal $1,400.00", "GST $70.00", "PST $89.60",
  "Payments received $0.00", "TOTAL DUE $1,559.60", "Payment terms: Full payment by December 18, 2026.",
].join("\n");

test("vendor invoice suggestions use the full total and payment due date, not subtotal or event date", () => {
  const result = suggestContractFields(source(evergreen));
  assert.deepEqual(result.fields, { vendorName: "Evergreen Sound & Events", totalAmount: "630.00", depositAmount: null, dueDate: "2026-12-10" });
  assert.equal(result.reviewRequired, true);
  assert.match(result.evidence.totalAmount![0].text, /Total \(CAD\)/);
  assert.equal(result.evidence.dueDate![0].pageNumber, 1);
  assert.equal(result.evidence.dueDate![0].lineNumber, 10);
});

test("florist invoice total due is usable when explicitly unpaid, with a flagged vendor header suggestion", () => {
  const result = suggestContractFields(source(florist));
  assert.deepEqual(result.fields, { vendorName: "WILLOW & BLOOM", totalAmount: "1559.60", depositAmount: null, dueDate: "2026-12-18" });
  assert.ok(result.warnings.some(warning => warning.field === "vendorName" && warning.code === "VENDOR_FROM_HEADER"));
});

test("real PDF text flows into suggestions with exact cents and source evidence", async () => {
  const pdf = contractPdf([["Vendor name: Example DJ", "Invoice date: Nov 26, 2026", "Contract total: $999.99", "Deposit required: $0.10", "Payment due date: 2026-12-10"]]);
  const result = suggestContractFields(await extractPdfText(pdf));
  assert.deepEqual(result.fields, { vendorName: "Example DJ", totalAmount: "999.99", depositAmount: "0.10", dueDate: "2026-12-10" });
  assert.match(result.evidence.depositAmount![0].text, /0\.10/);
});

test("partial payments do not replace the contract total with the remaining balance", () => {
  const result = suggestContractFields(source("Grand total: $1,000.00\nAmount paid: $300.00\nDeposit paid: $100.00\nBalance due: $700.00\nTotal due: $700.00"));
  assert.equal(result.fields.totalAmount, "1000.00");
  assert.equal(result.fields.depositAmount, null);
  for (const text of ["Total due: $700.00", "Payments received: $300.00\nTotal due: $700.00", "Amount paid: $0.00\nDeposit paid: $100.00\nTotal due: $700.00"]) {
    const unknown = suggestContractFields(source(text));
    assert.equal(unknown.fields.totalAmount, null);
    assert.ok(unknown.warnings.some(warning => warning.field === "totalAmount"));
  }
});

test("conflicting totals, vendor names and due dates stay blank rather than choosing the first match", () => {
  const result = suggestContractFields(source("Vendor: First DJ\nTotal: $100.00\nDue date: Dec 10, 2026", "Vendor: Second DJ\nTotal: $200.00\nDue date: Dec 11, 2026"));
  for (const field of ["vendorName", "totalAmount", "dueDate"] as const) {
    assert.equal(result.fields[field], null);
    assert.equal(result.evidence[field], undefined);
    assert.ok(result.warnings.some(warning => warning.field === field && warning.code === "CONFLICTING_VALUES"));
  }
});

test("repeated equal values across pages retain their evidence without creating a conflict", () => {
  const result = suggestContractFields(source("Invoice total: 100.00\nDue date: Dec 10, 2026", "Grand total: $100\nPayment due: 10 December 2026"));
  assert.equal(result.fields.totalAmount, "100.00");
  assert.equal(result.fields.dueDate, "2026-12-10");
  assert.equal(result.evidence.totalAmount!.length, 2);
  assert.deepEqual(result.evidence.totalAmount!.map(evidence => evidence.pageNumber), [1, 2]);
});

test("amount parsing accepts exact dollar formats but rejects malformed, negative, ambiguous and overflowing values", () => {
  for (const [raw, expected] of [["$0", "0.00"], ["USD 630.1", "630.10"], ["C$1,559.60", "1559.60"], ["9,999,999,999.99 CAD", "9999999999.99"]]) {
    assert.equal(suggestContractFields(source("Total: " + raw)).fields.totalAmount, expected);
  }
  for (const raw of ["$-10.00", "(10.00)", "1.001", "1e3", "10000000000.00", "12,34.56", "1.200,50", "100.00 or 200.00", "about $100", "01.00"]) {
    const result = suggestContractFields(source("Total: " + raw));
    assert.equal(result.fields.totalAmount, null, raw);
    assert.ok(result.warnings.some(warning => warning.code === "AMBIGUOUS_VALUE"), raw);
  }
});

test("a deposit requirement is suggested without deriving percentages or treating payments as a requirement", () => {
  assert.equal(suggestContractFields(source("Total: 1000.00\nDeposit required: $250.00")).fields.depositAmount, "250.00");
  for (const line of ["Deposit paid: $250.00", "Deposit received: $250.00", "Payments received: $250.00", "Deposit required: 25%", "Deposit required: 25% ($250.00)"]) {
    assert.equal(suggestContractFields(source("Total: 1000.00\n" + line)).fields.depositAmount, null);
  }
  const invalid = suggestContractFields(source("Total: 100.00\nDeposit required: 101.00"));
  assert.equal(invalid.fields.depositAmount, null);
  assert.ok(invalid.warnings.some(warning => warning.field === "depositAmount"));
});

test("dates require an explicit payment label, full year and a real calendar date", () => {
  assert.equal(suggestContractFields(source("Invoice date: Dec 1, 2026\nEvent date: June 19, 2027\nPayment terms: Net 14 days")).fields.dueDate, null);
  for (const raw of ["12/10/2026", "Dec 10", "2026-02-29", "April 31, 2026", "next Friday", "2026-12-10 or 2026-12-11"]) {
    assert.equal(suggestContractFields(source("Due date: " + raw)).fields.dueDate, null, raw);
  }
  assert.equal(suggestContractFields(source("Final payment due: 2028-02-29")).fields.dueDate, "2028-02-29");
});

test("unsupported or ambiguous labelled values are not replaced by unrelated values nearby", () => {
  const result = suggestContractFields(source("Total:\nSubtotal: $100.00\nGrand total: $200.00\nDue date: 12/10/2026\nPayment due: Dec 10, 2026"));
  assert.equal(result.fields.totalAmount, null);
  assert.equal(result.fields.dueDate, null);
});

test("customer names and invoice titles are not treated as vendors", () => {
  for (const text of ["INVOICE\nBILL TO\nJordan & Alex", "BILL TO\nExample Events", "Vendor:\nBILL TO\nExample Events", "Vendor: billing@example.com"]) {
    assert.equal(suggestContractFields(source(text)).fields.vendorName, null);
  }
});

test("partial pages are flagged and fields, source data and financial records are never modified", () => {
  const input = source("Vendor: Example DJ\nTotal: $100.00", "");
  const before = structuredClone(input);
  const result = suggestContractFields(input);
  assert.deepEqual(input, before);
  assert.ok(result.warnings.some(warning => warning.code === "PARTIAL_TEXT"));
  assert.deepEqual(Object.keys(result.fields).sort(), ["depositAmount", "dueDate", "totalAmount", "vendorName"]);
  assert.equal(result.reviewRequired, true);
  assert.equal(Object.hasOwn(result.fields, "paidTotal"), false);
  assert.equal(Object.hasOwn(result.fields, "vendorId"), false);
  assert.equal(Object.hasOwn(result.fields, "categoryId"), false);
});

test("large inputs are rejected before label processing", () => {
  assert.throws(() => suggestContractFields(source("A".repeat(PDF_TEXT_LIMITS.characters + 1))), error => error instanceof PdfTextError && error.code === "PDF_TEXT_LIMIT");
  assert.throws(() => suggestContractFields(source(...Array.from({ length: 51 }, () => "Invoice"))), error => error instanceof PdfTextError && error.code === "PDF_PAGE_LIMIT");
});
