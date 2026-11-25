import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import type { RowDataPacket } from "mysql2/promise";
import { ApiError } from "../../expense-service/errors";
import { cents } from "../../expense-service/services/validation";
import { ExpenseService } from "../../expense-service/services/expenses";
import { MySqlExpenseRepository } from "../../expense-service/repositories/mysql-expenses";
import { MySqlDraftConfirmer } from "../../contract-service/repositories/draftConfirmer";
import { MySqlDraftCreator } from "../../contract-service/repositories/draftCreator";
import { MySqlDraftUpdater } from "../../contract-service/repositories/draftUpdater";
import { MySqlDraftDiscarder } from "../../contract-service/repositories/draftDiscarder";
import { MySqlDraftReader } from "../../contract-service/repositories/draftReader";
import { getDatabasePool, closeDatabasePool } from "../../shared/db/pool";

const integration = { skip: process.env.EVENTWISE_MYSQL_TEST !== "1" };
const confirmer = new MySqlDraftConfirmer(), reader = new MySqlDraftReader();
const updater = new MySqlDraftUpdater(), discarder = new MySqlDraftDiscarder();
const expenses = new ExpenseService(new MySqlExpenseRepository());
const status = (expected: number) => (error: unknown) => error instanceof ApiError && error.status === expected;
after(closeDatabasePool);
async function insert(sql: string, values: (string | number | null)[] = []) {
  const connection = await getDatabasePool().getConnection();
  try {
    await connection.execute(sql, values);
    const [[row]] = await connection.query<RowDataPacket[]>("SELECT CAST(LAST_INSERT_ID() AS CHAR) AS id");
    return String(row.id);
  } finally { connection.release(); }
}
interface Fixture { a: string; b: string; owner: string; planner: string; draft: string; document: string;
  category: string; otherCategory: string; vendor: string; otherVendor: string; expense: string; }
async function fixture(run: (f: Fixture) => Promise<void>) {
  const ids: string[] = [], owner = "owner-" + randomUUID(), planner = "planner-" + randomUUID();
  try {
    for (const name of ["A", "B"]) ids.push(await insert("INSERT INTO events (name) VALUES (?)", ["F15 confirm " + name]));
    const [a, b] = ids;
    await insert("INSERT INTO event_members (event_id, cognito_sub, role) VALUES (?, ?, 'OWNER'), (?, ?, 'CO_PLANNER'), (?, ?, 'OWNER')", [a, owner, a, planner, b, owner]);
    const document = await insert("INSERT INTO event_documents (event_id, uploaded_by_sub, s3_object_key, original_filename, content_type, size_bytes, content_sha256) VALUES (?, ?, ?, 'contract.pdf', 'application/pdf', 100, ?)",
      [a, owner, "events/" + a + "/documents/" + randomUUID(), "a".repeat(64)]);
    const category = await insert("INSERT INTO budget_categories (event_id, name) VALUES (?, 'Entertainment')", [a]);
    const otherCategory = await insert("INSERT INTO budget_categories (event_id, name) VALUES (?, 'Other event')", [b]);
    const vendor = await insert("INSERT INTO vendors (event_id, name) VALUES (?, 'Reviewed DJ')", [a]);
    const otherVendor = await insert("INSERT INTO vendors (event_id, name) VALUES (?, 'Other DJ')", [b]);
    const expense = await insert("INSERT INTO expenses (event_id, category_id, vendor_id, description, committed_amount) VALUES (?, ?, ?, 'Existing expense', '500.00')", [a, category, vendor]);
    await insert("INSERT INTO expense_payments (expense_id, amount, paid_at) VALUES (?, '100.00', '2026-11-20')", [expense]);
    const draft = await insert("INSERT INTO draft_budget_items (event_id, document_id, content_sha256, description, category_id, vendor_id, vendor_name, total_amount, deposit_amount, due_date, currency_code) VALUES (?, ?, ?, 'DJ contract', ?, ?, 'Extracted DJ', '600.10', '100.05', '2026-12-20', 'USD')",
      [a, document, "a".repeat(64), category, vendor]);
    for (const state of ["SUCCEEDED", "QUEUED"]) await insert("INSERT INTO contract_extraction_jobs (request_id, event_id, draft_id, draft_version, requested_by_sub, status) VALUES (?, ?, ?, 1, ?, ?)",
      [randomUUID(), a, draft, owner, state]);
    await run({ a, b, owner, planner, draft, document, category, otherCategory, vendor, otherVendor, expense });
  } finally {
    for (const id of ids) {
      await getDatabasePool().execute("DELETE FROM draft_budget_items WHERE event_id = ?", [id]);
      await getDatabasePool().execute("DELETE p FROM expense_payments p JOIN expenses e ON p.expense_id = e.expense_id WHERE e.event_id = ?", [id]);
      await getDatabasePool().execute("DELETE FROM expenses WHERE event_id = ?", [id]);
      await getDatabasePool().execute("DELETE FROM events WHERE event_id = ?", [id]);
    }
  }
}
async function records(tables: string[]) {
  return Promise.all(tables.map(async table => (await getDatabasePool().query<RowDataPacket[]>("SELECT * FROM " + table))[0].map(row => ({ ...row }))));
}

