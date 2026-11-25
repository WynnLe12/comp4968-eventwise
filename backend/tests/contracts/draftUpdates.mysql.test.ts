import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { ApiError } from "../../expense-service/errors";
import { MySqlDraftReader } from "../../contract-service/repositories/draftReader";
import { MySqlDraftUpdater } from "../../contract-service/repositories/draftUpdater";
import { getDatabasePool, closeDatabasePool } from "../../shared/db/pool";

const integration = { skip: process.env.EVENTWISE_MYSQL_TEST !== "1" };
const updater = new MySqlDraftUpdater(), reader = new MySqlDraftReader();
after(closeDatabasePool);
const status = (expected: number) => (error: unknown) => error instanceof ApiError && error.status === expected;
async function insert(sql: string, values: (string | number | null)[] = []) {
  const [result] = await getDatabasePool().execute<ResultSetHeader>(sql, values); return String(result.insertId);
}
async function fixture(run: (f: { a: string; b: string; owner: string; planner: string; draft: string; otherDraft: string;
  category: string; otherCategory: string; vendor: string; secondVendor: string; otherVendor: string; expense: string; otherExpense: string }) => Promise<void>) {
  const ids: string[] = [], owner = "owner-" + randomUUID(), planner = "planner-" + randomUUID();
  try {
    for (const name of ["A", "B"]) ids.push(await insert("INSERT INTO events (name) VALUES (?)", ["F15 edit " + name]));
    const [a, b] = ids;
    await insert("INSERT INTO event_members (event_id, cognito_sub, role) VALUES (?, ?, 'OWNER'), (?, ?, 'CO_PLANNER'), (?, ?, 'OWNER')", [a, owner, a, planner, b, owner]);
    const categories: string[] = [], vendors: string[] = [], expenses: string[] = [], drafts: string[] = [];
    for (const id of ids) {
      categories.push(await insert("INSERT INTO budget_categories (event_id, name) VALUES (?, 'Venue')", [id]));
      vendors.push(await insert("INSERT INTO vendors (event_id, name) VALUES (?, 'Vendor')", [id]));
      expenses.push(await insert("INSERT INTO expenses (event_id, category_id, vendor_id, description, committed_amount) VALUES (?, ?, ?, 'Original expense', '500.00')", [id, categories.at(-1)!, vendors.at(-1)!]));
      drafts.push(await insert("INSERT INTO draft_budget_items (event_id, description, total_amount, deposit_amount) VALUES (?, 'Original draft', '500.00', '100.00')", [id]));
    }
    await insert("INSERT INTO expense_payments (expense_id, amount, paid_at) VALUES (?, '100.00', '2026-11-20')", [expenses[0]]);
    const secondVendor = await insert("INSERT INTO vendors (event_id, name) VALUES (?, 'Second vendor')", [a]);
    await run({ a, b, owner, planner, draft: drafts[0], otherDraft: drafts[1], category: categories[0], otherCategory: categories[1],
      vendor: vendors[0], secondVendor, otherVendor: vendors[1], expense: expenses[0], otherExpense: expenses[1] });
  } finally {
    for (const id of ids) {
      await getDatabasePool().execute("DELETE FROM draft_budget_items WHERE event_id = ?", [id]);
      await getDatabasePool().execute("DELETE p FROM expense_payments p JOIN expenses e ON e.expense_id = p.expense_id WHERE e.event_id = ?", [id]);
      await getDatabasePool().execute("DELETE FROM expenses WHERE event_id = ?", [id]);
      await getDatabasePool().execute("DELETE FROM events WHERE event_id = ?", [id]);
    }
  }
}
async function financialRecords() {
  return Promise.all(["vendors", "expenses", "expense_payments"].map(async table =>
    (await getDatabasePool().query<RowDataPacket[]>("SELECT * FROM " + table))[0].map(row => ({ ...row }))));
}

test("MySQL draft edits persist reviewed fields and audit/version values without changing financial records", integration, async () => {
  await fixture(async f => {
    const before = await financialRecords();
    const result = await updater.update(f.a, f.draft, f.planner, { version: "1", description: "  Reviewed contract  ",
      categoryId: f.category, vendorId: f.vendor, saveAction: "UPDATE_EXPENSE", targetExpenseId: f.expense,
      totalAmount: "600.10", depositAmount: "150.00", currencyCode: "CAD", dueDate: "2027-01-15" });
    assert.equal(result.description, "Reviewed contract"); assert.equal(result.version, "2");
    assert.equal(result.totalAmount, "600.10"); assert.equal(result.depositAmount, "150.00");
    assert.equal(result.vendorId, f.vendor); assert.equal(result.targetExpenseId, f.expense);
    assert.equal(result.status, "DRAFT"); assert.equal(result.confirmedExpenseId, null);
    assert.deepEqual(await reader.get(f.a, f.draft, f.owner), result);
    const [[audit]] = await getDatabasePool().execute<RowDataPacket[]>("SELECT updated_by_sub FROM draft_budget_items WHERE draft_id = ?", [f.draft]);
    assert.equal(audit.updated_by_sub, f.planner);
    assert.deepEqual(await financialRecords(), before);
  });
});

