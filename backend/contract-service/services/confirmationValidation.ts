import { ApiError, invalid } from "../../expense-service/errors";
import { cents, parseExpenseBody, parseId } from "../../expense-service/services/validation";
import type { ExpenseInput } from "../../expense-service/types";
import { prepareVendor } from "../../vendor-service/services/prepareVendor";
import { NEW_VENDOR, type VendorFields } from "../../vendor-service/types";
import type { DraftFields } from "../types";

/** The MVP confirms dollar amounts directly; currency selection and conversion are out of scope. */
export function prepareNewExpense(draft: DraftFields, createVendor = false): ExpenseInput {
  if (draft.saveAction !== "CREATE_EXPENSE") {
    invalid("saveAction", "Choose Create new expense.");
  }
  if (draft.targetExpenseId !== null) invalid("targetExpenseId", "Clear the existing expense selection before creating a new expense.");
  return prepareExpenseValues(draft, createVendor);
}

export function prepareExistingExpense(draft: DraftFields, createVendor = false): ExpenseInput {
  if (draft.saveAction !== "UPDATE_EXPENSE") invalid("saveAction", "Choose Update existing expense.");
  parseId(draft.targetExpenseId, "targetExpenseId");
  return prepareExpenseValues(draft, createVendor);
}

function prepareExpenseValues(draft: DraftFields, createVendor: boolean): ExpenseInput {
  if (createVendor) prepareNewVendor(draft);
  else if (draft.vendorId === null && draft.vendorName !== null) {
    invalid("vendorId", "Choose an existing vendor, create a new vendor, or clear the vendor name to save without a vendor.");
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

export function prepareNewVendor(draft: DraftFields, categoryName: string | null = null): VendorFields {
  if (draft.vendorId !== null) invalid("vendorId", "Choose either an existing vendor or Create new vendor.");
  const prepared = prepareVendor(NEW_VENDOR, { name: draft.vendorName, category: categoryName });
  if (!prepared.ok) {
    if (prepared.fields.name) invalid("vendorName", prepared.fields.name);
    invalid("categoryId", "Choose a valid category for this vendor.");
  }
  return prepared.vendor;
}
