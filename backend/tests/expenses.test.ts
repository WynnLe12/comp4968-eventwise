import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createAppServer } from "../server";
import { ApiError, invalid } from "../expense-service/errors";
import { ExpenseService, presentExpense } from "../expense-service/services/expenses";
import { parseExpenseBody, parseExpenseQuery, parseId } from "../expense-service/services/validation";
import type { ExpenseInput, ExpenseQuery, ExpenseRepository, ExpenseRow, ExpenseTransaction } from "../expense-service/types";
import { createCognitoAuthenticator } from "../shared/auth/cognito";

const input: ExpenseInput = { categoryId: "4001", vendorId: "4001", description: "Venue", committedAmount: "1200.00", dueDate: "2026-11-10" };
function row(overrides: Partial<ExpenseRow> = {}): ExpenseRow {
  return { ...input, expenseId: "4001", eventId: "400", categoryName: "Venue", vendorName: "Vendor", paidTotal: "200.00",
    createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", ...overrides };
}
class MemoryRepository implements ExpenseRepository, ExpenseTransaction {
  rows = new Map<string, ExpenseRow>([["4001", row()], ["4010", row({ expenseId: "4010", eventId: "401" })]]);
  locks = 0;
  async transaction<T>(work: (tx: ExpenseTransaction) => Promise<T>): Promise<T> {
    const snapshot = structuredClone(this.rows);
    try { return await work(this); } catch (e) { this.rows = snapshot; throw e; }
  }
  async assertMember(event: string, sub: string) {
    if (!(event === "400" && ["owner", "planner"].includes(sub))) throw new ApiError(403, "FORBIDDEN", "No access.");
  }
  async validateAssociations(event: string, data: ExpenseInput) {
    if (event !== "400" || data.categoryId !== "4001") invalid("categoryId", "Wrong event.");
    if (data.vendorId !== null && data.vendorId !== "4001") invalid("vendorId", "Wrong event.");
  }
  async find(event: string, id: string, lock = false) {
    if (lock) this.locks++;
    const found = this.rows.get(id);
    return found?.eventId === event ? structuredClone(found) : null;
  }
  async list(event: string, query: ExpenseQuery) {
    const all = [...this.rows.values()].filter(r => r.eventId === event);
    return { rows: all.slice(query.offset, query.offset + query.limit), total: all.length };
  }
  async create(event: string, data: ExpenseInput) {
    const id = "9007199254740993";
    this.rows.set(id, row({ ...data, expenseId: id, eventId: event, paidTotal: "0.00" }));
    return id;
  }
  async update(event: string, id: string, data: ExpenseInput) {
    const old = await this.find(event, id);
    if (old) this.rows.set(id, { ...old, ...data });
  }
  async remove(event: string, id: string) { if (await this.find(event, id)) this.rows.delete(id); }
}
function setup() {
  const repository = new MemoryRepository();
  return { repository, service: new ExpenseService(repository, () => "2026-11-11") };
}
function hasStatus(status: number) { return (error: unknown) => error instanceof ApiError && error.status === status; }

test("money inputs and IDs keep exact precision and reject malformed values", () => {
  assert.equal(parseId("18446744073709551615", "id"), "18446744073709551615");
  for (const value of ["0", "01", "18446744073709551616", "1e3", 1]) assert.throws(() => parseId(value, "id"));
  for (const value of [1, "-1.00", "1.001", "1e3", "10000000000.00", "NaN"]) {
    assert.throws(() => parseExpenseBody({ ...input, committedAmount: value }, false), hasStatus(422));
  }
  assert.equal(parseExpenseBody({ ...input, committedAmount: "0.30" }, false).committedAmount, "0.30");
});

test("PATCH rejects unknown fields, null required fields and impossible dates", () => {
  for (const body of [{}, { paidTotal: "1.00" }, { eventId: "401" }, { categoryId: null }, { description: " " }, { dueDate: "2026-02-29" }]) {
    assert.throws(() => parseExpenseBody(body, true), hasStatus(422));
  }
  assert.equal(parseExpenseBody({ dueDate: "2028-02-29", vendorId: null }, true).dueDate, "2028-02-29");
});

test("query validation rejects repeated keys, unsafe offsets and invalid filters", () => {
  for (const query of ["limit=0", "limit=101", "offset=-1", "offset=9007199254740992", "q=a&q=b", "overdue=yes", "sort=x", "paymentStatus=Deposit"]) {
    assert.throws(() => parseExpenseQuery(new URLSearchParams(query)), hasStatus(422));
  }
  assert.deepEqual(parseExpenseQuery(new URLSearchParams("overdue=false&limit=5&q=%25")), { limit: 5, offset: 0, overdue: false, q: "%" });
});

test("derived financial status handles cents, due today, refunds and zero commitments", () => {
  assert.equal(presentExpense(row(), "2026-11-11").outstandingAmount, "1000.00");
  assert.equal(presentExpense(row(), "2026-11-11").isOverdue, true);
  assert.equal(presentExpense(row({ dueDate: "2026-11-11" }), "2026-11-11").isOverdue, false);
  assert.equal(presentExpense(row({ dueDate: null }), "2026-11-11").isOverdue, false);
  assert.equal(presentExpense(row({ committedAmount: "0.30", paidTotal: "0.10" }), "2026-11-11").outstandingAmount, "0.20");
  assert.equal(presentExpense(row({ committedAmount: "500.00", paidTotal: "80.00" }), "2026-11-11").outstandingAmount, "420.00");
  assert.equal(presentExpense(row({ committedAmount: "0.00", paidTotal: "0.00" }), "2026-11-11").paymentStatus, "PAID");
  assert.throws(() => presentExpense(row({ paidTotal: "1200.01" }), "2026-11-11"), hasStatus(500));
});

test("owner and co-planner can create/get/update/delete, preserving ID strings", async () => {
  const { service, repository } = setup();
  const created = await service.create("400", "owner", { ...input, vendorId: null });
  assert.equal(created.expenseId, "9007199254740993");
  assert.equal(created.paymentStatus, "UNPAID");
  assert.equal((await service.get("400", created.expenseId, "planner")).description, "Venue");
  const updated = await service.update("400", created.expenseId, "planner", { description: "Updated", dueDate: null });
  assert.equal(updated.description, "Updated");
  assert.equal(updated.dueDate, null);
  await service.remove("400", created.expenseId, "owner");
  await assert.rejects(service.get("400", created.expenseId, "owner"), hasStatus(404));
  assert.equal(repository.locks, 2);
});

test("all CRUD operations enforce membership; nested cross-event IDs return 404", async () => {
  const { service } = setup();
  for (const action of [
    () => service.list("400", "outsider", { limit: 50, offset: 0 }),
    () => service.get("400", "4001", "outsider"),
    () => service.create("400", "outsider", input),
    () => service.update("400", "4001", "outsider", { description: "No" }),
    () => service.remove("400", "4001", "outsider"),
  ]) await assert.rejects(action, hasStatus(403));
  await assert.rejects(service.get("400", "4010", "owner"), hasStatus(404));
  await assert.rejects(service.update("400", "4010", "owner", { description: "No" }), hasStatus(404));
  await assert.rejects(service.remove("400", "4010", "owner"), hasStatus(404));
});

test("invalid category/vendor references and reductions below net paid do not persist", async () => {
  const { service, repository } = setup();
  await assert.rejects(service.create("400", "owner", { ...input, categoryId: "4010" }), hasStatus(422));
  await assert.rejects(service.create("400", "owner", { ...input, vendorId: "4010" }), hasStatus(422));
  await assert.rejects(service.update("400", "4001", "owner", { committedAmount: "199.99" }), hasStatus(409));
  await assert.rejects(service.update("400", "4001", "owner", { vendorId: "4010" }), hasStatus(422));
  assert.equal(repository.rows.get("4001")?.committedAmount, "1200.00");
  assert.equal(repository.rows.size, 2);
});

test("Cognito boundary rejects absent tokens and fails closed without configuration", async () => {
  const auth = createCognitoAuthenticator({});
  await assert.rejects(auth(undefined), hasStatus(401));
  await assert.rejects(auth("Basic user"), hasStatus(401));
  await assert.rejects(auth("Bearer not-a-real-token"), hasStatus(503));
  const configured = createCognitoAuthenticator({ COGNITO_USER_POOL_ID: "us-west-2_example", COGNITO_CLIENT_ID: "example" });
  await assert.rejects(configured("Bearer not-a-real-token"), hasStatus(401));
});

test("HTTP routes return JSON status codes, body limits, pagination and no-content deletes", async t => {
  const { service } = setup();
  const server = createAppServer({ expenses: service, authenticate: async value => {
    if (value !== "Bearer test-token") throw new ApiError(401, "UNAUTHENTICATED", "Missing test token.");
    return "owner";
  } });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { Authorization: "Bearer test-token", "Content-Type": "application/json" };
  assert.equal((await fetch(`${base}/events/400/expenses`)).status, 401);
  const denied = await fetch(`${base}/events/400/expenses`, { method: "PUT", headers });
  assert.equal(denied.status, 405); assert.equal(denied.headers.get("allow"), "GET, POST");
  assert.equal((await fetch(`${base}/events/400/expenses?limit=0`, { headers })).status, 422);
  assert.equal((await fetch(`${base}/events/400/expenses/summary`, { headers })).status, 404);
  assert.equal((await fetch(`${base}/events/400/expenses`, { method: "POST", headers, body: "{" })).status, 400);
  assert.equal((await fetch(`${base}/events/400/expenses`, { method: "POST", headers: { Authorization: headers.Authorization }, body: "{}" })).status, 415);
  assert.equal((await fetch(`${base}/events/400/expenses`, { method: "POST", headers, body: JSON.stringify({ text: "a".repeat(17000) }) })).status, 413);
  const created = await fetch(`${base}/events/400/expenses`, { method: "POST", headers, body: JSON.stringify(input) });
  assert.equal(created.status, 201);
  const location = created.headers.get("location")!;
  const listed = await fetch(`${base}/events/400/expenses?limit=1`, { headers });
  const list = await listed.json() as { data: unknown[]; total: number; limit: number };
  assert.equal(list.data.length, 1); assert.equal(list.total, 2); assert.equal(list.limit, 1);
  assert.equal((await fetch(`${base}${location}`, { headers })).status, 200);
  assert.equal((await fetch(`${base}${location}`, { method: "PATCH", headers, body: JSON.stringify({ description: "Edited" }) })).status, 200);
  const deleted = await fetch(`${base}${location}`, { method: "DELETE", headers });
  assert.equal(deleted.status, 204); assert.equal(await deleted.text(), "");
  assert.equal((await fetch(`${base}${location}`, { method: "DELETE", headers })).status, 404);
});
