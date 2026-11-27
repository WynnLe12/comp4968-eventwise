import type { ContractExtractionResult } from "./contractsApi";

export function contractExtractionFeedback(result: ContractExtractionResult): string {
  const labels = { vendorName: "vendor name", totalAmount: "total amount", depositAmount: "deposit requirement", dueDate: "due date" };
  const messages = [result.appliedFields.length ? "Filled in " + result.appliedFields.map(field => labels[field]).join(", ") + "." : "No new details were filled in."];
  if (result.skippedFields.length) messages.push("Your saved details were kept.");
  if (result.warnings.some(warning => warning.code === "VENDOR_FROM_HEADER")) messages.push("Check the vendor name against the document heading.");
  if (result.warnings.some(warning => warning.code === "PARTIAL_TEXT")) messages.push("Some pages had no readable text. Check the full document manually.");
  if (result.warnings.some(warning => ["CONFLICTING_VALUES", "AMBIGUOUS_VALUE", "AMOUNT_CONFLICT"].includes(warning.code))) messages.push("Some details need manual review because the values were unclear or conflicting.");
  messages.push("Review the draft before confirming. No expense or payment was created.");
  return messages.join(" ");
}
