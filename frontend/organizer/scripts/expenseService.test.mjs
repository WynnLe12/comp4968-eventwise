import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function client(responses, authError = false) {
  const calls = [];
  const source = readFileSync(new URL("../src/services/expenseService.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", "fetch", compiled)(name => {
    if (name.endsWith("authService")) return { requireAuthSession: async () => {
      if (authError) throw new Error("internal auth details");
      return { session: { tokens: { accessToken: { toString: () => "test-token" } } } };
    } };
    if (name === "./apiConfig") return { apiUrl: path => "/api" + path };
    throw new Error("Unexpected import " + name);
  }, module, module.exports, async (url, options) => {
    calls.push({ url, ...options });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    assert.ok(next, "Unexpected extra request");
    return next;
  });
  return { service: module.exports.expenseService, calls };
}
const row = overrides => ({
  expenseId: "18446744073709551615", eventId: "10", categoryId: "123",
  categoryName: "Photography", vendorId: "456", description: "Photo balance",
  committedAmount: "12800.10", paidTotal: "5000.01", dueDate: "2026-11-21",
  paymentStatus: "PARTIALLY_PAID", ...overrides,
});
const page = (data, total = data.length, offset = 0) => ({
  ok: true, status: 200, json: async () => ({ data, total, offset, limit: 100 }),
});

test("expense client sends the access token, maps API rows, and preserves string IDs and category associations", async () => {
  const h = client([page([row()])]);
  const [expense] = await h.service.list("10");
  assert.equal(h.calls[0].url, "/api/events/10/expenses?limit=100&offset=0");
  assert.equal(h.calls[0].headers.Authorization, "Bearer test-token");
  assert.equal(h.calls[0].body, undefined);
  assert.deepEqual(expense, {
    id: "18446744073709551615", eventId: "10", categoryId: "123", category: "Photography",
    vendorId: "456", vendor: "Photo balance", total: 12800.1, paid: 5000.01,
    dueDate: "2026-11-21", due: "2026-11-21", status: "Partially paid",
  });
  assert.equal(expense.payments, undefined);
});
test("expense client follows pagination so filtering and totals include every saved expense", async () => {
  const h = client([page([row({ expenseId: "1" })], 2), page([row({ expenseId: "2" })], 2, 1)]);
  assert.equal((await h.service.list("10")).length, 2);
  assert.match(h.calls[1].url, /offset=1$/);
});
test("expense client handles an empty event, no due date, and backend payment statuses", async () => {
  assert.deepEqual(await client([page([])]).service.list("10"), []);
  for (const [paymentStatus, status] of [["UNPAID", "Unpaid"], ["PAID", "Paid"]]) {
    const h = client([page([row({ paymentStatus, dueDate: null, vendorId: null })])]);
    const [expense] = await h.service.list("10");
    assert.equal(expense.status, status);
    assert.equal(expense.due, "No due date");
    assert.equal(expense.vendorId, null);
  }
});
test("expense client fails closed on mixed-event data, invalid money/status, and duplicate IDs", async () => {
  for (const overrides of [{ eventId: "20" }, { committedAmount: "NaN" }, { paidTotal: "13000.00" }, { paymentStatus: "toString" }]) {
    await assert.rejects(client([page([row(overrides)])]).service.list("10"), /couldn't read/);
  }
  await assert.rejects(client([page([row(), row()])]).service.list("10"), /couldn't read/);
});
test("expense client rejects incomplete pagination and malformed responses instead of showing misleading totals", async () => {
  await assert.rejects(client([page([], 2)]).service.list("10"), /couldn't read/);
  await assert.rejects(client([page([row()], 1, 7)]).service.list("10"), /couldn't read/);
  await assert.rejects(client([{ ok: true, json: async () => null }]).service.list("10"), /couldn't read/);
});
test("expense client shows safe authentication, access, deployment, and network errors without leaking responses", async () => {
  for (const [status, message] of [[401, /sign in again/], [403, /access to this event/], [404, /unavailable/], [500, /couldn't load/]]) {
    await assert.rejects(client([{ ok: false, status, json: async () => ({ secret: "internal" }) }]).service.list("10"), message);
  }
  const expired = client([], true);
  await assert.rejects(expired.service.list("10"), /sign in again/);
  assert.equal(expired.calls.length, 0);
  await assert.rejects(client([new Error("internal network details")]).service.list("10"), /couldn't reach/);
});

const createInput = { categoryId: "123", vendorId: "456", description: "Photo balance", committedAmount: "250.01", dueDate: "2026-11-21" };
const created = overrides => ({ ok: true, status: 201, json: async () => ({ data: row({ expenseId: "900", committedAmount: "250.01", paidTotal: "0.00", paymentStatus: "UNPAID", ...overrides }) }) });

test("expense creation POSTs only writable fields and uses the server ID and totals", async () => {
  const h = client([created()]);
  const expense = await h.service.create("10", { ...createInput, id: "temporary", eventId: "other", paidTotal: "999.00" });
  assert.equal(h.calls[0].url, "/api/events/10/expenses");
  assert.equal(h.calls[0].method, "POST");
  assert.equal(h.calls[0].headers.Authorization, "Bearer test-token");
  assert.equal(h.calls[0].headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(h.calls[0].body), createInput);
  assert.equal(expense.id, "900"); assert.equal(expense.paid, 0); assert.equal(expense.total, 250.01);
  await assert.rejects(client([created({ eventId: "20" })]).service.create("10", createInput), /couldn\x27t read/);
});
test("expense creation maps validation fields and hides internal API errors", async () => {
  const h = client([{ ok: false, status: 422, json: async () => ({ error: { fields: { committedAmount: "private maximum details", description: "invalid", categoryId: "wrong event" } } }) }]);
  await assert.rejects(h.service.create("10", createInput), error => {
    assert.equal(error.name, "ExpenseSaveError");
    assert.equal(error.fields.amount, "Enter an amount of 0 or more, with up to 2 decimals.");
    assert.equal(error.fields.name, "Enter an expense name using 1 to 255 characters.");
    assert.equal(error.fields.categoryId, "Choose a category from this event."); return true;
  });
  for (const [status, message] of [[401, /sign in/], [403, /access/], [404, /no longer/], [500, /couldn\x27t save/]]) {
    await assert.rejects(client([{ ok: false, status, json: async () => ({ error: { message: "internal details" } }) }]).service.create("10", createInput), message);
  }
  const expired = client([], true);
  await assert.rejects(expired.service.create("10", createInput), /sign in/);
  assert.equal(expired.calls.length, 0);
  await assert.rejects(client([new Error("internal")]).service.create("10", createInput), /couldn\x27t reach/);
});


test("expense update PATCHes the selected event/expense with writable fields and preserves server payment totals", async () => {
  const h = client([created({ expenseId: "900", paidTotal: "50.00", paymentStatus: "PARTIALLY_PAID" })]);
  const saved = await h.service.update("10", "900", { ...createInput, paidTotal: "0.00", payments: [] });
  assert.equal(h.calls[0].url, "/api/events/10/expenses/900");
  assert.equal(h.calls[0].method, "PATCH");
  assert.deepEqual(JSON.parse(h.calls[0].body), createInput);
  assert.equal(saved.paid, 50);
  assert.equal(saved.status, "Partially paid");
  await assert.rejects(client([created({ expenseId: "901" })]).service.update("10", "900", createInput), /couldn\x27t read/);
});
test("a concurrent payment rejection explains the minimum-total constraint without changing the saved expense", async () => {
  const h = client([{ ok: false, status: 409, json: async () => ({ error: { code: "AMOUNT_BELOW_PAID", message: "internal" } }) }]);
  await assert.rejects(h.service.update("10", "900", createInput), error => {
    assert.match(error.message, /Payments have changed/);
    assert.equal(error.fields.amount, "Total cannot be less than the amount already paid."); return true;
  });
});


test("expense delete sends authenticated DELETE and handles the empty 204 response", async () => {
  const h = client([{ status: 204, json() { throw new Error("204 must not parse JSON"); } }]);
  await h.service.remove("10", "900");
  assert.equal(h.calls[0].url, "/api/events/10/expenses/900");
  assert.equal(h.calls[0].method, "DELETE");
  assert.equal(h.calls[0].headers.Authorization, "Bearer test-token");
  assert.equal(h.calls[0].body, undefined);
});
test("expense deletion preserves payment history and provides safe retry/sign-in messages", async () => {
  await assert.rejects(client([{ status: 409, json: async () => ({ error: { code: "HAS_PAYMENTS", message: "private" } }) }]).service.remove("10", "900"), error => {
    assert.equal(error.code, "HAS_PAYMENTS"); assert.match(error.message, /fully paid or refunded/); return true;
  });
  for (const [status, message] of [[401, /sign in/], [403, /access/], [404, /no longer/], [500, /couldn\x27t delete/], [200, /couldn\x27t delete/]]) {
    await assert.rejects(client([{ status, json: async () => ({ error: { message: "private" } }) }]).service.remove("10", "900"), message);
  }
  const expired = client([], true);
  await assert.rejects(expired.service.remove("10", "900"), /sign in/);
  assert.equal(expired.calls.length, 0);
  await assert.rejects(client([new Error("private")]).service.remove("10", "900"), /couldn\x27t reach/);
});
