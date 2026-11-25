import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { MySqlDraftCreator } from "../../contract-service/repositories/draftCreator";
import { ApiError } from "../../expense-service/errors";
import { getDatabasePool, closeDatabasePool } from "../../shared/db/pool";
import type { DocumentFingerprint } from "../../contract-service/services/documentFingerprint";

const integration = { skip: process.env.EVENTWISE_MYSQL_TEST !== "1" };
const hash = "a".repeat(64);
const status = (expected: number) => (error: unknown) => error instanceof ApiError && error.status === expected;
after(closeDatabasePool);
async function insert(sql: string, values: (string | number | null)[] = []) {
  const [result] = await getDatabasePool().execute<ResultSetHeader>(sql, values);
  return String(result.insertId);
}
async function fixture(run: (f: { a: string; b: string; owner: string; planner: string;
  document: (eventId: string, fingerprint?: string | null, contentType?: string) => Promise<string> }) => Promise<void>) {
  const ids: string[] = [], owner = "owner-" + randomUUID(), planner = "planner-" + randomUUID();
  try {
    for (const name of ["A", "B"]) ids.push(await insert("INSERT INTO events (name) VALUES (?)", ["F15 create " + name]));
    const [a, b] = ids;
    await insert("INSERT INTO event_members (event_id, cognito_sub, role) VALUES (?, ?, 'OWNER'), (?, ?, 'CO_PLANNER'), (?, ?, 'OWNER')", [a, owner, a, planner, b, owner]);
    await run({ a, b, owner, planner, document: (eventId, fingerprint = hash, contentType = "application/pdf") => insert(
      "INSERT INTO event_documents (event_id, uploaded_by_sub, s3_object_key, original_filename, content_type, size_bytes, content_sha256) VALUES (?, ?, ?, 'contract.pdf', ?, 100, ?)",
      [eventId, owner, "events/" + eventId + "/documents/" + randomUUID(), contentType, fingerprint]) });
  } finally {
    for (const id of ids) {
      await getDatabasePool().execute("DELETE FROM draft_budget_items WHERE event_id = ?", [id]);
      await getDatabasePool().execute("DELETE FROM events WHERE event_id = ?", [id]);
    }
  }
}
function creator(fingerprint: DocumentFingerprint = async () => { throw new Error("Cached hash must not fetch S3"); }) {
  return new MySqlDraftCreator(undefined, fingerprint);
}

test("MySQL draft creation: parallel identical uploads reuse one draft, without committing financial records", integration, async () => {
  await fixture(async f => {
    const first = await f.document(f.a), second = await f.document(f.a);
    const service = creator();
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => service.create(f.a, i % 2 ? first : second, i % 2 ? f.owner : f.planner)));
    assert.equal(results.filter(result => result.created).length, 1);
    assert.equal(new Set(results.map(result => result.draftId)).size, 1);
    const other = await service.create(f.b, await f.document(f.b), f.owner);
    assert.notEqual(other.draftId, results[0].draftId);
    for (const state of ["REJECTED", "CONFIRMED"]) {
      await getDatabasePool().execute("UPDATE draft_budget_items SET status = ? WHERE draft_id = ?", [state, results[0].draftId]);
      assert.deepEqual(await service.create(f.a, first, f.owner), { draftId: results[0].draftId, created: false });
      const [[row]] = await getDatabasePool().execute<RowDataPacket[]>("SELECT status FROM draft_budget_items WHERE draft_id = ?", [results[0].draftId]);
      assert.equal(row.status, state);
    }
    for (const table of ["expenses", "expense_payments", "vendors"]) {
      const [[row]] = await getDatabasePool().query<RowDataPacket[]>("SELECT COUNT(*) AS count FROM " + table);
      assert.equal(Number(row.count), 0);
    }
  });
});

test("MySQL draft creation: access, cross-event documents and unsupported file types are rejected", integration, async () => {
  await fixture(async f => {
    const doc = await f.document(f.a), other = await f.document(f.b), service = creator();
    for (const sub of ["outsider", f.owner.toUpperCase()]) await assert.rejects(service.create(f.a, doc, sub), status(403));
    await assert.rejects(service.create(f.a, other, f.owner), status(404));
    await assert.rejects(service.create(f.a, await f.document(f.a, hash, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), f.owner), status(422));
    await assert.rejects(service.create(f.a, "999999", f.owner), status(404));
  });
});

