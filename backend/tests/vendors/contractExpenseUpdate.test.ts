import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolConnection } from "mysql2/promise";
import { createContractExpenseUpdater } from "../../vendor-service/services/contractExpenseUpdate";
import { ApiError } from "../../expense-service/errors";

const input = () => ({ expenseId: "30", expectedContractTotal: "200.00", expectedExpenseTotal: "200.00",
  vendorChanges: { contractTotal: "250.00", name: "Updated vendor" } });
function fixture(options: { member?: boolean; expenseVendor?: string; linked?: string[]; paid?: string; failExpense?: boolean; failCommit?: boolean } = {}) {
  let stored = {
    vendor: { vendor_id: "20", event_id: "10", name: "Vendor", category: null, contact_name: null, email: null, phone: null,
      quote_amount: "100.00", contract_total: "200.00", booking_status: "BOOKED", contract_status: "SIGNED", notes: "Keep",
      paid_total: options.paid ?? "50.00", balance: "150.00", next_due_date: "2026-12-01",
      created_at: "2026-11-01 00:00:00", updated_at: "2026-11-01 00:00:00" },
    expense: { expense_id: "30", vendor_id: options.expenseVendor ?? "20", committed_amount: "200.00",
      category_id: "40", description: "Keep expense name", due_date: "2026-12-01" },
    payments: [{ amount: options.paid ?? "50.00", payment_type: "PAYMENT" }],
  };
  let pending = structuredClone(stored);
  const sql: string[] = [];
  let commits = 0, rollbacks = 0, releases = 0;
  const connection = {
    async beginTransaction() { pending = structuredClone(stored); },
    async execute(query: string, values: unknown[]) {
      sql.push(query);
      const rows = (data: unknown) => [data, []];
      if (query.includes("FROM event_members")) return rows(options.member === false ? [] : [{}]);
      if (query.startsWith("SELECT expense_id, vendor_id")) return rows(values[1] === "10" && values[0] === "30" ? [pending.expense] : []);
      if (query.startsWith("SELECT vendor_id FROM vendors")) return rows(values[0] === "20" && values[1] === "10" ? [{}] : []);
      if (query.includes("FROM vendors v")) return rows([{ ...pending.vendor,
        balance: (Number(pending.vendor.contract_total) - Number(pending.vendor.paid_total)).toFixed(2) }]);
      if (query.startsWith("SELECT expense_id FROM expenses")) return rows((options.linked ?? ["30"]).map(expense_id => ({ expense_id })));
      if (query.includes("AS paid FROM expense_payments")) return rows([{ paid: options.paid ?? "50.00" }]);
      if (query.startsWith("UPDATE vendors")) {
        pending.vendor.name = String(values[0]); pending.vendor.contract_total = String(values[6]); return rows({ affectedRows: 1 });
      }
      if (query.startsWith("UPDATE expenses")) {
        if (options.failExpense) throw new Error("simulated SQL failure");
        assert.deepEqual(values.slice(1), ["30", "10", "20"]);
        pending.expense.committed_amount = String(values[0]); return rows({ affectedRows: 1 });
      }
      throw new Error("Unexpected SQL: " + query);
    },
    async commit() { if (options.failCommit) throw new Error("simulated commit failure"); commits++; stored = structuredClone(pending); },
    async rollback() { rollbacks++; pending = structuredClone(stored); },
    release() { releases++; },
  } as unknown as PoolConnection;
  return { run: createContractExpenseUpdater(async () => connection), sql, stored: () => stored,
    counts: () => ({ commits, rollbacks, releases }) };
}
test("Update both commits vendor and one expense together, preserving history, category and due date", async () => {
  const h = fixture(), before = structuredClone(h.stored());
  const result = await h.run("10", "20", "owner", input());
  assert.equal(result.contractTotal, "250.00"); assert.equal(result.balance, "200.00");
  assert.equal(h.stored().vendor.name, "Updated vendor");
  assert.equal(h.stored().expense.committed_amount, "250.00");
  assert.deepEqual(h.stored().payments, before.payments);
  assert.equal(h.stored().expense.due_date, before.expense.due_date);
  assert.equal(h.stored().expense.description, before.expense.description);
  assert.equal(h.stored().expense.category_id, before.expense.category_id);
  assert.deepEqual(h.counts(), { commits: 1, rollbacks: 0, releases: 1 });
  assert.ok(h.sql.findIndex(sql => sql.includes("FROM expenses WHERE expense_id") && sql.includes("FOR UPDATE")) <
    h.sql.findIndex(sql => sql.includes("AS paid FROM expense_payments")));
});
test("failure after the vendor write or at commit rolls back both records", async () => {
  for (const options of [{ failExpense: true }, { failCommit: true }]) {
    const h = fixture(options), before = structuredClone(h.stored());
    await assert.rejects(h.run("10", "20", "owner", input()), /simulated/);
    assert.deepEqual(h.stored(), before);
    assert.deepEqual(h.counts(), { commits: 0, rollbacks: 1, releases: 1 });
  }
});
test("Update both rejects unauthorized membership and cross-event/vendor associations before any write", async () => {
  for (const [options, status] of [[{ member: false }, 403], [{ expenseVendor: "21" }, 404]] as const) {
    const h = fixture(options);
    await assert.rejects(h.run("10", "20", "owner", input()), (error: unknown) => error instanceof ApiError && error.status === status);
    assert.ok(!h.sql.some(sql => sql.startsWith("UPDATE")));
    assert.equal(h.counts().rollbacks, 1);
  }
  const h = fixture();
  await assert.rejects(h.run("11", "20", "owner", input()), (error: unknown) => error instanceof ApiError && error.status === 404);
});
test("changed contract/expense totals and multiple linked expenses require a new confirmation without writes", async () => {
  for (const changes of [{ expectedContractTotal: "199.00" }, { expectedExpenseTotal: "199.00" }]) {
    const h = fixture();
    await assert.rejects(h.run("10", "20", "owner", { ...input(), ...changes }), (error: unknown) => error instanceof ApiError && error.code === "CONTRACT_EXPENSE_CHANGED");
    assert.ok(!h.sql.some(sql => sql.startsWith("UPDATE")));
  }
  const h = fixture({ linked: ["30", "31"] });
  await assert.rejects(h.run("10", "20", "owner", input()), (error: unknown) => error instanceof ApiError && error.code === "CONTRACT_EXPENSE_CHANGED");
});
test("the latest paid total prevents reducing either commitment below payments, with exact cents", async () => {
  const h = fixture({ paid: "150.01" });
  await assert.rejects(h.run("10", "20", "owner", { ...input(), vendorChanges: { contractTotal: "150.00" } }),
    (error: unknown) => error instanceof ApiError && error.code === "AMOUNT_BELOW_PAID");
  assert.ok(!h.sql.some(sql => sql.startsWith("UPDATE")));
  const success = fixture({ paid: "150.01" });
  await success.run("10", "20", "owner", { ...input(), vendorChanges: { contractTotal: "150.01" } });
  assert.equal(success.stored().expense.committed_amount, "150.01");
});
test("invalid vendor changes roll back before writes and malformed sync requests never start a transaction", async () => {
  const h = fixture();
  await assert.rejects(h.run("10", "20", "owner", { ...input(), vendorChanges: { contractTotal: "-1.00" } }),
    (error: unknown) => error instanceof ApiError && error.status === 422);
  assert.ok(!h.sql.some(sql => sql.startsWith("UPDATE")));
  for (const body of [{ ...input(), expenseId: "0" }, { ...input(), unexpected: "field" }, { ...input(), vendorChanges: { contractTotal: null } }]) {
    const invalid = fixture();
    await assert.rejects(invalid.run("10", "20", "owner", body), (error: unknown) => error instanceof ApiError && error.status === 422);
    assert.deepEqual(invalid.counts(), { commits: 0, rollbacks: 0, releases: 0 });
  }
});
