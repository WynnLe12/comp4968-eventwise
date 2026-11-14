// Explicit opt-in integration check: npm run test:db. Requires commit 3 local fixtures.
// Creates temporary expenses under reserved event 400 and cleans them up afterward.
import assert from "node:assert/strict";
import type { RowDataPacket } from "mysql2/promise";
import { getDatabasePool, closeDatabasePool } from "../shared/db/pool";
import { MySqlExpenseRepository } from "../expense-service/repositories/mysql-expenses";
import { ExpenseService } from "../expense-service/services/expenses";
import { ApiError } from "../expense-service/errors";

async function main(): Promise<void> {
  const pool = getDatabasePool();
  const service = new ExpenseService(new MySqlExpenseRepository(() => pool), () => "2026-11-11");
  const owner = "expense-test-owner";
  let createdId: string | undefined;
  let unpaidId: string | undefined;
  try {
    const listed = await service.list("400", owner, { limit: 100, offset: 0 });
    assert.ok(listed.data.some(row => row.expenseId === "4001"), "Load commit 3 fixtures first.");
    assert.equal((await service.get("400", "4007", owner)).paidTotal, "80.00");
    assert.equal((await service.get("400", "4006", owner)).paidTotal, "0.30");
    await assert.rejects(service.get("400", "4001", "expense-test-other-owner"), e => e instanceof ApiError && e.status === 403);
    await assert.rejects(service.get("400", "4010", owner), e => e instanceof ApiError && e.status === 404);
    await assert.rejects(service.create("400", owner, { categoryId: "4010", description: "Invalid", committedAmount: "1.00" }), e => e instanceof ApiError && e.status === 422);
    await assert.rejects(service.create("400", owner, { categoryId: "4001", vendorId: "4010", description: "Invalid", committedAmount: "1.00" }), e => e instanceof ApiError && e.status === 422);
    const created = await service.create("400", owner, { categoryId: "4001", vendorId: "4001", description: "CRUD integration 100%_literal", committedAmount: "10.00", dueDate: "2026-11-10" });
    createdId = created.expenseId;
    assert.equal(created.paidTotal, "0.00");
    // Test payment-history protection and amount reduction using an isolated temporary row.
    // Payment API implementation belongs to commit 5.
    await pool.execute("INSERT INTO expense_payments (expense_id, amount, paid_at, payment_type) VALUES (?, '2.00', '2026-11-01', 'DEPOSIT')", [createdId]);
    assert.equal((await service.get("400", createdId, owner)).outstandingAmount, "8.00");
    await assert.rejects(service.update("400", createdId, owner, { committedAmount: "1.99" }), e => e instanceof ApiError && e.status === 409);
    const updated = await service.update("400", createdId, "expense-test-planner", { committedAmount: "12.00", dueDate: null, vendorId: null });
    assert.equal(updated.committedAmount, "12.00"); assert.equal(updated.dueDate, null); assert.equal(updated.vendorId, null);
    const literal = await service.list("400", owner, { limit: 100, offset: 0, q: "%_literal" });
    assert.ok(literal.data.some(row => row.expenseId === createdId));
    const overdue = await service.list("400", owner, { limit: 100, offset: 0, overdue: true });
    assert.ok(overdue.data.every(row => row.isOverdue));
    const notOverdue = await service.list("400", owner, { limit: 100, offset: 0, overdue: false });
    assert.ok(notOverdue.data.some(row => row.expenseId === createdId), "Null due dates are not overdue.");
    const noRows = await service.list("400", owner, { limit: 1, offset: 100000 });
    assert.equal(noRows.data.length, 0); assert.ok(noRows.total >= 8);
    await assert.rejects(service.remove("400", createdId, owner),
      error => error instanceof ApiError && error.status === 409 && error.code === "HAS_PAYMENTS");
    const [payments] = await pool.execute<RowDataPacket[]>("SELECT payment_id FROM expense_payments WHERE expense_id = ?", [createdId]);
    assert.equal(payments.length, 1, "Blocked deletion must preserve payment history.");
    assert.equal((await service.get("400", createdId, owner)).paidTotal, "2.00");
    // A matching refund must still block deletion at a zero net paid balance.
    await pool.execute("INSERT INTO expense_payments (expense_id, amount, paid_at, payment_type) VALUES (?, '2.00', '2026-11-02', 'REFUND')", [createdId]);
    assert.equal((await service.get("400", createdId, owner)).paidTotal, "0.00");
    await assert.rejects(service.remove("400", createdId, owner),
      error => error instanceof ApiError && error.status === 409 && error.code === "HAS_PAYMENTS");
    const [preserved] = await pool.execute<RowDataPacket[]>("SELECT payment_id FROM expense_payments WHERE expense_id = ?", [createdId]);
    assert.equal(preserved.length, 2);
    const unpaid = await service.create("400", owner, { categoryId: "4001", description: "Unpaid delete verification", committedAmount: "1.00" });
    unpaidId = unpaid.expenseId;
    await service.remove("400", unpaid.expenseId, owner);
    unpaidId = undefined;
    await assert.rejects(service.get("400", unpaid.expenseId, owner), e => e instanceof ApiError && e.status === 404);
    console.log("MySQL expense CRUD checks passed (including access, associations, filters, precision and payment history protection).");
  } finally {
    try {
      if (unpaidId) await pool.execute("DELETE FROM expenses WHERE event_id = ? AND expense_id = ?", ["400", unpaidId]);
      if (createdId) await pool.execute("DELETE FROM expenses WHERE event_id = '400' AND expense_id = ?", [createdId]);
    } finally { await closeDatabasePool(); }
  }
}
void main().catch(error => {
  console.error(error instanceof ApiError ? `${error.code}: ${error.message}` : "MySQL integration check failed. Check the connection and commit 3 fixtures.");
  process.exitCode = 1;
});
