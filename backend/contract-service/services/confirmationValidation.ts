import { ApiError, invalid } from "../../expense-service/errors";
import { cents, parseExpenseBody } from "../../expense-service/services/validation";
import type { ExpenseInput } from "../../expense-service/types";
import type { DraftFields } from "../types";

/** Match the existing USD expense ledger; never infer a conversion from a contract. */
export function prepareNewExpense(draft: DraftFields): ExpenseInput {
  if (draft.saveAction !== "CREATE_EXPENSE") {
    throw new ApiError(409, "SAVE_ACTION_UNAVAILABLE", "Updating an existing expense is not available yet.");
  }
  if (draft.targetExpenseId !== null) invalid("targetExpenseId", "Clear the existing expense selection before creating a new expense.");
  if (draft.currencyCode !== "USD") invalid("currencyCode", "Confirm the amount in USD before saving to expenses.");
  if (draft.vendorId === null && draft.vendorName !== null) {
    invalid("vendorId", "Choose an existing vendor, or clear the vendor name to save without a vendor.");
  }
  let expense: ExpenseInput;
  try {
    expense = parseExpenseBody({
      categoryId: draft.categoryId, vendorId: draft.vendorId, description: draft.description,
      committedAmount: draft.totalAmount, dueDate: draft.dueDate,
    }, false) as ExpenseInput;
  } catch (error) {
    if (error instanceof ApiError && error.fields?.committedAmount) {
      invalid("totalAmount", "Enter the contract total as an amount of 0 or more, with 2 decimal places.");
    }
    throw error;
  }
  if (draft.depositAmount !== null && cents(draft.depositAmount) > cents(expense.committedAmount)) {
    invalid("depositAmount", "The deposit cannot exceed the contract total.");
  }
  return expense;
}
