// Turns a request body into the vendor that will be saved: clean the input,
// apply the status rules, then validate the result. Pure: no database, no AWS.
// The vendor service throws a 422 VALIDATION_ERROR with 'fields' when ok is false.
import type { FieldErrors, VendorDraft, VendorFields } from "../types";
import { applyStatusRules } from "./statusRules";
import { cleanInput, validateFields } from "./validation";

export type PrepareResult =
  | { ok: true; vendor: VendorFields }
  | { ok: false; fields: FieldErrors };

/**
 * @param current the vendor as stored now, or NEW_VENDOR for a create
 * @param body    the parsed request body (POST: all fields; PATCH: only the changes)
 */
export function prepareVendor(
  current: VendorDraft | VendorFields,
  body: unknown,
): PrepareResult {
  const { next, fields: ruleErrors } = applyStatusRules(
    current,
    cleanInput(body),
  );
  // A field error (e.g. an invalid status value) is more useful than a rule error on the same field.
  const fields: FieldErrors = { ...ruleErrors, ...validateFields(next) };

  if (Object.keys(fields).length > 0) return { ok: false, fields };
  // validateFields has checked every field's type and value, so the cast is safe.
  return { ok: true, vendor: next as unknown as VendorFields };
}
