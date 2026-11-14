import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { db } from "../shared/db/db";
import { EventRepository } from "../event-service/repositories/eventRepository";
import { EventService, EventAccessDeniedError, EventNotFoundError, EventConflictError } from "../event-service/services/eventService";

const enabled = process.env.EVENTWISE_MYSQL_TEST === "1";
after(async () => { await db.end(); });
const tables = ["events", "event_members", "expenses", "budget_categories", "vendors", "tasks", "event_invitations", "event_documents", "draft_budget_items"];
async function snapshot(id: string) {
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const [rows] = await db.execute<RowDataPacket[]>(`SELECT COUNT(*) AS count FROM ${table} WHERE event_id = ?`, [id]);
    counts[table] = Number(rows[0].count);
  }
  return counts;
}
async function insert(sql: string, values: (string | number | null)[]) {
  const [result] = await db.execute<ResultSetHeader>(sql, values);
  return String(result.insertId);
}
async function fixture() {
  const eventIds: string[] = [];
  let templateId: string | undefined;
  const owner = `delete-test-${randomUUID()}`;
  const cleanup = async () => {
    for (const id of [...eventIds].reverse()) {
      await db.execute("DELETE p FROM expense_payments p JOIN expenses e ON e.expense_id = p.expense_id WHERE e.event_id = ?", [id]);
      await db.execute("DELETE FROM expenses WHERE event_id = ?", [id]);
      await db.execute("DELETE FROM events WHERE event_id = ?", [id]);
    }
    if (templateId) await db.execute("DELETE FROM event_templates WHERE template_id = ?", [templateId]);
  };
  try {
    templateId = await insert("INSERT INTO event_templates (template_key, name) VALUES (?, ?)", [`del-${randomUUID()}`, "Delete test template"]);
    await insert("INSERT INTO template_budget_categories (template_id, name, default_percentage) VALUES (?, ?, ?)", [templateId, "Shared category", "100.00"]);
    const records = [];
    for (let i = 0; i < 2; i++) {
      const event = await new EventRepository().create({ name: `delete-test-${randomUUID()}`, template_id: null, event_date: null, venue: null, total_budget: "100.00" }, owner);
      const id = event.event_id; eventIds.push(id);
      await db.execute("UPDATE events SET template_id = ? WHERE event_id = ?", [templateId, id]);
      const category = await insert("INSERT INTO budget_categories (event_id, name) VALUES (?, ?)", [id, "Venue"]);
      const vendor = await insert("INSERT INTO vendors (event_id, name) VALUES (?, ?)", [id, "Vendor"]);
      const expense = await insert("INSERT INTO expenses (event_id, category_id, vendor_id, description, committed_amount) VALUES (?, ?, ?, ?, ?)", [id, category, vendor, "Venue expense", "10.00"]);
      const [members] = await db.execute<RowDataPacket[]>("SELECT CAST(member_id AS CHAR) AS id FROM event_members WHERE event_id = ? AND cognito_sub = ?", [id, owner]);
      const member = String(members[0].id);
      await insert("INSERT INTO tasks (event_id, title, assigned_member_id) VALUES (?, ?, ?)", [id, "Task", member]);
      const document = await insert("INSERT INTO event_documents (event_id, uploaded_by_sub, s3_object_key, original_filename, content_type, size_bytes) VALUES (?, ?, ?, ?, ?, ?)", [id, owner, `delete-test/${randomUUID()}`, "test.pdf", "application/pdf", 1]);
      await insert("INSERT INTO draft_budget_items (event_id, document_id) VALUES (?, ?)", [id, document]);
      await insert("INSERT INTO event_invitations (event_id, email, invited_by_sub, token_hash, expires_at) VALUES (?, ?, ?, ?, ?)", [id, "test@example.invalid", owner, randomUUID().replaceAll("-", "").padEnd(64, "0"), "2099-01-01"]);
      records.push({ id, expense, member, document });
    }
    return { owner, templateId, records, cleanup };
  } catch (error) { await cleanup(); throw error; }
}

