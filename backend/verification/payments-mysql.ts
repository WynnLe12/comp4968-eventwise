// Explicit disposable-local-DB integration check; does not need Cognito.
import assert from "node:assert/strict";
import { AssertionError } from "node:assert";
import { getDatabasePool, closeDatabasePool } from "../shared/db/pool";
import { readDatabaseConfig } from "../shared/db/config";
import { MySqlExpenseRepository } from "../expense-service/repositories/mysql-expenses";
import { ExpenseService } from "../expense-service/services/expenses";
import { ApiError } from "../expense-service/errors";

async function main(): Promise<void> {
  if (readDatabaseConfig().connectionLimit < 2) throw new Error("Concurrency verification requires DB_CONNECTION_LIMIT >= 2.");
  const pool = getDatabasePool();
  const repository = new MySqlExpenseRepository(() => pool);
  const service = new ExpenseService(repository, () => "2026-11-11");
  const owner = "expense-test-owner";
  const createdIds: string[] = [];
  const payment = (amount: string) => ({ amount, paidAt: "2026-11-11" });
  const create = async (amount = "100.00") => {
    const expense = await service.create("400", owner, { categoryId: "4001", vendorId: null,
      description: "Commit 5 temporary integration expense", committedAmount: amount, dueDate: "2026-11-10" });
    createdIds.push(expense.expenseId);
    return expense.expenseId;
  };
  try {
    // Read existing fixture refunds without altering them.
    const refunds = await service.listPayments("400", "4007", owner, { limit: 50, offset: 0 });
    assert.ok(refunds.data.some(p => p.paymentType === "REFUND" && p.amount === "20.00"));
    assert.equal((await service.get("400", "4007", owner)).paidTotal, "80.00");
    const id = await create();
    const deposit = await service.recordPayment("400", id, owner, { ...payment("20.00"), paymentType: "DEPOSIT", notes: "Test deposit" });
    assert.equal(deposit.expense.paidTotal, "20.00"); assert.equal(deposit.expense.outstandingAmount, "80.00");
    assert.equal(deposit.payment.paymentType, "DEPOSIT");
    const paid = await service.recordPayment("400", id, "expense-test-planner", payment("80.00"));
    assert.equal(paid.expense.paymentStatus, "PAID"); assert.equal(paid.expense.isOverdue, false);
    assert.equal(paid.expense.committedAmount, "100.00");
    await assert.rejects(service.recordPayment("400", id, owner, payment("0.01")), e => e instanceof ApiError && e.code === "PAYMENT_EXCEEDS_BALANCE");
    const history = await service.listPayments("400", id, owner, { limit: 1, offset: 0 });
    assert.equal(history.total, 2); assert.equal(history.data[0]?.amount, "80.00");
    assert.ok(BigInt(history.data[0]!.paymentId) > BigInt(deposit.payment.paymentId));
    assert.equal((await service.listPayments("400", id, owner, { limit: 1, offset: 1 })).data[0]?.amount, "20.00");
    assert.equal((await service.listPayments("400", id, owner, { limit: 1, offset: 99 })).data.length, 0);
    await assert.rejects(service.recordPayment("400", id, "expense-test-other-owner", payment("1.00")), e => e instanceof ApiError && e.status === 403);
    await assert.rejects(service.listPayments("400", id, "expense-test-other-owner", { limit: 50, offset: 0 }), e => e instanceof ApiError && e.status === 403);
    await assert.rejects(service.recordPayment("400", "4010", owner, payment("1.00")), e => e instanceof ApiError && e.status === 404);
    await assert.rejects(service.listPayments("400", "4010", owner, { limit: 50, offset: 0 }), e => e instanceof ApiError && e.status === 404);
    console.log("PASS: deposits, completion, history order/pagination, refunds and access checks");

    const centId = await create("0.30");
    await service.recordPayment("400", centId, owner, payment("0.10"));
    assert.equal((await service.recordPayment("400", centId, owner, payment("0.20"))).expense.paidTotal, "0.30");
    const zeroId = await create("0.00");
    await assert.rejects(service.recordPayment("400", zeroId, owner, payment("0.01")), e => e instanceof ApiError && e.status === 409);
    console.log("PASS: exact-cent arithmetic and zero-commitment protection");

    const rollbackId = await create();
    const sentinel = new ApiError(500, "TEST_ROLLBACK", "Deliberate rollback check.");
    await assert.rejects(repository.transaction(async tx => {
      await tx.assertMember("400", owner);
      await tx.find("400", rollbackId, true);
      await tx.createPayment("400", rollbackId, { amount: "25.00", paidAt: "2026-11-11", paymentType: "PAYMENT", notes: null });
      throw sentinel;
    }), error => error === sentinel);
    assert.equal((await service.listPayments("400", rollbackId, owner, { limit: 50, offset: 0 })).total, 0);
    assert.equal((await service.get("400", rollbackId, owner)).paidTotal, "0.00");
    console.log("PASS: real MySQL rollback removes an inserted payment");

    for (let iteration = 0; iteration < 5; iteration++) {
      const concurrentId = await create();
      const results = await Promise.allSettled([
        service.recordPayment("400", concurrentId, owner, payment("60.00")),
        service.recordPayment("400", concurrentId, "expense-test-planner", payment("60.00")),
      ]);
      assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
      const rejected = results.find(r => r.status === "rejected");
      assert.ok(rejected?.status === "rejected" && rejected.reason instanceof ApiError && rejected.reason.code === "PAYMENT_EXCEEDS_BALANCE");
      assert.equal((await service.get("400", concurrentId, owner)).paidTotal, "60.00");
      assert.equal((await service.listPayments("400", concurrentId, owner, { limit: 50, offset: 0 })).total, 1);
    }
    console.log("PASS: five concurrent payment races never exceed the balance");

    const editId = await create();
    const race = await Promise.allSettled([
      service.recordPayment("400", editId, owner, payment("80.00")),
      service.update("400", editId, "expense-test-planner", { committedAmount: "50.00" }),
    ]);
    assert.equal(race.filter(r => r.status === "fulfilled").length, 1);
    const loser = race.find(r => r.status === "rejected");
    assert.ok(loser?.status === "rejected" && loser.reason instanceof ApiError &&
      ["PAYMENT_EXCEEDS_BALANCE", "AMOUNT_BELOW_PAID"].includes(loser.reason.code));
    const final = await service.get("400", editId, owner);
    assert.ok((final.committedAmount === "100.00" && final.paidTotal === "80.00") ||
      (final.committedAmount === "50.00" && final.paidTotal === "0.00"));
    console.log("PASS: concurrent expense reduction and payment preserve the balance invariant");
  } finally {
    try {
      // Only generated expense IDs from this run; never reset baseline fixtures.
      for (const id of createdIds) await pool.execute("DELETE FROM expenses WHERE event_id = '400' AND expense_id = ?", [id]);
    } finally { await closeDatabasePool(); }
  }
  console.log("All MySQL payment integration checks passed; temporary expenses cleaned up.");
}
void main().catch(error => {
  if (error instanceof ApiError) console.error(`${error.code}: ${error.message}`);
  else if (error instanceof AssertionError) console.error(`Payment integration assertion failed: ${error.message}`);
  else console.error("Payment integration check failed. Check MySQL, commit 3 fixtures, and DB_CONNECTION_LIMIT >= 2.");
  process.exitCode = 1;
});
