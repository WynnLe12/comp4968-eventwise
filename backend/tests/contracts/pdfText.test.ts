import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { S3Client } from "@aws-sdk/client-s3";
import { ApiError } from "../../expense-service/errors";
import { createDocumentTextReader, type VerifiedTextDocument } from "../../contract-service/extraction/documentTextReader";
import { extractPdfText, PDF_TEXT_LIMITS, PdfTextError } from "../../contract-service/extraction/pdfText";
import { contractPdf } from "../fixtures/contractPdf";

const pdf = contractPdf([["Evergreen Events", "Invoice total: $630.00", "Deposit required: $100.00", "Due: December 10, 2026"]]);
const document: VerifiedTextDocument = {
  eventId: "3", documentId: "9", s3ObjectKey: "events/3/documents/12345678-1234-1234-1234-123456789abc",
  contentType: "application/pdf", sizeBytes: String(pdf.length), contentSha256: createHash("sha256").update(pdf).digest("hex"),
};
const failure = (code: string) => (error: unknown) => error instanceof PdfTextError && error.code === code;
const apiFailure = (code: string) => (error: unknown) => error instanceof ApiError && error.code === code;
function client(send: (...args: any[]) => Promise<any>) { return { send } as unknown as S3Client; }
async function* stream(bytes: Uint8Array) { yield bytes.subarray(0, 30); yield bytes.subarray(30); }
function object(bytes = pdf, contentType = "application/pdf") { return { ContentType: contentType, ContentLength: bytes.length, Body: stream(bytes) }; }

test("real PDF parsing preserves invoice text, decimal amounts and page boundaries without mutating input", async () => {
  const original = Buffer.from(pdf);
  const result = await extractPdfText(pdf);
  assert.equal(result.pageCount, 1);
  assert.match(result.text, /Evergreen Events/);
  assert.match(result.text, /630\.00/); assert.match(result.text, /100\.00/);
  assert.match(result.text, /December 10, 2026/);
  assert.deepEqual(result.emptyPageNumbers, []);
  assert.equal(result.pages[0].pageNumber, 1);
  assert.deepEqual(pdf, original);
});

test("mixed PDFs identify blank or scanned pages rather than reporting complete extraction", async () => {
  const result = await extractPdfText(contractPdf([["Page one invoice"], [], ["Page three terms"]]));
  assert.equal(result.pageCount, 3);
  assert.deepEqual(result.emptyPageNumbers, [2]);
  assert.equal(result.pages[1].text, "");
  assert.match(result.text, /Page one invoice/); assert.match(result.text, /Page three terms/);
});

test("PDFs without selectable text require manual entry", async () => {
  await assert.rejects(extractPdfText(contractPdf([[]])), failure("PDF_NO_TEXT"));
});

test("wrong file types, damaged PDFs and oversized inputs fail with sanitized fallback errors", async () => {
  await assert.rejects(extractPdfText(Buffer.from("not a PDF with private invoice text")), failure("INVALID_PDF"));
  await assert.rejects(extractPdfText(Buffer.from("%PDF-1.7\nprivate invoice text, damaged file")), error => {
    assert.ok(error instanceof PdfTextError);
    assert.equal(error.message.includes("private invoice"), false);
    return error.code === "PDF_READ_FAILED";
  });
  await assert.rejects(extractPdfText(new Uint8Array(PDF_TEXT_LIMITS.bytes + 1)), failure("PDF_TOO_LARGE"));
});

test("PDF parsing stops at the page and extracted-text limits", async () => {
  await assert.rejects(extractPdfText(contractPdf(Array.from({ length: 51 }, () => ["Invoice"]))), failure("PDF_PAGE_LIMIT"));
  await assert.rejects(extractPdfText(contractPdf([["A".repeat(PDF_TEXT_LIMITS.characters + 1)]], 0.001)), failure("PDF_TEXT_LIMIT"));
});

test("parser timeout terminates its worker and a subsequent parse still succeeds", async () => {
  await assert.rejects(extractPdfText(pdf, 1), failure("PDF_TIMEOUT"));
  const result = await extractPdfText(pdf);
  assert.match(result.text, /630\.00/);
});

test("S3 text reading verifies event key, metadata and SHA-256 before parsing", async () => {
  let parsed = 0;
  const read = createDocumentTextReader(client(async (command, options) => {
    assert.deepEqual(command.input, { Bucket: "test-documents", Key: document.s3ObjectKey });
    assert.ok(options.abortSignal instanceof AbortSignal);
    return object();
  }), "test-documents", async bytes => { parsed++; assert.deepEqual(Buffer.from(bytes), pdf); return { pageCount: 1, pages: [{ pageNumber: 1, text: "Invoice" }], text: "Invoice", emptyPageNumbers: [] }; });
  const result = await read(document);
  assert.equal(parsed, 1); assert.equal(result.eventId, "3"); assert.equal(result.documentId, "9");
  assert.equal(result.contentSha256, document.contentSha256);
});

test("wrong-event keys, unverified documents, images and invalid sizes never reach S3", async () => {
  const read = createDocumentTextReader(client(async () => { assert.fail("No S3 request expected"); }), "test-documents");
  for (const changed of [ { s3ObjectKey: "events/4/documents/12345678-1234-1234-1234-123456789abc" }, { sizeBytes: "10485761" }, { sizeBytes: "0" } ]) {
    await assert.rejects(read({ ...document, ...changed }), apiFailure("INVALID_DOCUMENT"));
  }
  await assert.rejects(read({ ...document, contentSha256: null }), apiFailure("DOCUMENT_UNVERIFIED"));
  await assert.rejects(read({ ...document, contentType: "image/png" }), apiFailure("PDF_REQUIRED"));
});

test("changed metadata, streamed length or file bytes are rejected before PDF parsing", async () => {
  const noParse = async () => { assert.fail("Changed content must not be parsed"); };
  const modified = Buffer.from(pdf); modified[modified.length - 2] ^= 1;
  const cases = [
    () => object(pdf, "image/png"),
    () => ({ ...object(), ContentLength: pdf.length + 1 }),
    () => ({ ...object(), Body: stream(pdf.subarray(0, pdf.length - 1)) }),
    () => ({ ...object(), Body: stream(Buffer.concat([pdf, Buffer.from("extra")])) }),
    () => object(modified),
  ];
  for (const make of cases) {
    const read = createDocumentTextReader(client(async () => make()), "test-documents", noParse);
    await assert.rejects(read(document), apiFailure("DOCUMENT_CHANGED"));
  }
});

test("S3 failures and unexpected parser errors never expose storage keys or invoice text", async () => {
  const read = createDocumentTextReader(client(async () => { throw new Error("private bucket credentials and invoice text"); }), "test-documents");
  await assert.rejects(read(document), error => error instanceof ApiError && error.code === "DOCUMENT_UNAVAILABLE" && !error.message.includes("private"));
  const parseFailure = createDocumentTextReader(client(async () => object()), "test-documents", async () => { throw new Error("private invoice text"); });
  await assert.rejects(parseFailure(document), failure("PDF_READ_FAILED"));
});