test("MySQL confirmation creates one exact unpaid expense and records review without changing vendors or payments", integration, async () => {
  for (const linked of [true, false]) await fixture(async f => {
    if (!linked) await getDatabasePool().execute("UPDATE draft_budget_items SET vendor_id = NULL, vendor_name = NULL WHERE draft_id = ?", [f.draft]);
    const before = await records(["vendors", "expense_payments", "event_documents"]);
    const original = await expenses.get(f.a, f.expense, f.owner);
    const result = await confirmer.confirm(f.a, f.draft, f.planner, { version: "1" });
    assert.equal(result.created, true); assert.equal(result.draft.status, "CONFIRMED");
    assert.equal(result.draft.version, "2"); assert.ok(result.draft.confirmedAt);
    const saved = await expenses.get(f.a, result.draft.confirmedExpenseId!, f.owner);
    assert.equal(saved.committedAmount, "600.10"); assert.equal(saved.paidTotal, "0.00");
    assert.equal(saved.outstandingAmount, "600.10"); assert.equal(saved.paymentStatus, "UNPAID");
    assert.equal(saved.categoryId, f.category); assert.equal(saved.vendorId, linked ? f.vendor : null);
    assert.equal(saved.dueDate, "2026-12-20"); assert.equal(saved.description, "DJ contract");
    assert.equal(result.draft.depositAmount, "100.05");
    assert.deepEqual(await expenses.get(f.a, f.expense, f.owner), original);
    assert.deepEqual(await records(["vendors", "expense_payments", "event_documents"]), before);
    const [[audit]] = await getDatabasePool().execute<RowDataPacket[]>("SELECT reviewed_by_sub, updated_by_sub FROM draft_budget_items WHERE draft_id = ?", [f.draft]);
    assert.equal(audit.reviewed_by_sub, f.planner); assert.equal(audit.updated_by_sub, f.planner);
    const [jobs] = await getDatabasePool().execute<RowDataPacket[]>("SELECT status, completed_at FROM contract_extraction_jobs WHERE draft_id = ? ORDER BY job_id", [f.draft]);
    assert.deepEqual(jobs.map(job => job.status), ["SUCCEEDED", "CANCELLED"]); assert.ok(jobs[1].completed_at);
  });
});

test("MySQL parallel confirmations, duplicate documents and retries cannot create a second expense", integration, async () => {
  await fixture(async f => {
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) =>
      confirmer.confirm(f.a, f.draft, i % 2 ? f.owner : f.planner, { version: "1" })));
    assert.equal(results.filter(result => result.created).length, 1);
    const id = results[0].draft.confirmedExpenseId!;
    assert.ok(results.every(result => result.draft.confirmedExpenseId === id && result.draft.version === "2"));
    assert.equal((await expenses.list(f.a, f.owner, { limit: 10, offset: 0 })).total, 2);
    assert.deepEqual(await new MySqlDraftCreator().create(f.a, f.document, f.owner), { draftId: f.draft, created: false });
    const audit = await records(["draft_budget_items"]);
    await expenses.update(f.a, id, f.owner, { description: "Later expense edit" });
    assert.equal((await confirmer.confirm(f.a, f.draft, f.owner, { version: "1" })).created, false);
    assert.equal((await expenses.get(f.a, id, f.owner)).description, "Later expense edit");
    await expenses.remove(f.a, id, f.owner);
    const retry = await confirmer.confirm(f.a, f.draft, f.owner, { version: "1" });
    assert.equal(retry.created, false); assert.equal(retry.draft.confirmedExpenseId, id);
    assert.equal((await expenses.list(f.a, f.owner, { limit: 10, offset: 0 })).total, 1);
    assert.deepEqual(await records(["draft_budget_items"]), audit);
  });
});

