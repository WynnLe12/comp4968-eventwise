import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { ApiError } from "../../expense-service/errors";
import { MySqlDraftDiscarder } from "../../contract-service/repositories/draftDiscarder";
import { MySqlDraftCreator } from "../../contract-service/repositories/draftCreator";
import { MySqlDraftUpdater } from "../../contract-service/repositories/draftUpdater";
import { MySqlDraftReader } from "../../contract-service/repositories/draftReader";
import { getDatabasePool, closeDatabasePool } from "../../shared/db/pool";

const integration = { skip: process.env.EVENTWISE_MYSQL_TEST !== "1" };
const discard = new MySqlDraftDiscarder(), reader = new MySqlDraftReader(), updater = new MySqlDraftUpdater();
const status = (expected: number) => (error: unknown) => error instanceof ApiError && error.status === expected;
after(closeDatabasePool);
async function insert(sql: string, values: (string | number | null)[] = []) {
  const [result] = await getDatabasePool().execute<ResultSetHeader>(sql, values); return String(result.insertId);
}
async function fixture(run: (f: { event: string; owner: string; planner: string; draft: string; otherDraft: string; document: string }) => Promise<void>) {
  const ids: string[] = [], owner = "owner-" + randomUUID(), planner = "planner-" + randomUUID(), drafts: string[] = [], documents: string[] = [];
  try {
    for (const name of ["A", "B"]) ids.push(await insert("INSERT INTO events (name) VALUES (?)", ["F15 discard " + name]));
    const [a, b] = ids;
    await insert("INSERT INTO event_members (event_id, cognito_sub, role) VALUES (?, ?, 'OWNER'), (?, ?, 'CO_PLANNER'), (?, ?, 'OWNER')", [a, owner, a, planner, b, owner]);
    for (const id of ids) {
      documents.push(await insert("INSERT INTO event_documents (event_id, uploaded_by_sub, s3_object_key, original_filename, content_type, size_bytes, content_sha256) VALUES (?, ?, ?, 'contract.pdf', 'application/pdf', 100, ?)",
        [id, owner, "events/" + id + "/documents/" + randomUUID(), "a".repeat(64)]));
      drafts.push(await insert("INSERT INTO draft_budget_items (event_id, document_id, content_sha256, total_amount) VALUES (?, ?, ?, '600.00')", [id, documents.at(-1)!, "a".repeat(64)]));
    }
    const category = await insert("INSERT INTO budget_categories (event_id, name) VALUES (?, 'Venue')", [a]);
    const vendor = await insert("INSERT INTO vendors (event_id, name) VALUES (?, 'Vendor')", [a]);
    const expense = await insert("INSERT INTO expenses (event_id, category_id, vendor_id, description, committed_amount) VALUES (?, ?, ?, 'Existing expense', '500.00')", [a, category, vendor]);
    await insert("INSERT INTO expense_payments (expense_id, amount, paid_at) VALUES (?, '100.00', '2026-11-20')", [expense]);
    for (const state of ["SUCCEEDED", "FAILED", "QUEUED"]) await insert(
      "INSERT INTO contract_extraction_jobs (request_id, event_id, draft_id, draft_version, requested_by_sub, status, result_json) VALUES (?, ?, ?, 1, ?, ?, ?)",
      [randomUUID(), a, drafts[0], owner, state, state === "SUCCEEDED" ? '{"total":"600.00"}' : null]);
    await run({ event: a, owner, planner, draft: drafts[0], otherDraft: drafts[1], document: documents[0] });
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

test("MySQL discard preserves documents, duplicate claims, financial records and completed job history", integration, async () => {
  for (const active of ["QUEUED", "PROCESSING"]) await fixture(async f => {
    await getDatabasePool().execute("UPDATE contract_extraction_jobs SET status = ? WHERE event_id = ? AND status = 'QUEUED'", [active, f.event]);
    const before = await records(["event_documents", "vendors", "expenses", "expense_payments"]);
    const result = await discard.discard(f.event, f.draft, f.planner, { version: "1" });
    assert.equal(result.status, "REJECTED"); assert.equal(result.version, "2"); assert.equal(result.documentId, f.document);
    assert.equal(result.totalAmount, "600.00");
    assert.deepEqual(await records(["event_documents", "vendors", "expenses", "expense_payments"]), before);
    const [jobs] = await getDatabasePool().execute<RowDataPacket[]>("SELECT status, completed_at, result_json, active_draft_id FROM contract_extraction_jobs WHERE draft_id = ? ORDER BY job_id", [f.draft]);
    assert.deepEqual(jobs.map(job => job.status), ["SUCCEEDED", "FAILED", "CANCELLED"]);
    assert.deepEqual(jobs[0].result_json, { total: "600.00" });
    assert.ok(jobs[2].completed_at); assert.equal(jobs[2].active_draft_id, null);
    assert.deepEqual(await new MySqlDraftCreator().create(f.event, f.document, f.owner), { draftId: f.draft, created: false });
    await assert.rejects(updater.update(f.event, f.draft, f.owner, { version: "2", description: "Edit" }), status(409));
  });
});

test("MySQL duplicate discard requests succeed once and retain the first audit identity and version", integration, async () => {
  await fixture(async f => {
    const results = await Promise.all([discard.discard(f.event, f.draft, f.owner, { version: "1" }),
      discard.discard(f.event, f.draft, f.planner, { version: "1" })]);
    assert.ok(results.every(row => row.status === "REJECTED" && row.version === "2"));
    const before = await records(["draft_budget_items"]);
    assert.equal((await discard.discard(f.event, f.draft, f.owner, { version: "1" })).version, "2");
    assert.deepEqual(await records(["draft_budget_items"]), before);
  });
});

test("MySQL discard rejects stale versions, revoked membership, cross-event IDs and confirmed drafts", integration, async () => {
  await fixture(async f => {
    for (const sub of ["outsider", f.owner.toUpperCase()]) await assert.rejects(discard.discard(f.event, f.draft, sub, { version: "1" }), status(403));
    await assert.rejects(discard.discard(f.event, f.otherDraft, f.owner, { version: "1" }), status(404));
    await updater.update(f.event, f.draft, f.owner, { version: "1", description: "New edit" });
    await assert.rejects(discard.discard(f.event, f.draft, f.owner, { version: "1" }), error => error instanceof ApiError && error.code === "DRAFT_CHANGED");
    assert.equal((await reader.get(f.event, f.draft, f.owner))?.status, "DRAFT");
    await getDatabasePool().execute("DELETE FROM event_members WHERE event_id = ? AND cognito_sub = ?", [f.event, f.planner]);
    await assert.rejects(discard.discard(f.event, f.draft, f.planner, { version: "2" }), status(403));
    await getDatabasePool().execute("UPDATE draft_budget_items SET status = 'CONFIRMED' WHERE draft_id = ?", [f.draft]);
    const before = await records(["draft_budget_items", "contract_extraction_jobs"]);
    await assert.rejects(discard.discard(f.event, f.draft, f.owner, { version: "2" }), error => error instanceof ApiError && error.code === "DRAFT_NOT_EDITABLE");
    assert.deepEqual(await records(["draft_budget_items", "contract_extraction_jobs"]), before);
  });
});

test("MySQL discard rolls back the draft and jobs if cancellation or readback fails", integration, async () => {
  for (const failure of ["cancel", "readback"]) await fixture(async f => {
    const connect = async () => {
      const connection = await getDatabasePool().getConnection();
      return new Proxy(connection, { get(target, property) {
        if (property === "execute") return async (sql: string, values?: unknown[]) => {
          if ((failure === "cancel" && sql.includes("UPDATE contract_extraction_jobs")) ||
              (failure === "readback" && sql.includes("LEFT JOIN event_documents"))) throw new Error("Injected discard failure");
          return Reflect.apply(target.execute, target, [sql, values]);
        };
        const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
      } });
    };
    const before = await records(["draft_budget_items", "contract_extraction_jobs"]);
    await assert.rejects(new MySqlDraftDiscarder(connect).discard(f.event, f.draft, f.owner, { version: "1" }), /Injected discard failure/);
    assert.deepEqual(await records(["draft_budget_items", "contract_extraction_jobs"]), before);
  });
});

test("MySQL discard validates version-only requests and handles the maximum version without overflow", integration, async () => {
  await fixture(async f => {
    for (const body of [{}, { version: 1 }, { version: "1", status: "REJECTED" }, { version: "1", documentId: f.document }]) {
      await assert.rejects(discard.discard(f.event, f.draft, f.owner, body), status(422));
    }
    await getDatabasePool().execute("UPDATE draft_budget_items SET version = ? WHERE draft_id = ?", ["18446744073709551615", f.draft]);
    await assert.rejects(discard.discard(f.event, f.draft, f.owner, { version: "18446744073709551615" }), error => error instanceof ApiError && error.code === "DRAFT_VERSION_LIMIT");
    const unchanged = await reader.get(f.event, f.draft, f.owner);
    assert.equal(unchanged?.status, "DRAFT"); assert.equal(unchanged?.version, "18446744073709551615");
  });
});
