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
  documentFilename: "contract.pdf", description: "Review", categoryId: "19", vendorId: null,
  vendorName: null, totalAmount: "100.00", depositAmount: null, dueDate: null,
  currencyCode: "USD", saveAction: "CREATE_EXPENSE", targetExpenseId: null, confirmedExpenseId: null,
};
const values = () => validation.contractDraftFormValues(draft);

test("draft edits preserve exact cents and normalize currency without recording payments", () => {
  const result = validation.prepareContractDraftChanges({ ...values(), totalAmount: "9999999999.99", depositAmount: "0.1", currencyCode: "cad" }, draft);
  assert.deepEqual(result.errors, {});
  assert.deepEqual(result.changes, { totalAmount: "9999999999.99", depositAmount: "0.10", currencyCode: "CAD" });
});

test("drafts can remain incomplete and optional values can be cleared explicitly", () => {
  const result = validation.prepareContractDraftChanges({ ...values(), description: " ", totalAmount: "", currencyCode: "", categoryId: "" }, draft);
  assert.deepEqual(result.errors, {});
  assert.deepEqual(result.changes, { description: null, categoryId: null, totalAmount: null, currencyCode: null });
  assert.deepEqual(validation.prepareContractDraftChanges(values(), draft).changes, {});
});

test("invalid amounts and deposits above the total cannot be saved", () => {
  for (const totalAmount of ["-1", "1.001", "1e3", "10000000000", "NaN", "01", "1,000"]) {
    assert.ok(validation.prepareContractDraftChanges({ ...values(), totalAmount }, draft).errors.totalAmount, totalAmount);
  }
  assert.ok(validation.prepareContractDraftChanges({ ...values(), depositAmount: "100.01" }, draft).errors.depositAmount);
  assert.deepEqual(validation.prepareContractDraftChanges({ ...values(), totalAmount: "0", depositAmount: "0" }, draft).errors, {});
});

test("invalid dates, oversized text, malformed currency and unsafe IDs are rejected", () => {
  for (const dueDate of ["2026-02-29", "2026-04-31", "0999-01-01", "2026-11-26T00:00:00Z"]) {
    assert.ok(validation.prepareContractDraftChanges({ ...values(), dueDate }, draft).errors.dueDate);
  }
  assert.deepEqual(validation.prepareContractDraftChanges({ ...values(), dueDate: "2028-02-29" }, draft).errors, {});
  const invalid = validation.prepareContractDraftChanges({ ...values(), description: "x".repeat(256), vendorName: "x".repeat(151), currencyCode: "US", categoryId: "18446744073709551616", vendorId: "1.5" }, draft);
  for (const field of ["description", "vendorName", "currencyCode", "categoryId", "vendorId"]) assert.ok(invalid.errors[field]);
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
