// Opt-in: EVENTWISE_SCHEMA_MYSQL_TEST=1 node --test database/mysql/verification/contract_extraction_schema.test.mjs
// Uses only local Docker MySQL (127.0.0.1:33317), never application .env/RDS.
// Creates randomly named test databases and removes only those databases.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(new URL('../../../backend/package.json', import.meta.url));
const mysql = require('mysql2/promise');
const schema = readFileSync(new URL('../schemas/eventwise_schema.sql', import.meta.url), 'utf8');
// Snapshot of the two pre-F15 tables, to exercise an upgrade with existing data.
const legacyTables = readFileSync(new URL('./fixtures/pre_contract_extraction_tables.sql', import.meta.url), 'utf8');
// Execute the exact bytes used by the deployed filename/checksum migration runner.
const migration = readFileSync(new URL('../migrations/007_contract_extraction_foundation.sql', import.meta.url), 'utf8');
const enabled = process.env.EVENTWISE_SCHEMA_MYSQL_TEST === '1';

async function database(legacy, run) {
  const connection = await mysql.createConnection({
    host: '127.0.0.1', port: 33317, user: 'root', password: 'localroot',
    multipleStatements: true, supportBigNumbers: true, bigNumberStrings: true, dateStrings: true,
  });
  const name = 'eventwise_f15_test_' + randomUUID().replaceAll('-', '');
  let created = false;
  try {
    await connection.query('CREATE DATABASE ' + connection.escapeId(name) + ' CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci');
    created = true;
    await connection.query('USE ' + connection.escapeId(name));
    let ddl = schema.replace(/^CREATE DATABASE .*;\r?\n/m, '').replace(/^USE eventwise;\r?\n/m, '');
    if (legacy) ddl = ddl.replace(/CREATE TABLE event_documents \([\s\S]*?(?=-- Initial template seeds\.)/, () => legacyTables + '\n\n');
    await connection.query(ddl);
    await run(connection);
  } finally {
    try {
      if (created) await connection.query('DROP DATABASE ' + connection.escapeId(name));
    } finally { await connection.end(); }
  }
}

async function insert(db, sql, values = []) {
  const [result] = await db.execute(sql, values);
  return String(result.insertId);
}
async function event(db) {
  return insert(db, "INSERT INTO events (name) VALUES ('F15 schema verification')");
}
async function document(db, eventId, hash = null) {
  return insert(db, 'INSERT INTO event_documents (event_id, uploaded_by_sub, s3_object_key, original_filename, content_type, size_bytes, content_sha256) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [eventId, 'schema-test-user', 'events/' + eventId + '/documents/' + randomUUID(), 'contract.pdf', 'application/pdf', 100, hash]);
}
async function draft(db, eventId, documentId, hash = null) {
  return insert(db, 'INSERT INTO draft_budget_items (event_id, document_id, content_sha256) VALUES (?, ?, ?)', [eventId, documentId, hash]);
}
async function job(db, eventId, draftId, requestId = randomUUID()) {
  return insert(db, 'INSERT INTO contract_extraction_jobs (request_id, event_id, draft_id, draft_version, requested_by_sub) VALUES (?, ?, ?, 1, ?)',
    [requestId, eventId, draftId, 'schema-test-user']);
}
async function structure(db) {
  const tables = "'event_documents','draft_budget_items','contract_extraction_jobs'";
  const queries = [
    'SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, GENERATION_EXPRESSION, COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (' + tables + ') ORDER BY TABLE_NAME, COLUMN_NAME',
    'SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (' + tables + ') ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX',
    'SELECT TABLE_NAME, CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (' + tables + ') ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION',
    'SELECT CONSTRAINT_NAME, CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() ORDER BY CONSTRAINT_NAME',
    'SELECT TABLE_NAME, CONSTRAINT_NAME, UPDATE_RULE, DELETE_RULE FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() ORDER BY TABLE_NAME, CONSTRAINT_NAME',
  ];
  return Promise.all(queries.map(async sql => (await db.query(sql))[0].map(row => ({ ...row }))));
}

test('F15 migration preserves legacy data and matches the fresh-install schema', { skip: !enabled }, async () => {
  let expected;
  await database(false, async db => { expected = await structure(db); });
  await database(true, async db => {
    const id = await event(db);
    const doc = await insert(db, 'INSERT INTO event_documents (event_id, uploaded_by_sub, s3_object_key, original_filename, content_type, size_bytes) VALUES (?, ?, ?, ?, ?, ?)',
      [id, 'legacy-user', 'legacy/contract', 'legacy.pdf', 'application/pdf', 42]);
    const draftId = await insert(db, 'INSERT INTO draft_budget_items (event_id, document_id, vendor_name, total_amount, deposit_amount, due_date, extracted_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, doc, 'Legacy vendor', '625.10', '100.00', '2027-01-15', '{"source":"legacy"}']);
    await insert(db, "INSERT INTO draft_budget_items (event_id, status, reviewed_by_sub) VALUES (?, 'CONFIRMED', ?)", [id, 'legacy-reviewer']);
    const [before] = await db.query('SELECT * FROM draft_budget_items ORDER BY draft_id');
    await db.query(migration);
    assert.deepEqual(await structure(db), expected);
    const [after] = await db.query('SELECT * FROM draft_budget_items ORDER BY draft_id');
    for (let i = 0; i < before.length; i++) {
      for (const field of Object.keys(before[i])) assert.deepEqual(after[i][field], before[i][field], field);
      assert.equal(after[i].version, '1');
      assert.equal(after[i].content_sha256, null);
      assert.equal(after[i].confirmed_expense_id, null);
      assert.equal(after[i].save_action, 'CREATE_EXPENSE');
    }
    assert.equal(String(after[0].draft_id), draftId);
    const [docs] = await db.execute('SELECT original_filename, content_sha256 FROM event_documents WHERE document_id = ?', [doc]);
    assert.deepEqual({ ...docs[0] }, { original_filename: 'legacy.pdf', content_sha256: null });
    for (const table of ['expenses', 'expense_payments', 'vendors', 'contract_extraction_jobs']) {
      const [[row]] = await db.query('SELECT COUNT(*) AS count FROM ' + table);
      assert.equal(Number(row.count), 0);
    }
  });
});

test('F15 preflight rejects duplicate legacy document drafts before altering tables', { skip: !enabled }, async () => {
  await database(true, async db => {
    const id = await event(db);
    const doc = await insert(db, "INSERT INTO event_documents (event_id, uploaded_by_sub, s3_object_key, original_filename, content_type, size_bytes) VALUES (?, 'user', 'duplicate', 'a.pdf', 'application/pdf', 1)", [id]);
    await insert(db, 'INSERT INTO draft_budget_items (event_id, document_id) VALUES (?, ?), (?, ?)', [id, doc, id, doc]);
    const before = await structure(db);
    await assert.rejects(db.query(migration), error => error.sqlState === '45000' && /reconcile duplicate/.test(error.message));
    assert.deepEqual(await structure(db), before);
    const [[row]] = await db.query('SELECT COUNT(*) AS count FROM draft_budget_items');
    assert.equal(Number(row.count), 2);
  });
});

test('F15 document/hash uniqueness is event-scoped and survives confirmation or rejection', { skip: !enabled }, async () => {
  await database(false, async db => {
    const a = await event(db), b = await event(db), hash = 'a'.repeat(64);
    const first = await document(db, a, hash), repeat = await document(db, a, hash);
    const id = await draft(db, a, first, hash);
    await assert.rejects(draft(db, a, first), { code: 'ER_DUP_ENTRY' });
    await assert.rejects(draft(db, a, repeat, hash), { code: 'ER_DUP_ENTRY' });
    await draft(db, b, await document(db, b, hash), hash);
    await draft(db, a, await document(db, a));
    await draft(db, a, await document(db, a)); // Unknown legacy hashes may coexist.
    for (const status of ['REJECTED', 'CONFIRMED']) {
      await db.execute('UPDATE draft_budget_items SET status = ? WHERE draft_id = ?', [status, id]);
      await assert.rejects(draft(db, a, repeat, hash), { code: 'ER_DUP_ENTRY' });
    }
    for (const bad of ['short', 'A'.repeat(64), 'g'.repeat(64)]) {
      await assert.rejects(document(db, a, bad), { code: 'ER_CHECK_CONSTRAINT_VIOLATED' });
      await assert.rejects(draft(db, a, null, bad), { code: 'ER_CHECK_CONSTRAINT_VIOLATED' });
    }
    await assert.rejects(db.execute('UPDATE draft_budget_items SET version = 0 WHERE draft_id = ?', [id]), { code: 'ER_CHECK_CONSTRAINT_VIOLATED' });
    await assert.rejects(db.execute("UPDATE draft_budget_items SET currency_code = 'cad' WHERE draft_id = ?", [id]), { code: 'ER_CHECK_CONSTRAINT_VIOLATED' });
    await db.execute("UPDATE draft_budget_items SET currency_code = 'CAD' WHERE draft_id = ?", [id]);
  });
});

test('F15 jobs deduplicate requests, isolate events and allow retry without replacing reviewed values', { skip: !enabled }, async () => {
  await database(false, async db => {
    const a = await event(db), b = await event(db);
    const id = await draft(db, a, await document(db, a));
    const requestId = randomUUID(), first = await job(db, a, id, requestId);
    await assert.rejects(job(db, a, id), { code: 'ER_DUP_ENTRY' });
    const other = await draft(db, b, await document(db, b));
    await assert.rejects(job(db, b, other, requestId), { code: 'ER_DUP_ENTRY' });
    await assert.rejects(job(db, a, other), { code: 'ER_NO_REFERENCED_ROW_2' });
    await db.execute("UPDATE contract_extraction_jobs SET status = 'FAILED', completed_at = NOW(6) WHERE job_id = ?", [first]);
    await job(db, a, id);
    const [edited] = await db.execute('UPDATE draft_budget_items SET total_amount = ?, version = version + 1 WHERE draft_id = ? AND version = 1', ['900.00', id]);
    assert.equal(edited.affectedRows, 1);
    const [stale] = await db.execute('UPDATE draft_budget_items SET total_amount = ?, version = version + 1 WHERE draft_id = ? AND version = 1', ['100.00', id]);
    assert.equal(stale.affectedRows, 0);
    const [[saved]] = await db.execute('SELECT total_amount, version FROM draft_budget_items WHERE draft_id = ?', [id]);
    assert.equal(saved.total_amount, '900.00'); assert.equal(saved.version, '2');
    const [attempts] = await db.execute('SELECT draft_version FROM contract_extraction_jobs WHERE draft_id = ?', [id]);
    assert.ok(attempts.every(row => row.draft_version === '1'));
  });
});

test('F15 selections clear on deletion, confirmed expense audit remains, and event cleanup cascades to jobs', { skip: !enabled }, async () => {
  await database(false, async db => {
    const id = await event(db), doc = await document(db, id), draftId = await draft(db, id, doc, 'b'.repeat(64));
    const category = await insert(db, "INSERT INTO budget_categories (event_id, name) VALUES (?, 'Venue')", [id]);
    const vendor = await insert(db, "INSERT INTO vendors (event_id, name) VALUES (?, 'Test vendor')", [id]);
    const expense = await insert(db, "INSERT INTO expenses (event_id, category_id, vendor_id, description, committed_amount) VALUES (?, ?, ?, 'Contract', '500.00')", [id, category, vendor]);
    await db.execute("UPDATE draft_budget_items SET category_id = ?, vendor_id = ?, save_action = 'UPDATE_EXPENSE', target_expense_id = ?, confirmed_expense_id = ?, status = 'CONFIRMED', confirmed_at = NOW(6) WHERE draft_id = ?",
      [category, vendor, expense, expense, draftId]);
    await job(db, id, draftId);
    await db.execute('DELETE FROM expenses WHERE expense_id = ?', [expense]);
    await db.execute('DELETE FROM vendors WHERE vendor_id = ?', [vendor]);
    await db.execute('DELETE FROM budget_categories WHERE category_id = ?', [category]);
    const [[saved]] = await db.execute('SELECT category_id, vendor_id, target_expense_id, confirmed_expense_id, status FROM draft_budget_items WHERE draft_id = ?', [draftId]);
    assert.deepEqual({ ...saved }, { category_id: null, vendor_id: null, target_expense_id: null, confirmed_expense_id: expense, status: 'CONFIRMED' });
    await assert.rejects(draft(db, id, doc), { code: 'ER_DUP_ENTRY' });
    // Match EventRepository: remove drafts/jobs before the document/event cascade.
    await db.execute('DELETE FROM draft_budget_items WHERE event_id = ?', [id]);
    await db.execute('DELETE FROM events WHERE event_id = ?', [id]);
    const [[remaining]] = await db.query('SELECT COUNT(*) AS count FROM contract_extraction_jobs');
    assert.equal(Number(remaining.count), 0);
  });
});