test("MySQL confirmation revalidates same-event categories, vendors and source fingerprints", integration, async () => {
  await fixture(async f => {
    const scenarios: [string, (string | null)[]][] = [
      ["UPDATE draft_budget_items SET category_id = ? WHERE draft_id = ?", [f.otherCategory, f.draft]],
      ["UPDATE draft_budget_items SET vendor_id = ? WHERE draft_id = ?", [f.otherVendor, f.draft]],
      ["UPDATE draft_budget_items SET content_sha256 = NULL WHERE draft_id = ?", [f.draft]],
      ["UPDATE event_documents SET content_sha256 = NULL WHERE document_id = ?", [f.document]],
      ["UPDATE event_documents SET content_sha256 = ? WHERE document_id = ?", ["b".repeat(64), f.document]],
      ["UPDATE draft_budget_items SET document_id = NULL WHERE draft_id = ?", [f.draft]],
    ];
    const financial = await records(["expenses", "expense_payments", "vendors"]);
    for (const [sql, values] of scenarios) {
      await getDatabasePool().execute(sql, values);
      await assert.rejects(confirmer.confirm(f.a, f.draft, f.owner, { version: "1" }), error => error instanceof ApiError && [409, 422].includes(error.status));
      assert.equal((await reader.get(f.a, f.draft, f.owner))?.status, "DRAFT");
      assert.deepEqual(await records(["expenses", "expense_payments", "vendors"]), financial);
      await getDatabasePool().execute("UPDATE draft_budget_items SET category_id = ?, vendor_id = ?, document_id = ?, content_sha256 = ? WHERE draft_id = ?",
        [f.category, f.vendor, f.document, "a".repeat(64), f.draft]);
      await getDatabasePool().execute("UPDATE event_documents SET content_sha256 = ? WHERE document_id = ?", ["a".repeat(64), f.document]);
    }
    await getDatabasePool().execute("DELETE FROM budget_categories WHERE category_id = ?", [f.otherCategory]);
    await getDatabasePool().execute("INSERT INTO budget_categories (category_id, event_id, name) VALUES (?, ?, 'Selected then removed')", [f.otherCategory, f.a]);
    await getDatabasePool().execute("UPDATE draft_budget_items SET category_id = ? WHERE draft_id = ?", [f.otherCategory, f.draft]);
    await getDatabasePool().execute("DELETE FROM budget_categories WHERE category_id = ?", [f.otherCategory]);
    await assert.rejects(confirmer.confirm(f.a, f.draft, f.owner, { version: "1" }), status(422));
  });
});

test("MySQL confirmation rejects unverified callers, wrong events, revoked access and stale/discarded drafts", integration, async () => {
  await fixture(async f => {
    for (const sub of ["outsider", f.owner.toUpperCase()]) await assert.rejects(confirmer.confirm(f.a, f.draft, sub, { version: "1" }), status(403));
    await assert.rejects(confirmer.confirm(f.b, f.draft, f.owner, { version: "1" }), status(404));
    await assert.rejects(confirmer.confirm(f.a, "999999", f.owner, { version: "1" }), status(404));
    await updater.update(f.a, f.draft, f.owner, { version: "1", description: "Later review" });
    await assert.rejects(confirmer.confirm(f.a, f.draft, f.owner, { version: "1" }), error => error instanceof ApiError && error.code === "DRAFT_CHANGED");
    await getDatabasePool().execute("DELETE FROM event_members WHERE event_id = ? AND cognito_sub = ?", [f.a, f.planner]);
    await assert.rejects(confirmer.confirm(f.a, f.draft, f.planner, { version: "2" }), status(403));
    await discarder.discard(f.a, f.draft, f.owner, { version: "2" });
    await assert.rejects(confirmer.confirm(f.a, f.draft, f.owner, { version: "3" }), error => error instanceof ApiError && error.code === "DRAFT_NOT_EDITABLE");
    assert.equal((await expenses.list(f.a, f.owner, { limit: 10, offset: 0 })).total, 1);
  });
});

