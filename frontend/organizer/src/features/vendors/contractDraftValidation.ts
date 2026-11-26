import type { ContractDraftChanges, ContractDraftDetails } from "./contractsApi";

export type ContractDraftFormValues = Record<keyof Required<ContractDraftChanges>, string>;
export type ContractDraftFormErrors = Partial<Record<keyof ContractDraftFormValues, string>>;
const fields = ["description", "categoryId", "vendorId", "vendorName", "totalAmount", "depositAmount", "dueDate", "currencyCode"] as const;

export function contractDraftFormValues(draft: ContractDraftDetails): ContractDraftFormValues {
  return Object.fromEntries(fields.map(field => [field, draft[field] ?? ""])) as ContractDraftFormValues;
}

export function prepareContractDraftChanges(values: ContractDraftFormValues, draft: ContractDraftDetails) {
  const errors: ContractDraftFormErrors = {};
  const normalized: Record<string, string | null> = {};
  for (const field of fields) normalized[field] = values[field].trim() || null;
  if (values.description.trim().length > 255) errors.description = "Use up to 255 characters.";
  if (values.vendorName.trim().length > 150) errors.vendorName = "Use up to 150 characters.";
  for (const field of ["totalAmount", "depositAmount"] as const) {
    const raw = values[field].trim();
    if (!raw) continue;
    if (!/^(0|[1-9][0-9]{0,9})(\.[0-9]{1,2})?$/.test(raw)) {
      errors[field] = "Enter an amount of 0 or more, with up to 2 decimals.";
    } else {
      const [whole, fraction = ""] = raw.split(".");
      normalized[field] = whole + "." + fraction.padEnd(2, "0");
    }
  }
  if (!errors.totalAmount && !errors.depositAmount && normalized.totalAmount && normalized.depositAmount) {
    const cents = (value: string) => BigInt(value.replace(".", ""));
    if (cents(normalized.depositAmount) > cents(normalized.totalAmount)) errors.depositAmount = "The deposit cannot exceed the total amount.";
  }
  if (normalized.currencyCode) {
    normalized.currencyCode = normalized.currencyCode.toUpperCase();
    if (!/^[A-Z]{3}$/.test(normalized.currencyCode)) errors.currencyCode = "Enter a three-letter currency code, such as USD.";
  }
  if (normalized.dueDate) {
    const raw = normalized.dueDate;
    const date = new Date(raw + "T00:00:00Z");
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(raw) || raw.slice(0, 4) < "1000" || !Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== raw) errors.dueDate = "Enter a valid date.";
  }
  for (const field of ["categoryId", "vendorId"] as const) {
    const id = normalized[field];
    if (id && (!/^[1-9][0-9]{0,19}$/.test(id) || BigInt(id) > 18446744073709551615n)) errors[field] = "Choose a record from this event.";
  }
  const changes: ContractDraftChanges = {};
  for (const field of fields) if (normalized[field] !== draft[field]) changes[field] = normalized[field];
  return { errors, changes };
}
