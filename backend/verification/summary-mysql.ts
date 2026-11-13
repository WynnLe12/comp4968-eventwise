// Explicit disposable-local-DB checks; requires commit 3 fixtures. No Cognito needed.
import assert from "node:assert/strict";
import { AssertionError } from "node:assert";
import type { RowDataPacket } from "mysql2/promise";
import { getDatabasePool, closeDatabasePool } from "../shared/db/pool";
import { MySqlExpenseRepository } from "../expense-service/repositories/mysql-expenses";
import { ExpenseService } from "../expense-service/services/expenses";
import { ApiError } from "../expense-service/errors";

async function main(): Promise<void> {
  const pool = getDatabasePool();
  const repo = new MySqlExpenseRepository(() => pool);
  const service = new ExpenseService(repo, () => "2026-11-11");
  const owner = "expense-test-owner";
  let expenseId: string | undefined, eventId: string | undefined;
  async function insert(sql: string, values: string[]): Promise<string> {
    const connection = await pool.getConnection();
    try {
      await connection.execute(sql, values);
      const [ids] = await connection.query<RowDataPacket[]>("SELECT CAST(LAST_INSERT_ID() AS CHAR) AS id");
      return String(ids[0]!.id);
    } finally { connection.release(); }
  }
  try {
    const baseline = await service.summary("400", owner);
    assert.equal(baseline.eventBudget, "2000.00"); assert.equal(baseline.allocatedBudget, "2000.00");
    assert.equal(baseline.committedTotal, "2300.30"); assert.equal(baseline.paidTotal, "580.30");
    assert.equal(baseline.outstandingTotal, "1720.00"); assert.equal(baseline.remainingBudget, "-300.30");
    assert.equal(baseline.overdueTotal, "1420.00"); assert.equal(baseline.dueThisMonthTotal, "1620.00");
    assert.equal(baseline.isOverBudget, true); assert.equal(baseline.expenseCount, 7);
    assert.equal(baseline.openExpenseCount, 4); assert.equal(baseline.dueThisMonthCount, 3);
    assert.deepEqual(baseline.categories.map(c => c.categoryId), ["4001", "4002", "4003", "4004"]);
    assert.deepEqual(baseline.categories.map(c => [c.committedTotal, c.paidTotal, c.outstandingTotal, c.remainingBudget]), [
      ["1200.00", "200.00", "1000.00", "-200.00"], ["500.30", "300.30", "200.00", "-0.30"],
      ["600.00", "80.00", "520.00", "-100.00"], ["0.00", "0.00", "0.00", "0.00"],
    ]);
    // Vendor 4001 payments are 200 + 100 - 20, and are already included once in event totals.
    const [vendors] = await pool.execute<RowDataPacket[]>("SELECT paid_total, next_due_date FROM vendor_payment_totals WHERE event_id = '400' AND vendor_id = '4001'");
    assert.equal(vendors[0]?.paid_total, "280.00"); assert.equal(vendors[0]?.next_due_date, "2026-11-01");
    assert.equal((await service.summary("401", "expense-test-other-owner")).committedTotal, "50.00");
    await assert.rejects(service.summary("400", "expense-test-other-owner"), e => e instanceof ApiError && e.status === 403);
    await assert.rejects(service.summary("401", owner), e => e instanceof ApiError && e.status === 403);
    await service.list("400", owner, { limit: 1, offset: 1, paymentStatus: "PAID" });
    assert.deepEqual(await service.summary("400", owner), baseline);
    console.log("PASS: exact fixture/category totals, empty category, refunds, vendor consistency, event isolation and filter independence");

    const created = await service.create("400", owner, { categoryId: "4001", description: "Commit 6 temporary expense", committedAmount: "100.00", dueDate: "2026-11-10" });
    expenseId = created.expenseId;
    await service.recordPayment("400", expenseId, owner, { amount: "25.00", paidAt: "2026-11-11" });
    const afterPay = await service.summary("400", owner);
    assert.equal(afterPay.committedTotal, "2400.30"); assert.equal(afterPay.paidTotal, "605.30");
    assert.equal(afterPay.outstandingTotal, "1795.00"); assert.equal(afterPay.overdueTotal, "1495.00");
    await service.update("400", expenseId, owner, { committedAmount: "120.00", categoryId: "4002" });
    const afterEdit = await service.summary("400", owner);
    assert.equal(afterEdit.categories[0]?.committedTotal, "1200.00");
    assert.equal(afterEdit.categories[1]?.committedTotal, "620.30");
    assert.equal(afterEdit.categories[1]?.paidTotal, "325.30");
    await assert.rejects(service.remove("400", expenseId, owner),
      error => error instanceof ApiError && error.status === 409 && error.code === "HAS_PAYMENTS");
    assert.deepEqual(await service.summary("400", owner), afterEdit);
    // Only fixture cleanup bypasses the API's payment-history protection.
    await pool.execute("DELETE FROM expenses WHERE event_id = '400' AND expense_id = ?", [expenseId]);
    expenseId = undefined;
    assert.deepEqual(await service.summary("400", owner), baseline);
    console.log("PASS: summary refresh after create, payment, amount/category edit, blocked deletion and fixture cleanup");

    eventId = await insert("INSERT INTO events (name, total_budget) VALUES (?, ?)", ["Commit 6 temporary summary event", "50.00"]);
    await pool.execute("INSERT INTO event_members (event_id, cognito_sub, role) VALUES (?, ?, 'OWNER')", [eventId, owner]);
    const bare = await service.summary(eventId, owner);
    assert.equal(bare.categories.length, 0); assert.equal(bare.remainingBudget, "50.00"); assert.equal(bare.expenseCount, 0);
    const categoryId = await insert("INSERT INTO budget_categories (event_id, name, planned_amount) VALUES (?, ?, ?)", [eventId, "Temporary category", "60.00"]);
    const empty = await service.summary(eventId, owner);
    assert.equal(empty.categories.length, 1); assert.equal(empty.unallocatedBudget, "-10.00"); assert.equal(empty.isOverBudget, false);
    console.log("PASS: no-category event, empty category and over-allocation without expense overrun");

    for (const [amount, date] of [["10.00", "2026-11-30"], ["20.00", "2026-12-31"], ["30.00", "2027-01-01"], ["40.00", null]]) {
      await service.create(eventId, owner, { categoryId, description: "Calendar boundary fixture", committedAmount: amount, dueDate: date });
    }
    const december = await new ExpenseService(repo, () => "2026-12-31").summary(eventId, owner);
    assert.equal(december.overdueTotal, "10.00"); assert.equal(december.dueThisMonthTotal, "20.00"); assert.equal(december.dueThisMonthCount, 1);
    const january = await new ExpenseService(repo, () => "2027-01-01").summary(eventId, owner);
    assert.equal(january.overdueTotal, "30.00"); assert.equal(january.dueThisMonthTotal, "30.00");
    assert.equal(january.openExpenseCount, 4);
    console.log("PASS: due-today, null-date and month/year boundary calculations");

    const invalid = await service.create(eventId, owner, { categoryId, description: "Deliberate invalid-data test", committedAmount: "1.00" });
    // Deliberately bypass API only inside this temporary fixture to check invariant detection.
    await pool.execute("INSERT INTO expense_payments (expense_id, amount, paid_at, payment_type) VALUES (?, '2.00', '2026-11-01', 'PAYMENT')", [invalid.expenseId]);
    await assert.rejects(service.summary(eventId, owner), e => e instanceof ApiError && e.status === 500);
    console.log("PASS: invalid individual balance is detected even when other expenses could mask it");
  } finally {
    try {
      if (expenseId) await pool.execute("DELETE FROM expenses WHERE event_id = '400' AND expense_id = ?", [expenseId]);
      if (eventId) {
        // Remove expense RESTRICT relationships first; event cascades the remaining temporary data.
        await pool.execute("DELETE FROM expenses WHERE event_id = ?", [eventId]);
        await pool.execute("DELETE FROM events WHERE event_id = ?", [eventId]);
      }
    } finally { await closeDatabasePool(); }
  }
  console.log("All MySQL summary integration checks passed; temporary records cleaned up.");
}
void main().catch(error => {
  if (error instanceof ApiError) console.error(`${error.code}: ${error.message}`);
  else if (error instanceof AssertionError) console.error(`Summary integration assertion failed: ${error.message}`);
  else console.error("Summary integration check failed. Check MySQL connection and unchanged commit 3 fixtures.");
  process.exitCode = 1;
});
