import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function load(name, imports = {}) {
  const source = readFileSync(new URL("../src/features/vendors/" + name + ".ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const module = { exports: {} };
  new Function("require", "module", "exports", outputText)(name => {
    assert.ok(Object.hasOwn(imports, name), "Unexpected dependency: " + name);
    return imports[name];
  }, module, module.exports);
  return module.exports;
}
const validation = load("contractDraftValidation");
const draft = {
  draftId: "1", eventId: "3", version: "2", status: "DRAFT", documentId: "6",
  documentFilename: "contract.pdf", documentContentType: "application/pdf", description: "Review", categoryId: "19", vendorId: null,
  vendorName: null, totalAmount: "100.00", depositAmount: null, dueDate: null,
  currencyCode: "USD", saveAction: "CREATE_EXPENSE", targetExpenseId: null, confirmedExpenseId: null,
};
const values = () => validation.contractDraftFormValues(draft);

test("draft edits preserve exact cents without recording payments or changing currency metadata", () => {
  const result = validation.prepareContractDraftChanges({ ...values(), totalAmount: "9999999999.99", depositAmount: "0.1" }, draft);
  assert.deepEqual(result.errors, {});
  assert.deepEqual(result.changes, { totalAmount: "9999999999.99", depositAmount: "0.10" });
});

test("drafts can remain incomplete and optional values can be cleared explicitly", () => {
  const result = validation.prepareContractDraftChanges({ ...values(), description: " ", totalAmount: "", categoryId: "" }, draft);
  assert.deepEqual(result.errors, {});
  assert.deepEqual(result.changes, { description: null, categoryId: null, totalAmount: null });
  assert.deepEqual(validation.prepareContractDraftChanges(values(), draft).changes, {});
});

test("invalid amounts and deposits above the total cannot be saved", () => {
  for (const totalAmount of ["-1", "1.001", "1e3", "10000000000", "NaN", "01", "1,000"]) {
    assert.ok(validation.prepareContractDraftChanges({ ...values(), totalAmount }, draft).errors.totalAmount, totalAmount);
  }
  assert.ok(validation.prepareContractDraftChanges({ ...values(), depositAmount: "100.01" }, draft).errors.depositAmount);
  assert.deepEqual(validation.prepareContractDraftChanges({ ...values(), totalAmount: "0", depositAmount: "0" }, draft).errors, {});
});

test("invalid dates, oversized text and unsafe IDs are rejected", () => {
  for (const dueDate of ["2026-02-29", "2026-04-31", "0999-01-01", "2026-11-26T00:00:00Z"]) {
    assert.ok(validation.prepareContractDraftChanges({ ...values(), dueDate }, draft).errors.dueDate);
  }
  assert.deepEqual(validation.prepareContractDraftChanges({ ...values(), dueDate: "2028-02-29" }, draft).errors, {});
  const invalid = validation.prepareContractDraftChanges({ ...values(), description: "x".repeat(256), vendorName: "x".repeat(151), categoryId: "18446744073709551616", vendorId: "1.5" }, draft);
  for (const field of ["description", "vendorName", "categoryId", "vendorId"]) assert.ok(invalid.errors[field]);
});

async function withApi(fetch, run, authenticate = async () => ({ session: { tokens: { accessToken: { toString: () => "test-access-token" } } } })) {
  const previous = globalThis.fetch;
  globalThis.fetch = fetch;
  try {
    const api = load("contractsApi", {
      "../auth/services/authService": { requireAuthSession: authenticate },
      "../../services/apiConfig": { apiUrl: path => "/api" + path },
    });
    await run(api);
  } finally { globalThis.fetch = previous; }
}

test("saving sends only reviewed fields and the displayed version, preserving the response version", async () => {
  await withApi(async (url, options) => {
    assert.equal(url, "/api/events/3/contract-drafts/1");
    assert.equal(options.method, "PATCH");
    assert.equal(options.headers.Authorization, "Bearer test-access-token");
    assert.deepEqual(JSON.parse(options.body), { version: "2", totalAmount: "150.00" });
    return Response.json({ data: { ...draft, totalAmount: "150.00", version: "3" } });
  }, async api => {
    const saved = await api.saveContractDraft("3", "1", "2", { totalAmount: "150.00", paidTotal: "150.00", status: "CONFIRMED" });
    assert.equal(saved.version, "3");
    assert.equal(saved.status, "DRAFT");
  });
});

test("stale versions and finalized drafts require a reload instead of a silent retry", async () => {
  for (const code of ["DRAFT_CHANGED", "DRAFT_NOT_EDITABLE"]) {
    let requests = 0;
    await withApi(async () => { requests++; return Response.json({ error: { code } }, { status: 409 }); }, async api => {
      await assert.rejects(api.saveContractDraft("3", "1", "2", { totalAmount: "150.00" }), error => error instanceof api.ContractDraftSaveError && error.reloadRequired);
      assert.equal(requests, 1);
    });
  }
});

test("validation errors are mapped to safe inline messages without exposing server details", async () => {
  await withApi(async () => Response.json({ error: { fields: { categoryId: "SQL or private diagnostics", unexpected: "private" } } }, { status: 422 }), async api => {
    await assert.rejects(api.saveContractDraft("3", "1", "2", { categoryId: "19" }), error => {
      assert.deepEqual(error.fields, { categoryId: "Choose a category from this event." });
      return !error.message.includes("SQL");
    });
  });
});

test("unauthenticated saves make no request, and wrong-event responses cannot enter the UI", async () => {
  await withApi(async () => { assert.fail("No unauthenticated request expected"); }, async api => {
    await assert.rejects(api.saveContractDraft("3", "1", "2", { description: "test" }), /sign in again/);
  }, async () => { throw new Error("Signed out"); });
  await withApi(async () => Response.json({ data: { ...draft, eventId: "4" } }), async api => {
    await assert.rejects(api.saveContractDraft("3", "1", "2", { description: "test" }), /couldn't read/);
  });
});

const confirmation = load("contractConfirmationReadiness", { "./contractDraftValidation": validation });

test("confirmation requires saved dollar amounts without a currency requirement", () => {
  assert.deepEqual(confirmation.contractDraftConfirmationIssues(draft), []);
  const cad = { ...draft, currencyCode: "CAD", totalAmount: "630.00" };
  assert.deepEqual(confirmation.contractDraftConfirmationIssues(cad), []);
  assert.deepEqual(confirmation.contractDraftConfirmationIssues({ ...cad, currencyCode: null }), []);
  assert.equal(cad.currencyCode, "CAD");
  assert.equal(cad.totalAmount, "630.00");
  const issues = confirmation.contractDraftConfirmationIssues({ ...draft, description: null, categoryId: null, totalAmount: null });
  assert.ok(issues.some(issue => issue.includes("expense name")));
  assert.ok(issues.some(issue => issue.includes("category")));
  assert.ok(issues.some(issue => issue.includes("total amount")));
});

test("confirmation blocks finalized drafts, absent source documents and unresolved vendor choices", () => {
  for (const status of ["CONFIRMED", "REJECTED"]) assert.ok(confirmation.contractDraftConfirmationIssues({ ...draft, status }).length);
  assert.ok(confirmation.contractDraftConfirmationIssues({ ...draft, documentId: null }).length);
  assert.ok(confirmation.contractDraftConfirmationIssues({ ...draft, vendorName: "Vendor not linked" }).some(issue => issue.includes("existing vendor")));
  assert.deepEqual(confirmation.contractDraftConfirmationIssues({ ...draft, vendorName: "Vendor linked", vendorId: "7" }), []);
  assert.ok(confirmation.contractDraftConfirmationIssues({ ...draft, saveAction: "UPDATE_EXPENSE", targetExpenseId: "40" }).some(issue => issue.includes("existing expense")));
  assert.ok(confirmation.contractDraftConfirmationIssues({ ...draft, depositAmount: "100.01" }).some(issue => issue.includes("deposit")));
});

test("confirmation POSTs only the displayed version and accepts idempotent replay", async () => {
  for (const created of [true, false]) {
    await withApi(async (url, options) => {
      assert.equal(url, "/api/events/3/contract-drafts/1/confirm");
      assert.equal(options.method, "POST");
      assert.equal(options.headers.Authorization, "Bearer test-access-token");
      assert.deepEqual(JSON.parse(options.body), { version: "2" });
      return Response.json({ data: { ...draft, status: "CONFIRMED", version: "3", confirmedExpenseId: "40" }, created }, { status: created ? 201 : 200 });
    }, async api => {
      const result = await api.confirmContractDraft("3", "1", "2");
      assert.equal(result.draft.confirmedExpenseId, "40");
      assert.equal(result.created, created);
    });
  }
});

test("unverified confirmation responses cannot be presented as saved expenses", async () => {
  for (const invalid of [
    { data: draft, created: true },
    { data: { ...draft, status: "CONFIRMED", confirmedExpenseId: null }, created: true },
    { data: { ...draft, status: "CONFIRMED", confirmedExpenseId: "40" } },
    { data: { ...draft, eventId: "4", status: "CONFIRMED", confirmedExpenseId: "40" }, created: true },
  ]) {
    await withApi(async () => Response.json(invalid), async api => {
      await assert.rejects(api.confirmContractDraft("3", "1", "2"));
    });
  }
});

test("confirmation conflicts stop for reload without retrying a financial write", async () => {
  let requests = 0;
  await withApi(async () => { requests++; return Response.json({ error: { code: "DRAFT_CHANGED" } }, { status: 409 }); }, async api => {
    await assert.rejects(api.confirmContractDraft("3", "1", "2"), error => error instanceof api.ContractDraftSaveError && error.reloadRequired);
    assert.equal(requests, 1);
  });
});

const amounts = load("contractAmount");
test("contract amounts use a plain dollar sign and preserve exact cents", () => {
  assert.equal(amounts.formatContractAmount("630.00"), "$630.00");
  assert.equal(amounts.formatContractAmount("9999999999.99"), "$9,999,999,999.99");
  assert.equal(amounts.formatContractAmount("0.01"), "$0.01");
  assert.equal(amounts.formatContractAmount(null), "Not set");
  const edits = validation.prepareContractDraftChanges({ ...values(), totalAmount: "630" }, { ...draft, currencyCode: "CAD" });
  assert.deepEqual(edits.changes, { totalAmount: "630.00" });
  assert.equal(Object.hasOwn(validation.contractDraftFormValues(draft), "currencyCode"), false);
});

const contractDocuments = load("contractDocuments", { "../documents/documentsApi": {} });
const document = { documentId: "9", eventId: "3", filename: "contract.pdf", contentType: "application/pdf", sizeBytes: "27882", uploadedAt: "2026-11-26 12:19:25" };

test("document picker accepts completed PDF and image uploads within the size limit", () => {
  const documents = [document, { ...document, documentId: "10", contentType: "image/jpeg", sizeBytes: "10485760" }, { ...document, documentId: "11", contentType: "image/png", sizeBytes: "1" }];
  assert.deepEqual(contractDocuments.eligibleContractDocuments(documents, "3"), documents);
  assert.deepEqual(contractDocuments.eligibleContractDocuments([], "3"), []);
});

test("document picker excludes unsupported, empty and oversized files", () => {
  for (const change of [ { contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }, { sizeBytes: "0" }, { sizeBytes: "10485761" } ]) {
    assert.deepEqual(contractDocuments.eligibleContractDocuments([{ ...document, ...change }], "3"), []);
  }
});

test("document picker rejects another event's documents and malformed or duplicate identities", () => {
  for (const documents of [null, [{ ...document, eventId: "4" }], [{ ...document, documentId: "18446744073709551616" }], [{ ...document, documentId: "01" }], [{ ...document, sizeBytes: "unknown" }], [document, document]]) {
    assert.throws(() => contractDocuments.eligibleContractDocuments(documents, "3"), /couldn't read/);
  }
});

test("draft creation sends only the selected document ID and opens the server's new or reused draft", async () => {
  for (const created of [true, false]) {
    await withApi(async (url, options) => {
      assert.equal(url, "/api/events/3/contract-drafts");
      assert.equal(options.method, "POST");
      assert.equal(options.headers.Authorization, "Bearer test-access-token");
      assert.equal(options.headers["Content-Type"], "application/json");
      assert.deepEqual(JSON.parse(options.body), { documentId: "9" });
      return Response.json({ data: { draftId: "9007199254740993" }, created }, { status: created ? 201 : 200 });
    }, async api => {
      assert.deepEqual(await api.createContractDraft("3", "9"), { draftId: "9007199254740993", created });
    });
  }
});

test("draft creation rejects invalid IDs before sending a request and validates returned draft identities", async () => {
  await withApi(async () => { assert.fail("Invalid selection must not make a request"); }, async api => {
    for (const id of ["0", "01", "-1", "18446744073709551616", ""] ) await assert.rejects(api.createContractDraft("3", id));
  });
  for (const invalid of [null, {}, { data: { draftId: "0" }, created: true }, { data: { draftId: "2" }, created: "true" }, { data: { draftId: "18446744073709551616" }, created: false }]) {
    await withApi(async () => Response.json(invalid), async api => {
      await assert.rejects(api.createContractDraft("3", "9"), /couldn't read/);
    });
  }
});

test("document creation failures give useful guidance without leaking private storage errors", async () => {
  for (const [status, code, expected] of [
    [404, "NOT_FOUND", /no longer available/], [422, "INVALID_DOCUMENT", /PDF, JPG or PNG/],
    [409, "DOCUMENT_CHANGED", /document changed/], [409, "DUPLICATE_CONTRACT", /conflicting saved drafts/],
    [503, "DOCUMENT_UNAVAILABLE", /source file couldn't be read/], [500, "INTERNAL_ERROR", /couldn't create/],
  ]) {
    await withApi(async () => Response.json({ error: { code, message: "private-bucket-key" } }, { status }), async api => {
      await assert.rejects(api.createContractDraft("3", "9"), error => expected.test(error.message) && !error.message.includes("private-bucket-key"));
    });
  }
});

test("signed-out draft creation never sends a request", async () => {
  await withApi(async () => { assert.fail("No unauthenticated request expected"); }, async api => {
    await assert.rejects(api.createContractDraft("3", "9"), /sign in again/);
  }, async () => { throw new Error("Signed out"); });
});


const extraction = { data: { ...draft, version: "3", dueDate: "2026-12-18" }, appliedFields: ["dueDate"], skippedFields: ["totalAmount"], warnings: [{ field: "totalAmount", code: "SAVED_VALUE_KEPT" }] };

test("extraction sends only the current version with access-token auth and returns review feedback", async () => {
  await withApi(async (url, options) => {
    assert.equal(url, "/api/events/3/contract-drafts/1/extract");
    assert.equal(options.method, "POST");
    assert.equal(options.headers.Authorization, "Bearer test-access-token");
    assert.deepEqual(JSON.parse(options.body), { version: "2" });
    return Response.json(extraction);
  }, async api => {
    const result = await api.extractContractDraft("3", "1", "2");
    assert.equal(result.draft.version, "3");
    assert.equal(result.draft.description, "Review");
    assert.equal(result.draft.status, "DRAFT");
    assert.deepEqual(result.appliedFields, ["dueDate"]);
    assert.deepEqual(result.skippedFields, ["totalAmount"]);
  });
});

test("extraction rejects wrong-event, finalized, stale and malformed results before updating the UI", async () => {
  for (const change of [{ data: { ...extraction.data, eventId: "4" } }, { data: { ...extraction.data, status: "CONFIRMED" } },
    { data: { ...extraction.data, version: "2" } }, { appliedFields: ["paidTotal"] }, { skippedFields: ["dueDate"] },
    { appliedFields: ["dueDate", "dueDate"] }, { warnings: [{ field: "totalAmount", code: "private" }] }]) {
    await withApi(async () => Response.json({ ...extraction, ...change }), async api => {
      await assert.rejects(api.extractContractDraft("3", "1", "2"));
    });
  }
});

test("extraction conflicts require reload and never automatically retry a stale write", async () => {
  let calls = 0;
  await withApi(async () => { calls++; return Response.json({ error: { code: "DRAFT_CHANGED" } }, { status: 409 }); }, async api => {
    await assert.rejects(api.extractContractDraft("3", "1", "2"), error => error instanceof api.ContractDraftSaveError && error.reloadRequired);
    assert.equal(calls, 1);
  });
});

test("extraction errors give manual-entry or retry guidance without displaying private server messages", async () => {
  for (const [status, code, expected] of [[422, "PDF_NO_TEXT", /scanned PDF/], [422, "PDF_PASSWORD_REQUIRED", /password protected/],
    [422, "PDF_REQUIRED", /image details manually/], [422, "PDF_PAGE_LIMIT", /50 pages/], [422, "PDF_TIMEOUT", /too long/],
    [503, "DOCUMENT_UNAVAILABLE", /source file/], [500, "INTERNAL_ERROR", /couldn't extract/], [401, "UNAUTHENTICATED", /sign in again/]]) {
    await withApi(async () => Response.json({ error: { code, message: "private storage key" } }, { status }), async api => {
      await assert.rejects(api.extractContractDraft("3", "1", "2"), error => expected.test(error.message) && !error.message.includes("private storage"));
    });
  }
});

test("signed-out or invalid extraction selections make no request", async () => {
  await withApi(async () => { assert.fail("No invalid request expected"); }, async api => {
    for (const version of ["", "0", "01", "18446744073709551616"]) await assert.rejects(api.extractContractDraft("3", "1", version));
    await assert.rejects(api.extractContractDraft("3", "1", "2"), /sign in again/);
  }, async () => { throw new Error("Signed out"); });
});

const feedback = load("contractExtractionFeedback");
test("extraction feedback distinguishes filled and preserved fields and flags partial or uncertain text", () => {
  const message = feedback.contractExtractionFeedback({ ...extraction, draft: extraction.data,
    warnings: [{ field: "vendorName", code: "VENDOR_FROM_HEADER" }, { field: null, code: "PARTIAL_TEXT" }, { field: "totalAmount", code: "CONFLICTING_VALUES" }] });
  for (const expected of [/due date/, /saved details were kept/, /vendor name/, /Some pages/, /conflicting/, /No expense or payment was created/]) assert.match(message, expected);
  assert.match(feedback.contractExtractionFeedback({ appliedFields: [], skippedFields: [], warnings: [] }), /No new details/);
});