test("MySQL failed confirmation rolls back new or updated expenses, review audit and extraction cancellation together", integration, async () => {
  for (const mode of ["create", "update"]) for (const failure of ["review", "cancel", "readback"]) await fixture(async f => {
    const body = mode === "update" ? await reviewExisting(f) : { version: "1" };
    let reads = 0;
    const connect = async () => {
      const connection = await getDatabasePool().getConnection();
      return new Proxy(connection, { get(target, property) {
        if (property === "execute") return async (sql: string, values?: unknown[]) => {
          if ((failure === "review" && sql.includes("UPDATE draft_budget_items SET status = 'CONFIRMED'")) ||
              (failure === "cancel" && sql.includes("UPDATE contract_extraction_jobs")) ||
              (failure === "readback" && sql.includes("LEFT JOIN event_documents") && ++reads === 2)) {
            throw new Error("Injected confirmation failure");
          }
          return Reflect.apply(target.execute, target, [sql, values]);
        };
        const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
      } });
    };
    const before = await records(["draft_budget_items", "expenses", "expense_payments", "vendors", "contract_extraction_jobs"]);
    await assert.rejects(new MySqlDraftConfirmer(connect).confirm(f.a, f.draft, f.owner, body), /Injected confirmation failure/);
    assert.deepEqual(await records(["draft_budget_items", "expenses", "expense_payments", "vendors", "contract_extraction_jobs"]), before);
  });
});

test("MySQL confirmation races with edits or discards leave one consistent result", integration, async () => {
  for (const operation of ["edit", "discard"]) await fixture(async f => {
    const results = await Promise.allSettled([
      confirmer.confirm(f.a, f.draft, f.owner, { version: "1" }),
      operation === "edit" ? updater.update(f.a, f.draft, f.planner, { version: "1", description: "Concurrent edit" })
        : discarder.discard(f.a, f.draft, f.planner, { version: "1" }),
    ]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    const final = (await reader.get(f.a, f.draft, f.owner))!;
    assert.equal(final.version, "2");
    const count = (await expenses.list(f.a, f.owner, { limit: 10, offset: 0 })).total;
    assert.equal(count, final.status === "CONFIRMED" ? 2 : 1);
    assert.equal(Boolean(final.confirmedExpenseId), final.status === "CONFIRMED");
  });
});

test("MySQL confirmation validates version-only requests and keeps large versions and expense IDs exact", integration, async () => {
  await fixture(async f => {
    for (const body of [{}, { version: 1 }, { version: "1", totalAmount: "1.00" }, { version: "1", status: "CONFIRMED" }]) {
      await assert.rejects(confirmer.confirm(f.a, f.draft, f.owner, body), status(422));
    }
    await getDatabasePool().execute("UPDATE draft_budget_items SET version = ? WHERE draft_id = ?", ["18446744073709551615", f.draft]);
    await assert.rejects(confirmer.confirm(f.a, f.draft, f.owner, { version: "18446744073709551615" }), error => error instanceof ApiError && error.code === "DRAFT_VERSION_LIMIT");
    await getDatabasePool().execute("UPDATE draft_budget_items SET version = ? WHERE draft_id = ?", ["9007199254740993", f.draft]);
    // This test runs only in a disposable database.
    await getDatabasePool().query("ALTER TABLE expenses AUTO_INCREMENT = 9007199254740993");
    const result = await confirmer.confirm(f.a, f.draft, f.owner, { version: "9007199254740993" });
    assert.equal(result.draft.version, "9007199254740994");
    assert.equal(result.draft.confirmedExpenseId, "9007199254740993");
    assert.equal((await expenses.get(f.a, result.draft.confirmedExpenseId!, f.owner)).committedAmount, "600.10");
  });
});

async function reviewExisting(f: Fixture, changes: Record<string, unknown> = {}) {
  const current = await expenses.get(f.a, f.expense, f.owner);
  const expectedExpense = { categoryId: current.categoryId, vendorId: current.vendorId,
    description: current.description, committedAmount: current.committedAmount, dueDate: current.dueDate };
  const reviewed = await updater.update(f.a, f.draft, f.owner, { version: "1", saveAction: "UPDATE_EXPENSE",
    targetExpenseId: f.expense, depositAmount: null, ...changes });
  return { version: reviewed.version, expectedExpense };
}

test("MySQL reviewed contract updates the selected expense and preserves its payments, identity and vendor record", integration, async () => {
  for (const totalAmount of ["600.10", "100.00"]) await fixture(async f => {
    const body = await reviewExisting(f, { totalAmount, dueDate: null });
    const original = await expenses.get(f.a, f.expense, f.owner);
    const before = await records(["expense_payments", "vendors", "event_documents"]);
    const result = await confirmer.confirm(f.a, f.draft, f.planner, body);
    assert.equal(result.created, false); assert.equal(result.draft.status, "CONFIRMED");
    assert.equal(result.draft.confirmedExpenseId, f.expense); assert.equal(result.draft.version, "3");
    const saved = await expenses.get(f.a, f.expense, f.owner);
    assert.equal(saved.expenseId, original.expenseId); assert.equal(saved.createdAt, original.createdAt);
    assert.equal(saved.committedAmount, totalAmount); assert.equal(saved.paidTotal, "100.00");
    assert.equal(saved.description, "DJ contract"); assert.equal(saved.dueDate, null); assert.equal(saved.vendorId, f.vendor);
    assert.equal(saved.outstandingAmount, totalAmount === "600.10" ? "500.10" : "0.00");
    assert.deepEqual(await records(["expense_payments", "vendors", "event_documents"]), before);
    assert.equal((await expenses.list(f.a, f.owner, { limit: 10, offset: 0 })).total, 1);
  });
});

test("MySQL repeat update confirmations never insert a second expense or overwrite later expense edits", integration, async () => {
  await fixture(async f => {
    const body = await reviewExisting(f);
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) =>
      confirmer.confirm(f.a, f.draft, i % 2 ? f.owner : f.planner, body)));
    assert.ok(results.every(result => !result.created && result.draft.confirmedExpenseId === f.expense && result.draft.version === "3"));
    const audit = await records(["draft_budget_items", "contract_extraction_jobs"]);
    await expenses.update(f.a, f.expense, f.owner, { description: "Later edit", committedAmount: "700.00" });
    const retried = await confirmer.confirm(f.a, f.draft, f.owner, body);
    assert.equal(retried.created, false);
    const saved = await expenses.get(f.a, f.expense, f.owner);
    assert.equal(saved.description, "Later edit"); assert.equal(saved.committedAmount, "700.00");
    assert.deepEqual(await records(["draft_budget_items", "contract_extraction_jobs"]), audit);
    assert.equal((await expenses.list(f.a, f.owner, { limit: 10, offset: 0 })).total, 1);
  });
});

