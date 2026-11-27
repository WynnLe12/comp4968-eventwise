import { cents } from "../../expense-service/services/validation";
import type { Draft } from "../types";
import { parseDraftPatch } from "../services/draftValidation";
import type { ContractFieldSuggestions, SuggestedField } from "./contractFieldSuggestions";

export interface ExtractionFill {
  changes: Partial<Pick<Draft, SuggestedField>>;
  appliedFields: SuggestedField[];
  skippedFields: SuggestedField[];
  warnings: (ContractFieldSuggestions["warnings"][number] | { field: SuggestedField; code: "SAVED_VALUE_KEPT" | "LINKED_VENDOR_KEPT" | "AMOUNT_CONFLICT" })[];
}

/** Missing suggestions never clear saved values; manually linked vendors are never replaced. */
export function draftExtractionPatch(draft: Draft, suggestions: ContractFieldSuggestions): ExtractionFill {
  const checked = parseDraftPatch({ version: draft.version, vendorName: suggestions.fields.vendorName,
    totalAmount: suggestions.fields.totalAmount, depositAmount: suggestions.fields.depositAmount, dueDate: suggestions.fields.dueDate }).changes;
  const changes: ExtractionFill["changes"] = {};
  const skipped = new Set<SuggestedField>();
  const warnings: ExtractionFill["warnings"] = [...suggestions.warnings];
  const skip = (field: SuggestedField, code: "SAVED_VALUE_KEPT" | "LINKED_VENDOR_KEPT" | "AMOUNT_CONFLICT") => {
    skipped.add(field); warnings.push({ field, code }); delete changes[field];
  };
  for (const field of ["vendorName", "totalAmount", "depositAmount", "dueDate"] as const) {
    const value = checked[field];
    if (value === null || value === undefined) continue;
    if (field === "vendorName" && draft.vendorId !== null) { skip(field, "LINKED_VENDOR_KEPT"); continue; }
    if (draft[field] !== null && !(field === "vendorName" && !draft.vendorName?.trim())) { skip(field, "SAVED_VALUE_KEPT"); continue; }
    changes[field] = value;
  }
  const total = changes.totalAmount ?? draft.totalAmount;
  const deposit = changes.depositAmount ?? draft.depositAmount;
  if (total !== null && deposit !== null && cents(deposit) > cents(total)) {
    if (changes.depositAmount !== undefined) skip("depositAmount", "AMOUNT_CONFLICT");
    else if (changes.totalAmount !== undefined) skip("totalAmount", "AMOUNT_CONFLICT");
  }
  return { changes, appliedFields: Object.keys(changes) as SuggestedField[], skippedFields: [...skipped], warnings };
}
