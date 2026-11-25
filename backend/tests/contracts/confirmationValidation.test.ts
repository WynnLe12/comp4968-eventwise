import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../../expense-service/errors";
import { prepareNewExpense } from "../../contract-service/services/confirmationValidation";
import type { DraftFields } from "../../contract-service/types";

const reviewed: DraftFields = {
  description: "DJ contract", categoryId: "9007199254740993", vendorId: "9007199254740994",
  vendorName: "Extracted DJ", totalAmount: "600.10", depositAmount: "100.05",
  dueDate: "2026-12-20", currencyCode: "USD", saveAction: "CREATE_EXPENSE", targetExpenseId: null,
};
const invalid = (field: string) => (error: unknown) =>
  error instanceof ApiError && error.status === 422 && Boolean(error.fields?.[field]);

test("reviewed contracts create exact expense inputs without creating a payment from the deposit", () => {
  assert.deepEqual(prepareNewExpense(reviewed), {
    description: "DJ contract", categoryId: "9007199254740993", vendorId: "9007199254740994",
    committedAmount: "600.10", dueDate: "2026-12-20",
  });
  assert.equal(prepareNewExpense({ ...reviewed, vendorId: null, vendorName: null, dueDate: null }).vendorId, null);
  assert.equal(prepareNewExpense({ ...reviewed, totalAmount: "0.00", depositAmount: "0.00" }).committedAmount, "0.00");
  assert.equal(prepareNewExpense({ ...reviewed, totalAmount: "9999999999.99" }).committedAmount, "9999999999.99");
});

test("confirmation requires complete reviewed fields and a real calendar date", () => {
  for (const [field, values] of [
    ["description", [null, "", " ", "x".repeat(256)]], ["categoryId", [null, "0", "01"]],
    ["totalAmount", [null, "-1.00", "0.001", "10000000000.00"]], ["dueDate", ["2026-02-29"]],
  ] as const) {
    for (const value of values) assert.throws(() => prepareNewExpense({ ...reviewed, [field]: value }), invalid(field));
  }
  assert.throws(() => prepareNewExpense({ ...reviewed, depositAmount: "600.11" }), invalid("depositAmount"));
});

test("confirmation cannot silently convert currency or discard an unlinked vendor name", () => {
  for (const currencyCode of [null, "CAD", "EUR"]) {
    assert.throws(() => prepareNewExpense({ ...reviewed, currencyCode }), invalid("currencyCode"));
  }
  assert.throws(() => prepareNewExpense({ ...reviewed, vendorId: null }), invalid("vendorId"));
});

test("new-expense confirmation never treats an update selection as a request for a second expense", () => {
  assert.throws(() => prepareNewExpense({ ...reviewed, saveAction: "UPDATE_EXPENSE", targetExpenseId: "10" }),
    error => error instanceof ApiError && error.code === "SAVE_ACTION_UNAVAILABLE");
  assert.throws(() => prepareNewExpense({ ...reviewed, targetExpenseId: "10" }), invalid("targetExpenseId"));
});