test("MySQL update confirmation rejects missing or stale expense review snapshots without changing financial data", integration, async () => {
  await fixture(async f => {
    const body = await reviewExisting(f);
    await assert.rejects(confirmer.confirm(f.a, f.draft, f.owner, { version: body.version }), status(422));
    const newCategory = await insert("INSERT INTO budget_categories (event_id, name) VALUES (?, 'Second category')", [f.a]);
    for (const change of [{ description: "Someone else's edit" }, { committedAmount: "550.00" },
      { categoryId: newCategory }, { vendorId: null }, { dueDate: "2026-12-21" }]) {
      await expenses.update(f.a, f.expense, f.owner, change);
      const before = await records(["draft_budget_items", "expenses", "expense_payments", "contract_extraction_jobs"]);
      await assert.rejects(confirmer.confirm(f.a, f.draft, f.owner, body), error => error instanceof ApiError && error.code === "EXPENSE_CHANGED");
      assert.deepEqual(await records(["draft_budget_items", "expenses", "expense_payments", "contract_extraction_jobs"]), before);
      await expenses.update(f.a, f.expense, f.owner, body.expectedExpense);
    }
  });
});

test("MySQL update confirmation keeps target event and vendor associations and never replaces a deleted target", integration, async () => {
  for (const scenario of ["foreign", "deleted", "differentVendor", "unlinkVendor"]) await fixture(async f => {
    const body = await reviewExisting(f);
    if (scenario === "foreign") {
      const otherExpense = await insert("INSERT INTO expenses (event_id, category_id, vendor_id, description, committed_amount) VALUES (?, ?, ?, 'Other event', '500.00')",
        [f.b, f.otherCategory, f.otherVendor]);
      await getDatabasePool().execute("UPDATE draft_budget_items SET target_expense_id = ? WHERE draft_id = ?", [otherExpense, f.draft]);
    } else if (scenario === "deleted") {
      await getDatabasePool().execute("DELETE FROM expense_payments WHERE expense_id = ?", [f.expense]);
      await expenses.remove(f.a, f.expense, f.owner);
    } else {
      const vendor = scenario === "unlinkVendor" ? null : await insert("INSERT INTO vendors (event_id, name) VALUES (?, 'Different vendor')", [f.a]);
      await getDatabasePool().execute("UPDATE draft_budget_items SET vendor_id = ?, vendor_name = NULL WHERE draft_id = ?", [vendor, f.draft]);
    }
    const before = await records(["draft_budget_items", "expenses", "expense_payments", "vendors"]);
    await assert.rejects(confirmer.confirm(f.a, f.draft, f.owner, body), status(422));
    assert.deepEqual(await records(["draft_budget_items", "expenses", "expense_payments", "vendors"]), before);
  });
});