test("MySQL draft creation: older documents and drafts gain fingerprints without changing reviewed values", integration, async () => {
  await fixture(async f => {
    const doc = await f.document(f.a, null);
    const id = await insert("INSERT INTO draft_budget_items (draft_id, event_id, document_id, total_amount, version) VALUES (?, ?, ?, '42.10', 10)",
      ["9007199254740993", f.a, doc]);
    let reads = 0;
    const service = creator(async () => { reads++; return hash; });
    assert.deepEqual(await service.create(f.a, doc, f.owner), { draftId: id, created: false });
    assert.deepEqual(await service.create(f.a, doc, f.planner), { draftId: id, created: false });
    assert.equal(reads, 1);
    const [[row]] = await getDatabasePool().execute<RowDataPacket[]>(
      "SELECT d.content_sha256, d.total_amount, d.version, e.content_sha256 AS document_hash FROM draft_budget_items d JOIN event_documents e ON d.document_id = e.document_id WHERE d.draft_id = ?", [id]);
    assert.equal(row.content_sha256, hash); assert.equal(row.document_hash, hash);
    assert.equal(row.total_amount, "42.10"); assert.equal(row.version, "10");
  });
});

test("MySQL draft creation: access revoked while S3 is read prevents all writes", integration, async () => {
  await fixture(async f => {
    const doc = await f.document(f.a, null);
    let started!: () => void, finish!: (value: string) => void;
    const reading = new Promise<void>(resolve => { started = resolve; });
    const service = creator(async () => { started(); return new Promise<string>(resolve => { finish = resolve; }); });
    const pending = service.create(f.a, doc, f.planner);
    const rejected = assert.rejects(pending, status(403));
    await reading;
    await getDatabasePool().execute("DELETE FROM event_members WHERE event_id = ? AND cognito_sub = ?", [f.a, f.planner]);
    finish(hash);
    await rejected;
    const [[row]] = await getDatabasePool().execute<RowDataPacket[]>("SELECT content_sha256 FROM event_documents WHERE document_id = ?", [doc]);
    assert.equal(row.content_sha256, null);
    const [[count]] = await getDatabasePool().execute<RowDataPacket[]>("SELECT COUNT(*) AS count FROM draft_budget_items WHERE event_id = ?", [f.a]);
    assert.equal(Number(count.count), 0);
  });
});

test("MySQL draft creation: conflicting legacy claims never merge or overwrite saved drafts", integration, async () => {
  await fixture(async f => {
    const first = await f.document(f.a), second = await f.document(f.a, null);
    await creator().create(f.a, first, f.owner);
    await insert("INSERT INTO draft_budget_items (event_id, document_id, total_amount) VALUES (?, ?, '10.00')", [f.a, second]);
    await assert.rejects(creator(async () => hash).create(f.a, second, f.owner), error => error instanceof ApiError && error.code === "DUPLICATE_CONTRACT");
    const [[row]] = await getDatabasePool().execute<RowDataPacket[]>("SELECT content_sha256 FROM event_documents WHERE document_id = ?", [second]);
    assert.equal(row.content_sha256, null);
    const [[count]] = await getDatabasePool().execute<RowDataPacket[]>("SELECT COUNT(*) AS count FROM draft_budget_items WHERE event_id = ?", [f.a]);
    assert.equal(Number(count.count), 2);
  });
});

test("MySQL draft creation: insert failures roll back fingerprint updates and changed documents are rejected", integration, async () => {
  await fixture(async f => {
    const doc = await f.document(f.a, null);
    const connect = async () => {
      const connection = await getDatabasePool().getConnection();
      return new Proxy(connection, { get(target, property) {
        if (property === "execute") return async (sql: string, values?: unknown[]) => {
          if (sql.includes("INSERT INTO draft_budget_items")) throw new Error("Injected insert failure");
          return Reflect.apply(target.execute, target, [sql, values]);
        };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    };
    await assert.rejects(new MySqlDraftCreator(connect, async () => hash).create(f.a, doc, f.owner), /Injected insert failure/);
    const [[row]] = await getDatabasePool().execute<RowDataPacket[]>("SELECT content_sha256 FROM event_documents WHERE document_id = ?", [doc]);
    assert.equal(row.content_sha256, null);
    const service = creator(async () => {
      await getDatabasePool().execute("UPDATE event_documents SET content_type = 'image/png' WHERE document_id = ?", [doc]);
      return hash;
    });
    await assert.rejects(service.create(f.a, doc, f.owner), error => error instanceof ApiError && error.code === "DOCUMENT_CHANGED");
    const [[count]] = await getDatabasePool().execute<RowDataPacket[]>("SELECT COUNT(*) AS count FROM draft_budget_items WHERE event_id = ?", [f.a]);
    assert.equal(Number(count.count), 0);
  });
});
