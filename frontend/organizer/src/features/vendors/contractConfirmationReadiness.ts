import type { ContractDraftDetails } from "./contractsApi";
import { contractDraftFormValues, prepareContractDraftChanges } from "./contractDraftValidation";

/** Confirmation uses only the saved draft. The backend remains authoritative. */
export function contractDraftConfirmationIssues(draft: ContractDraftDetails): string[] {
  const issues: string[] = [];
  if (draft.status !== "DRAFT") issues.push("Only a draft awaiting review can be confirmed.");
  if (draft.saveAction !== "CREATE_EXPENSE" || draft.targetExpenseId !== null) issues.push("Updating an existing expense is not available from this screen yet.");
  if (!draft.description?.trim()) issues.push("Add an expense name.");
  if (!draft.categoryId) issues.push("Choose a budget category.");
  if (draft.totalAmount === null) issues.push("Enter the total amount.");
  if (!draft.documentId) issues.push("The source document is unavailable.");
  if (!draft.vendorId && draft.vendorName) issues.push("Choose an existing vendor, or clear the unlinked vendor name to save without a vendor. Creating a vendor from this screen is not available yet.");
  const { errors } = prepareContractDraftChanges(contractDraftFormValues(draft), draft);
  for (const message of Object.values(errors)) if (message) issues.push(message);
  return [...new Set(issues)];
}
