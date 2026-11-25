import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { db } from "../shared/db/db";
import { EventRepository } from "../event-service/repositories/eventRepository";
import { DashboardRepository } from "../event-service/repositories/dashboardRepository";

const enabled = process.env.EVENTWISE_MYSQL_TEST === "1";
after(async () => { await db.end(); });

const TODAY = "2026-06-10";
const UNTIL = "2026-06-17"; // TODAY + 7 days

async function insert(sql: string, values: (string | number | null)[]): Promise<string> {
  const [result] = await db.execute<ResultSetHeader>(sql, values);
  return String(result.insertId);
}

async function fixture() {
  const owner = `dash-owner-${randomUUID()}`;
  const coPlanner = `dash-co-${randomUUID()}`;
  const events: string[] = [];
  const cleanup = async () => {
    for (const id of events) {
      await db.execute("DELETE p FROM expense_payments p JOIN expenses e ON e.expense_id = p.expense_id WHERE e.event_id = ?", [id]);
      await db.execute("DELETE FROM tasks WHERE event_id = ?", [id]);
      await db.execute("DELETE FROM expenses WHERE event_id = ?", [id]);
      await db.execute("DELETE FROM events WHERE event_id = ?", [id]);
    }
  };
  try {
    const repo = new EventRepository();
    const main = (await repo.create({ name: `dash-${randomUUID()}`, template_id: null, event_date: null, venue: null, total_budget: "5000.00" }, owner, "Khai")).event_id;
    const other = (await repo.create({ name: `dash-${randomUUID()}`, template_id: null, event_date: null, venue: null, total_budget: "100.00" }, owner, "Khai")).event_id;
    events.push(main, other);

    const coMember = await insert(
      "INSERT INTO event_members (event_id, cognito_sub, role, display_name) VALUES (?, ?, 'CO_PLANNER', ?)",
      [main, coPlanner, "Heather"],
    );
    const ownerMemberOf = async (eventId: string) => {
      const [rows] = await db.execute<RowDataPacket[]>(
        "SELECT CAST(member_id AS CHAR) AS id FROM event_members WHERE event_id = ? AND cognito_sub = ?", [eventId, owner]);
      return String(rows[0]!.id);
    };
    const ownerMember = await ownerMemberOf(main);
    const otherEventMember = await ownerMemberOf(other);

    const photo = await insert("INSERT INTO budget_categories (event_id, name, planned_amount) VALUES (?, ?, ?)", [main, "Photography", "3000.00"]);
    const venue = await insert("INSERT INTO budget_categories (event_id, name, planned_amount) VALUES (?, ?, ?)", [main, "Venue", "2000.00"]);
    const otherCategory = await insert("INSERT INTO budget_categories (event_id, name) VALUES (?, ?)", [other, "Other"]);
    const lens = await insert("INSERT INTO vendors (event_id, name) VALUES (?, ?)", [main, "Lens Studio"]);

    const expense = (eventId: string, category: string, vendor: string | null, description: string, amount: string, due: string | null) =>
      insert("INSERT INTO expenses (event_id, category_id, vendor_id, description, committed_amount, due_date) VALUES (?, ?, ?, ?, ?, ?)", [eventId, category, vendor, description, amount, due]);
    const pay = (expenseId: string, amount: string, type: string) =>
      insert("INSERT INTO expense_payments (expense_id, amount, paid_at, payment_type) VALUES (?, ?, ?, ?)", [expenseId, amount, "2026-06-01", type]);

    const overdue = await expense(main, photo, lens, "Photographer deposit", "1000.00", "2026-06-05");
    await pay(overdue, "200.00", "DEPOSIT"); // 800.00 still owed, overdue
    const dueToday = await expense(main, venue, null, "Venue balance", "500.00", TODAY); // due today: upcoming, not overdue
    const lastDay = await expense(main, venue, null, "Chairs", "300.00", UNTIL);
    await pay(lastDay, "100.00", "DEPOSIT"); await pay(lastDay, "50.00", "REFUND"); // net paid 50.00 -> 250.00 owed
    await expense(main, venue, null, "Too late", "400.00", "2026-06-18"); // after the 7-day window
    const paidOff = await expense(main, photo, lens, "Album", "600.00", "2026-06-01");
    await pay(paidOff, "600.00", "PAYMENT"); // fully paid: never listed
    await expense(main, venue, null, "No due date", "100.00", null); // no due date: never listed
    for (let i = 1; i <= 4; i++) await expense(main, venue, null, `Small ${i}`, "10.00", "2026-06-12");
    await expense(other, otherCategory, null, "Other event", "999.00", "2026-06-08"); // other event: never listed

    const task = (eventId: string, title: string, due: string | null, done: boolean, member: string | null) =>
      // chk_task_completed_at (Feature 12): a completed task needs completed_at.
      insert(`INSERT INTO tasks (event_id, title, due_date, is_completed, completed_at, assigned_member_id)
              VALUES (?, ?, ?, ?, ${done ? "UTC_TIMESTAMP()" : "NULL"}, ?)`, [eventId, title, due, done ? 1 : 0, member]);
    await task(main, "Book venue", "2026-06-01", true, ownerMember);
    await task(main, "Send invites", "2026-06-05", false, coMember); // overdue
    await task(main, "Confirm florist", "2026-06-12", false, ownerMember);
    await task(main, "Write speech", null, false, null); // no due date: not in nextDue
    await task(main, "Bad assignment", "2026-06-20", false, otherEventMember); // assignee from another event
    await task(other, "Other event task", "2026-06-02", false, otherEventMember);

    return { main, other, owner, coPlanner, overdue, dueToday, lastDay, cleanup };
  } catch (error) { await cleanup(); throw error; }
}