test("MySQL update confirmation rejects totals below net paid and preserves refund history", integration, async () => {
  await fixture(async f => {
    const body = await reviewExisting(f, { totalAmount: "99.99" });
    const before = await records(["draft_budget_items", "expenses", "expense_payments", "contract_extraction_jobs"]);
    await assert.rejects(confirmer.confirm(f.a, f.draft, f.owner, body), error =>
      error instanceof ApiError && error.code === "AMOUNT_BELOW_PAID" && Boolean(error.fields?.totalAmount));
    assert.deepEqual(await records(["draft_budget_items", "expenses", "expense_payments", "contract_extraction_jobs"]), before);
  });
  await fixture(async f => {
    await insert("INSERT INTO expense_payments (expense_id, amount, paid_at, payment_type) VALUES (?, '50.00', '2026-11-21', 'REFUND')", [f.expense]);
    const body = await reviewExisting(f, { totalAmount: "50.00" });
    const history = await records(["expense_payments"]);
    await confirmer.confirm(f.a, f.draft, f.owner, body);
    const saved = await expenses.get(f.a, f.expense, f.owner);
    assert.equal(saved.committedAmount, "50.00"); assert.equal(saved.paidTotal, "50.00"); assert.equal(saved.outstandingAmount, "0.00");
    assert.deepEqual(await records(["expense_payments"]), history);
  });
});

test("MySQL update confirmation sees payments committed after the initial draft read", integration, async () => {
  await fixture(async f => {
    const body = await reviewExisting(f, { totalAmount: "200.00" });
    let inserted = false;
    const connect = async () => {
      const connection = await getDatabasePool().getConnection();
      return new Proxy(connection, { get(target, property) {
        if (property === "execute") return async (sql: string, values?: unknown[]) => {
          const result = await Reflect.apply(target.execute, target, [sql, values]);
          if (!inserted && sql.includes("LEFT JOIN event_documents")) {
            inserted = true;
            await expenses.recordPayment(f.a, f.expense, f.owner, { amount: "250.00", paidAt: "2026-11-20", paymentType: "PAYMENT" });
          }
          return result;
        };
        const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
      } });
    };
    await assert.rejects(new MySqlDraftConfirmer(connect).confirm(f.a, f.draft, f.owner, body),
      error => error instanceof ApiError && error.code === "AMOUNT_BELOW_PAID");
    assert.ok(inserted);
    const saved = await expenses.get(f.a, f.expense, f.owner);
    assert.equal(saved.committedAmount, "500.00"); assert.equal(saved.paidTotal, "350.00");
    assert.equal((await reader.get(f.a, f.draft, f.owner))?.status, "DRAFT");
  });
});

test("MySQL concurrent payment and contract reduction cannot leave net paid above the expense total", integration, async () => {
  for (let attempt = 0; attempt < 3; attempt++) await fixture(async f => {
    const body = await reviewExisting(f, { totalAmount: "200.00" });
    const results = await Promise.allSettled([
      confirmer.confirm(f.a, f.draft, f.owner, body),
      expenses.recordPayment(f.a, f.expense, f.planner, { amount: "250.00", paidAt: "2026-11-20", paymentType: "PAYMENT" }),
    ]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    const rejected = results.find(result => result.status === "rejected");
    assert.ok(rejected?.status === "rejected" && rejected.reason instanceof ApiError);
    assert.ok(["AMOUNT_BELOW_PAID", "PAYMENT_EXCEEDS_BALANCE"].includes(rejected.reason.code));
    const saved = await expenses.get(f.a, f.expense, f.owner);
    assert.ok(cents(saved.paidTotal) <= cents(saved.committedAmount));
    assert.equal((await expenses.list(f.a, f.owner, { limit: 10, offset: 0 })).total, 1);
  });
});
