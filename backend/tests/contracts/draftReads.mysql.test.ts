import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { ApiError } from "../../expense-service/errors";
import { MySqlDraftReader } from "../../contract-service/repositories/draftReader";
import { getDatabasePool, closeDatabasePool } from "../../shared/db/pool";

const integration = { skip: process.env.EVENTWISE_MYSQL_TEST !== "1" };
const reader = new MySqlDraftReader();
after(closeDatabasePool);
const status = (expected: number) => (error: unknown) => error instanceof ApiError && error.status === expected;
async function insert(sql: string, values: (string | number | null)[] = []) {
  const [result] = await getDatabasePool().execute<ResultSetHeader>(sql, values);
  return String(result.insertId);
}
async function fixture(run: (f: { a: string; b: string; owner: string; planner: string; da: string; db: string; docB: string }) => Promise<void>) {
  const ids: string[] = [], owner = "owner-" + randomUUID(), planner = "planner-" + randomUUID();
  try {
    for (const name of ["A", "B"]) ids.push(await insert("INSERT INTO events (name) VALUES (?)", ["contract-read-test-" + name]));
    const [a, b] = ids;
    await insert("INSERT INTO event_members (event_id, cognito_sub, role) VALUES (?, ?, 'OWNER'), (?, ?, 'CO_PLANNER'), (?, ?, 'OWNER')", [a, owner, a, planner, b, "other-" + randomUUID()]);
    const docs: string[] = [];
    for (const id of ids) docs.push(await insert(
      "INSERT INTO event_documents (event_id, uploaded_by_sub, s3_object_key, original_filename, content_type, size_bytes, content_sha256) VALUES (?, ?, ?, ?, 'application/pdf', 100, ?)",
      [id, owner, "read-test/" + randomUUID(), "private-" + id + ".pdf", "a".repeat(64)]));
    const drafts: string[] = [];
    for (let i = 0; i < ids.length; i++) drafts.push(await insert(
      "INSERT INTO draft_budget_items (event_id, document_id, description, total_amount, deposit_amount, due_date, version, extracted_json, content_sha256) VALUES (?, ?, 'Contract', '625.10', '100.00', '2027-01-15', ?, ?, ?)",
      [ids[i], docs[i], "9007199254740993", '{"private":"OCR text"}', "a".repeat(64)]));
    await run({ a, b, owner, planner, da: drafts[0], db: drafts[1], docB: docs[1] });
  } finally {
    for (const id of ids) {
      await getDatabasePool().execute("DELETE FROM draft_budget_items WHERE event_id = ?", [id]);
      await getDatabasePool().execute("DELETE FROM events WHERE event_id = ?", [id]);
    }
  }
}

test("MySQL contract reads: owners/co-planners get exact values without internal document/extraction data", integration, async () => {
  await fixture(async f => {
    for (const sub of [f.owner, f.planner]) {
      const draft = await reader.get(f.a, f.da, sub);
      assert.ok(draft);
      assert.equal(draft.eventId, f.a); assert.equal(draft.draftId, f.da);
      assert.equal(draft.totalAmount, "625.10"); assert.equal(draft.depositAmount, "100.00");
      assert.equal(draft.version, "9007199254740993"); assert.equal(draft.dueDate, "2027-01-15");
      assert.equal(draft.documentFilename, "private-" + f.a + ".pdf");
      assert.equal(draft.categoryId, null);
      for (const field of ["content_sha256", "contentSha256", "extracted_json", "extractedJson", "s3_object_key", "uploaded_by_sub"]) {
        assert.ok(!Object.hasOwn(draft, field));
      }
    }
    const [rows] = await getDatabasePool().execute<RowDataPacket[]>("SELECT total_amount, deposit_amount, status, version FROM draft_budget_items WHERE draft_id = ?", [f.da]);
    assert.deepEqual({ ...rows[0] }, { total_amount: "625.10", deposit_amount: "100.00", status: "DRAFT", version: "9007199254740993" });
  });
});

test("MySQL contract reads: membership, revoked access, cross-event IDs and legacy document references stay isolated", integration, async () => {
  await fixture(async f => {
    for (const sub of ["outsider", f.owner.toUpperCase()]) {
      await assert.rejects(reader.list(f.a, sub, { limit: 20, offset: 0 }), status(403));
      await assert.rejects(reader.get(f.a, f.da, sub), status(403));
    }
    await assert.rejects(reader.list(f.b, f.owner, { limit: 20, offset: 0 }), status(403));
    assert.equal(await reader.get(f.a, f.db, f.owner), null);
    const legacy = await insert("INSERT INTO draft_budget_items (event_id, document_id) VALUES (?, ?)", [f.a, f.docB]);
    const hidden = await reader.get(f.a, legacy, f.owner);
    assert.ok(hidden); assert.equal(hidden.documentId, null); assert.equal(hidden.documentFilename, null);
    await getDatabasePool().execute("DELETE FROM event_members WHERE event_id = ? AND cognito_sub = ?", [f.a, f.planner]);
    await assert.rejects(reader.get(f.a, f.da, f.planner), status(403));
  });
});

test("MySQL contract reads: status filtering, stable pagination and empty pages retain event totals", integration, async () => {
  await fixture(async f => {
    const confirmed = await insert("INSERT INTO draft_budget_items (event_id, status) VALUES (?, 'CONFIRMED')", [f.a]);
    await insert("INSERT INTO draft_budget_items (event_id, status) VALUES (?, 'REJECTED')", [f.a]);
    await getDatabasePool().execute("UPDATE draft_budget_items SET updated_at = '2026-11-25 12:00:00.000000' WHERE event_id = ?", [f.a]);
    const all = await reader.list(f.a, f.owner, { limit: 20, offset: 0 });
    assert.equal(all.total, 3); assert.ok(all.data.every(row => row.eventId === f.a));
    assert.ok(all.data.every((row, i, rows) => i === 0 || BigInt(rows[i - 1].draftId) > BigInt(row.draftId)));
    const page = await reader.list(f.a, f.owner, { limit: 1, offset: 1 });
    assert.equal(page.total, 3); assert.deepEqual(page.data, [all.data[1]]);
    const filtered = await reader.list(f.a, f.owner, { limit: 20, offset: 0, status: "CONFIRMED" });
    assert.equal(filtered.total, 1); assert.equal(filtered.data[0].draftId, confirmed);
    assert.deepEqual(await reader.list(f.a, f.owner, { limit: 20, offset: 99 }), { data: [], total: 3, limit: 20, offset: 99 });
  });
});
