import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createAppServer } from "../server";
import { ApiError, invalid } from "../expense-service/errors";
import { ExpenseService, presentExpense } from "../expense-service/services/expenses";
import { parsePaymentBody, parsePaymentQuery } from "../expense-service/services/payment-validation";
import { cents, money, parseExpenseBody, parseExpenseQuery, parseId } from "../expense-service/services/validation";
import type { ExpenseInput, ExpenseQuery, ExpenseRepository, ExpenseRow, ExpenseTransaction, Payment, PaymentInput, PaymentQuery } from "../expense-service/types";
import { createCognitoAuthenticator } from "../shared/auth/cognito";

const input: ExpenseInput = { categoryId: "4001", vendorId: "4001", description: "Venue", committedAmount: "1200.00", dueDate: "2026-11-10" };
function row(overrides: Partial<ExpenseRow> = {}): ExpenseRow {
  return { ...input, expenseId: "4001", eventId: "400", categoryName: "Venue", vendorName: "Vendor", paidTotal: "200.00",
    createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", ...overrides };
}
class MemoryRepository implements ExpenseRepository, ExpenseTransaction {
  rows = new Map<string, ExpenseRow>([["4001", row()], ["4010", row({ expenseId: "4010", eventId: "401" })]]);
  payments: Payment[] = [{ paymentId: "1", expenseId: "4001", amount: "200.00", paidAt: "2026-11-01", paymentType: "DEPOSIT", notes: null, createdAt: "2026-11-01T00:00:00Z" }];
  nextPayment = 9007199254740993n;
  locks = 0;
  async transaction<T>(work: (tx: ExpenseTransaction) => Promise<T>): Promise<T> {
    const snapshot = structuredClone(this.rows);
    const paymentSnapshot = structuredClone(this.payments);
    try { return await work(this); } catch (e) { this.rows = snapshot; this.payments = paymentSnapshot; throw e; }
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
  async listPayments(event: string, id: string, query: PaymentQuery) {
    const all = (await this.find(event, id) ? this.payments.filter(p => p.expenseId === id) : [])
      .sort((a, b) => b.paidAt.localeCompare(a.paidAt) || (BigInt(a.paymentId) > BigInt(b.paymentId) ? -1 : 1));
    return { rows: all.slice(query.offset, query.offset + query.limit), total: all.length };
  }
  async createPayment(event: string, id: string, input: PaymentInput) {
    const expense = await this.find(event, id);
    if (!expense) throw new ApiError(404, "NOT_FOUND", "Not found.");
    const payment: Payment = { ...input, paymentId: String(this.nextPayment++), expenseId: id, createdAt: "2026-11-11T00:00:00Z" };
    this.payments.push(payment);
    this.rows.set(id, { ...expense, paidTotal: money(cents(expense.paidTotal) + cents(input.amount)) });
    return payment;
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

test("payment validation rejects invalid amounts, dates, types, notes and history filters", () => {
  const valid = { amount: "1.00", paidAt: "2026-11-11" };
  assert.deepEqual(parsePaymentBody(valid, "2026-11-11"), { ...valid, paymentType: "PAYMENT", notes: null });
  for (const amount of [0, 1, "0.00", "-1.00", "1.001", "1e2", "10000000000.00"]) {
    assert.throws(() => parsePaymentBody({ ...valid, amount }, "2026-11-11"), hasStatus(422));
  }
  for (const patch of [{ paidAt: "2026-11-12" }, { paidAt: "2026-02-29" }, { paidAt: null }, { paymentType: "REFUND" }, { paymentType: null }, { notes: "x".repeat(256) }, { expenseId: "4010" }]) {
    assert.throws(() => parsePaymentBody({ ...valid, ...patch }, "2026-11-11"), hasStatus(422));
  }
  for (const query of ["paymentType=DEPOSIT", "limit=0", "offset=-1", "limit=2&limit=3"]) {
    assert.throws(() => parsePaymentQuery(new URLSearchParams(query)), hasStatus(422));
  }
});

test("deposit plus payment reaches paid status without increasing committed spending", async () => {
  const { service, repository } = setup();
  const first = await service.recordPayment("400", "4001", "owner", { amount: "300.00", paidAt: "2026-11-11", paymentType: "DEPOSIT" });
  assert.equal(first.expense.paidTotal, "500.00");
  assert.equal(first.expense.paymentStatus, "PARTIALLY_PAID");
  assert.equal(first.payment.paymentId, "9007199254740993");
  const second = await service.recordPayment("400", "4001", "planner", { amount: "700.00", paidAt: "2026-11-11" });
  assert.equal(second.expense.committedAmount, "1200.00");
  assert.equal(second.expense.outstandingAmount, "0.00");
  assert.equal(second.expense.paymentStatus, "PAID");
  assert.equal(second.expense.isOverdue, false);
  assert.equal(repository.locks, 2);
});

test("payment recording preserves exact decimal cents", async () => {
  const { service } = setup();
  const expense = await service.create("400", "owner", { ...input, committedAmount: "0.30" });
  await service.recordPayment("400", expense.expenseId, "owner", { amount: "0.10", paidAt: "2026-11-11" });
  const result = await service.recordPayment("400", expense.expenseId, "owner", { amount: "0.20", paidAt: "2026-11-11" });
  assert.equal(result.expense.paidTotal, "0.30");
  assert.equal(result.expense.outstandingAmount, "0.00");
});

test("overpayment and payments on a zero commitment are rejected without inserting", async () => {
  const { service, repository } = setup();
  await assert.rejects(service.recordPayment("400", "4001", "owner", { amount: "1000.01", paidAt: "2026-11-11" }), e => e instanceof ApiError && e.code === "PAYMENT_EXCEEDS_BALANCE");
  const zero = await service.create("400", "owner", { ...input, committedAmount: "0.00" });
  await assert.rejects(service.recordPayment("400", zero.expenseId, "owner", { amount: "0.01", paidAt: "2026-11-11" }), hasStatus(409));
  assert.equal(repository.payments.length, 1);
  assert.equal((await service.get("400", "4001", "owner")).paidTotal, "200.00");
});

test("payment history includes refunds and uses date then numeric ID ordering with pagination", async () => {
  const { service, repository } = setup();
  repository.payments.push({ paymentId: "2", expenseId: "4001", amount: "20.00", paidAt: "2026-11-02", paymentType: "REFUND", notes: null, createdAt: "2026-11-02T00:00:00Z" });
  repository.rows.set("4001", row({ paidTotal: "180.00" }));
  await service.recordPayment("400", "4001", "owner", { amount: "1.00", paidAt: "2026-11-02" });
  const history = await service.listPayments("400", "4001", "planner", { limit: 1, offset: 1 });
  assert.equal(history.total, 3);
  assert.equal(history.data[0]?.paymentType, "REFUND");
  assert.equal(history.data[0]?.amount, "20.00");
  assert.equal((await service.listPayments("400", "4001", "owner", { limit: 1, offset: 99 })).total, 3);
  assert.equal((await service.get("400", "4001", "owner")).paidTotal, "181.00");
});

test("payment routes enforce event membership and nested expense ownership", async () => {
  const { service } = setup();
  const body = { amount: "1.00", paidAt: "2026-11-11" };
  await assert.rejects(service.recordPayment("400", "4001", "outsider", body), hasStatus(403));
  await assert.rejects(service.listPayments("400", "4001", "outsider", { limit: 50, offset: 0 }), hasStatus(403));
  await assert.rejects(service.recordPayment("400", "4010", "owner", body), hasStatus(404));
  await assert.rejects(service.listPayments("400", "4010", "owner", { limit: 50, offset: 0 }), hasStatus(404));
});

test("failed payment transaction rolls back inserted payment and changed totals", async () => {
  const { service, repository } = setup();
  const original = repository.createPayment.bind(repository);
  repository.createPayment = async (...args) => { await original(...args); throw new Error("Simulated write failure"); };
  await assert.rejects(service.recordPayment("400", "4001", "owner", { amount: "10.00", paidAt: "2026-11-11" }));
  assert.equal(repository.payments.length, 1);
  assert.equal(repository.rows.get("4001")?.paidTotal, "200.00");
});

test("payment HTTP endpoints return 201/200 and reject invalid requests and unsupported methods", async t => {
  const { service } = setup();
  const server = createAppServer({ expenses: service, authenticate: async value => {
    if (value !== "Bearer test-token") throw new ApiError(401, "UNAUTHENTICATED", "Missing test token.");
    return "owner";
  } });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/events/400/expenses/4001/payments`;
  const headers = { Authorization: "Bearer test-token", "Content-Type": "application/json" };
  const body = JSON.stringify({ amount: "1000.00", paidAt: "2026-11-11" });
  assert.equal((await fetch(base)).status, 401);
  const created = await fetch(base, { method: "POST", headers, body });
  assert.equal(created.status, 201);
  const result = await created.json() as { data: { expense: { paymentStatus: string }; payment: { amount: string } } };
  assert.equal(result.data.expense.paymentStatus, "PAID"); assert.equal(result.data.payment.amount, "1000.00");
  assert.equal((await fetch(base, { method: "POST", headers, body })).status, 409);
  const history = await fetch(`${base}?limit=1`, { headers });
  const list = await history.json() as { data: unknown[]; total: number };
  assert.equal(history.status, 200); assert.equal(list.data.length, 1); assert.equal(list.total, 2);
  const method = await fetch(base, { method: "DELETE", headers });
  assert.equal(method.status, 405); assert.equal(method.headers.get("allow"), "GET, POST");
  assert.equal((await fetch(`${base}?categoryId=4001`, { headers })).status, 422);
  assert.equal((await fetch(`${base}?limit=1`, { method: "POST", headers, body })).status, 422);
  assert.equal((await fetch(base.replace("4001/payments", "4010/payments"), { headers })).status, 404);
});