test("MySQL draft edits reject stale/concurrent saves and preserve exact large versions", integration, async () => {
  await fixture(async f => {
    const results = await Promise.allSettled([
      updater.update(f.a, f.draft, f.owner, { version: "1", description: "Owner edit" }),
      updater.update(f.a, f.draft, f.planner, { version: "1", description: "Planner edit" }),
    ]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    const failure = results.find(result => result.status === "rejected");
    assert.ok(failure?.status === "rejected" && failure.reason instanceof ApiError);
    assert.equal(failure.reason.code, "DRAFT_CHANGED");
    assert.equal((await reader.get(f.a, f.draft, f.owner))?.version, "2");
    await getDatabasePool().execute("UPDATE draft_budget_items SET version = ? WHERE draft_id = ?", ["9007199254740993", f.draft]);
    const saved = await updater.update(f.a, f.draft, f.owner, { version: "9007199254740993", description: "Exact version" });
    assert.equal(saved.version, "9007199254740994");
    await getDatabasePool().execute("UPDATE draft_budget_items SET version = ? WHERE draft_id = ?", ["18446744073709551615", f.draft]);
    await assert.rejects(updater.update(f.a, f.draft, f.owner, { version: "18446744073709551615", description: "Overflow" }), status(409));
  });
});

test("MySQL draft edits validate merged amounts, same-event associations and immutable fields atomically", integration, async () => {
  await fixture(async f => {
    for (const changes of [
      { categoryId: f.otherCategory }, { vendorId: f.otherVendor },
      { saveAction: "UPDATE_EXPENSE", targetExpenseId: f.otherExpense },
      { saveAction: "UPDATE_EXPENSE", targetExpenseId: f.expense, vendorId: f.secondVendor },
      { targetExpenseId: f.expense }, { totalAmount: "99.00" }, { depositAmount: "500.01" },
      { categoryId: "999999" }, { status: "CONFIRMED" }, { documentId: "23" }, { contentSha256: "a".repeat(64) },
    ]) await assert.rejects(updater.update(f.a, f.draft, f.owner, { version: "1", ...changes }), status(422));
    const unchanged = await reader.get(f.a, f.draft, f.owner);
    assert.equal(unchanged?.description, "Original draft"); assert.equal(unchanged?.version, "1");
    assert.equal(unchanged?.totalAmount, "500.00"); assert.equal(unchanged?.vendorId, null);
  });
});

test("MySQL draft edits enforce membership, cross-event IDs, revocation and terminal draft status", integration, async () => {
  await fixture(async f => {
    const body = { version: "1", description: "Changed" };
    for (const sub of ["outsider", f.owner.toUpperCase()]) await assert.rejects(updater.update(f.a, f.draft, sub, body), status(403));
    await assert.rejects(updater.update(f.a, f.otherDraft, f.owner, body), status(404));
    await getDatabasePool().execute("DELETE FROM event_members WHERE event_id = ? AND cognito_sub = ?", [f.a, f.planner]);
    await assert.rejects(updater.update(f.a, f.draft, f.planner, body), status(403));
    for (const state of ["CONFIRMED", "REJECTED"]) {
      await getDatabasePool().execute("UPDATE draft_budget_items SET status = ? WHERE draft_id = ?", [state, f.draft]);
      await assert.rejects(updater.update(f.a, f.draft, f.owner, body), error => error instanceof ApiError && error.code === "DRAFT_NOT_EDITABLE");
    }
    assert.equal((await reader.get(f.a, f.draft, f.owner))?.description, "Original draft");
  });
});

test("MySQL draft edits support incomplete drafts and clear the old target when switching to a new expense", integration, async () => {
  await fixture(async f => {
    await updater.update(f.a, f.draft, f.owner, { version: "1", saveAction: "UPDATE_EXPENSE", targetExpenseId: f.expense, vendorId: f.vendor });
    const saved = await updater.update(f.a, f.draft, f.owner, { version: "2", saveAction: "CREATE_EXPENSE",
      vendorId: null, categoryId: null, description: " ", vendorName: null, totalAmount: null, depositAmount: null });
    assert.equal(saved.version, "3"); assert.equal(saved.targetExpenseId, null);
    assert.equal(saved.description, null); assert.equal(saved.totalAmount, null); assert.equal(saved.vendorId, null);
  });
});

test("MySQL draft edit failures after writing roll back values, version and audit identity", integration, async () => {
  await fixture(async f => {
    let reads = 0;
    const connect = async () => {
      const connection = await getDatabasePool().getConnection();
      return new Proxy(connection, { get(target, property) {
        if (property === "execute") return async (sql: string, values?: unknown[]) => {
          if (sql.includes("LEFT JOIN event_documents") && ++reads === 2) throw new Error("Injected readback failure");
          return Reflect.apply(target.execute, target, [sql, values]);
        };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    };
    await assert.rejects(new MySqlDraftUpdater(connect).update(f.a, f.draft, f.owner, { version: "1", description: "Should roll back" }), /Injected readback failure/);
    const result = await reader.get(f.a, f.draft, f.owner);
    assert.equal(result?.description, "Original draft"); assert.equal(result?.version, "1");
    const [[audit]] = await getDatabasePool().execute<RowDataPacket[]>("SELECT updated_by_sub FROM draft_budget_items WHERE draft_id = ?", [f.draft]);
    assert.equal(audit.updated_by_sub, null);
  });
});