test("MySQL: owner deletion handles all dependent rows, protects other events and shared templates", { skip: !enabled }, async () => {
  const f = await fixture(); const [a, b] = f.records;
  try {
    const service = new EventService();
    const co = `co-${randomUUID()}`;
    await db.execute("INSERT INTO event_members (event_id, cognito_sub, role) VALUES (?, ?, 'CO_PLANNER')", [a.id, co]);
    const before = await snapshot(a.id), other = await snapshot(b.id);
    for (const sub of [co, `other-${randomUUID()}`]) await assert.rejects(service.delete(a.id, sub), EventAccessDeniedError);
    assert.deepEqual(await snapshot(a.id), before);
    await service.delete(a.id, f.owner);
    assert.ok(Object.values(await snapshot(a.id)).every((count) => count === 0));
    assert.deepEqual(await snapshot(b.id), other);
    const [templates] = await db.execute<RowDataPacket[]>("SELECT template_id FROM event_templates WHERE template_id = ?", [f.templateId]);
    const [categories] = await db.execute<RowDataPacket[]>("SELECT template_category_id FROM template_budget_categories WHERE template_id = ?", [f.templateId]);
    assert.equal(templates.length, 1); assert.equal(categories.length, 1);
    await assert.rejects(service.delete(a.id, f.owner), EventNotFoundError);
  } finally { await f.cleanup(); }
});

test("MySQL: any payment history blocks event deletion, including net-zero payments", { skip: !enabled }, async () => {
  const f = await fixture(); const [a] = f.records;
  try {
    for (const type of ["PAYMENT", "REFUND"]) await db.execute("INSERT INTO expense_payments (expense_id, amount, paid_at, payment_type) VALUES (?, ?, ?, ?)", [a.expense, "1.00", "2026-01-01", type]);
    const before = await snapshot(a.id);
    await assert.rejects(new EventService().delete(a.id, f.owner), EventConflictError);
    assert.deepEqual(await snapshot(a.id), before);
    const [payments] = await db.execute<RowDataPacket[]>("SELECT payment_id FROM expense_payments WHERE expense_id = ?", [a.expense]);
    assert.equal(payments.length, 2);
  } finally { await f.cleanup(); }
});

test("MySQL: cross-event member/document references are not cleared by deletion", { skip: !enabled }, async () => {
  const f = await fixture(); const [a, b] = f.records;
  try {
    const task = await insert("INSERT INTO tasks (event_id, title, assigned_member_id) VALUES (?, ?, ?)", [b.id, "Cross-event task", a.member]);
    const draft = await insert("INSERT INTO draft_budget_items (event_id, document_id) VALUES (?, ?)", [b.id, a.document]);
    await assert.rejects(new EventService().delete(a.id, f.owner), EventConflictError);
    const [tasks] = await db.execute<RowDataPacket[]>("SELECT CAST(assigned_member_id AS CHAR) AS id FROM tasks WHERE task_id = ?", [task]);
    const [drafts] = await db.execute<RowDataPacket[]>("SELECT CAST(document_id AS CHAR) AS id FROM draft_budget_items WHERE draft_id = ?", [draft]);
    assert.equal(tasks[0].id, a.member); assert.equal(drafts[0].id, a.document);
  } finally { await f.cleanup(); }
});

test("MySQL: event delete failure rolls back previously deleted expenses", { skip: !enabled }, async () => {
  const f = await fixture(); const [a] = f.records;
  const repository = new EventRepository({ getConnection: async () => {
    const connection = await db.getConnection();
    return new Proxy(connection, { get(target, property) {
      if (property === "execute") return (sql: string, values?: (string | number | null)[]) => {
        if (sql === "DELETE FROM events WHERE event_id = ?") throw new Error("Injected delete failure");
        return target.execute(sql, values);
      };
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } }) as PoolConnection;
  } });
  try {
    const before = await snapshot(a.id);
    await assert.rejects(new EventService(repository).delete(a.id, f.owner), /Injected delete failure/);
    assert.deepEqual(await snapshot(a.id), before);
  } finally { await f.cleanup(); }
});