test("MySQL: event access tells owners, co-planners, strangers and missing events apart", { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    const repo = new DashboardRepository();
    assert.equal(await repo.eventAccess(f.main, f.owner), "OWNER");
    assert.equal(await repo.eventAccess(f.main, f.coPlanner), "CO_PLANNER");
    assert.equal(await repo.eventAccess(f.main, `stranger-${randomUUID()}`), null);
    assert.equal(await repo.eventAccess("18446744073709551615", f.owner), undefined);
  } finally { await f.cleanup(); }
});

test("MySQL: payments include overdue and next-7-day balances only, nearest first, at most 5", { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    const p = await new DashboardRepository().payments(f.main, TODAY, UNTIL);
    assert.equal(p.overdueTotal, "800.00");
    assert.equal(p.overdueCount, 1);
    // 500.00 (due today) + 250.00 (last day, after refund) + 4 x 10.00
    assert.equal(p.upcomingTotal, "790.00");
    assert.equal(p.upcomingCount, 6);
    assert.equal(p.items.length, 5);
    assert.deepEqual(p.items[0], {
      expenseId: f.overdue, description: "Photographer deposit", vendorName: "Lens Studio",
      categoryName: "Photography", dueDate: "2026-06-05", outstandingAmount: "800.00", isOverdue: true,
    });
    assert.deepEqual(
      p.items.map((item) => [item.dueDate, item.isOverdue, item.vendorName]),
      [["2026-06-05", true, "Lens Studio"], [TODAY, false, null], ["2026-06-12", false, null], ["2026-06-12", false, null], ["2026-06-12", false, null]],
    );
    assert.ok(!p.items.some((item) => ["Too late", "Album", "No due date", "Other event"].includes(item.description)));
  } finally { await f.cleanup(); }
});

test("MySQL: an event without expenses has zero payments", { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    const p = await new DashboardRepository().payments("18446744073709551615", TODAY, UNTIL);
    assert.deepEqual(p, { overdueTotal: "0.00", overdueCount: 0, upcomingTotal: "0.00", upcomingCount: 0, items: [] });
  } finally { await f.cleanup(); }
});

test("MySQL: task progress counts this event only and lists open tasks by due date", { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    const t = await new DashboardRepository().tasks(f.main, TODAY);
    assert.equal(t.total, 5);
    assert.equal(t.completed, 1);
    assert.equal(t.overdue, 1);
    assert.deepEqual(
      t.nextDue.map((item) => [item.title, item.dueDate, item.assigneeDisplayName, item.assigneeRole]),
      [
        ["Send invites", "2026-06-05", "Heather", "CO_PLANNER"],
        ["Confirm florist", "2026-06-12", "Khai", "OWNER"],
        // An assignee from another event is never shown.
        ["Bad assignment", "2026-06-20", null, null],
      ],
    );
  } finally { await f.cleanup(); }
});
