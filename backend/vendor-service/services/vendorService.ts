// What each vendor route does: load, apply the rules, save, read back.
// Throws ApiError for every expected failure (docs/api/vendors.md 5–6).
//
// The expense -> vendor link (same event) is checked by the expenses repository
// inside its own transaction, so this module doesn't export a check for it.
import { ApiError } from "../../expense-service/errors";
import * as repo from "../repositories/vendorRepository";
import {
  NEW_VENDOR,
  type FieldErrors,
  type VendorDraft,
  type VendorFields,
} from "../types";
import { prepareVendor } from "./prepareVendor";
import { editableFields, toVendor, type Vendor } from "./vendorMapper";

const MYSQL_CHECK_VIOLATED = 3819; // ER_CHECK_CONSTRAINT_VIOLATED
const MYSQL_ROW_IS_REFERENCED = 1451; // ER_ROW_IS_REFERENCED_2: delete blocked by a foreign key

const validationError = (fields: FieldErrors | Record<string, string>) =>
  new ApiError(
    422,
    "VALIDATION_ERROR",
    "Check the submitted fields.",
    fields as Record<string, string>,
  );
const notFound = () => new ApiError(404, "NOT_FOUND", "Vendor not found.");
const signedContract = () =>
  new ApiError(
    409,
    "SIGNED_CONTRACT",
    "This vendor has a signed contract. Mark it as cancelled instead.",
  );
const hasExpenses = () =>
  new ApiError(
    409,
    "HAS_EXPENSES",
    "Remove this vendor's expenses before deleting it.",
  );

function mysqlErrno(error: unknown): number | undefined {
  const errno = (error as { errno?: unknown } | null)?.errno;
  return typeof errno === "number" ? errno : undefined;
}

/**
 * The field and message for each vendors CHECK constraint. The status rules should stop
 * every bad row first; this only runs if one slips past them (MySQL error 3819).
 */
const CHECK_FIELDS: Record<string, Record<string, string>> = {
  chk_vendor_quote: {
    quoteAmount: "Enter an amount of 0 or more, with up to 2 decimals",
  },
  chk_vendor_contract_total: {
    contractTotal: "Enter an amount of 0 or more, with up to 2 decimals",
  },
  chk_vendor_total_needs_contract: { contractTotal: "Add a contract first" },
  chk_vendor_researching: {
    bookingStatus: "Researching vendors can't have a quote or contract",
  },
  chk_vendor_active_contract: {
    contractStatus: "Only quoted or booked vendors can have an active contract",
  },
  chk_vendor_signed_is_booked: {
    bookingStatus:
      "A vendor with a signed contract is booked. Cancel the contract first",
  },
};

/** Turns a CHECK constraint failure into 422; any other error is rethrown unchanged. */
function checkViolationAs422(error: unknown): never {
  if (mysqlErrno(error) === MYSQL_CHECK_VIOLATED) {
    const message = error instanceof Error ? error.message : "";
    const name = /constraint '([^']+)'/i.exec(message)?.[1] ?? "";
    throw validationError(
      CHECK_FIELDS[name] ?? {
        bookingStatus: "This status combination isn't allowed",
      },
    );
  }
  throw error;
}

/** Clean, apply the status rules and validate. 422 with every field problem if anything is wrong. */
function prepare(
  current: VendorDraft | VendorFields,
  body: unknown,
): VendorFields {
  const result = prepareVendor(current, body);
  if (!result.ok) throw validationError(result.fields);
  return result.vendor;
}

export async function listVendors(eventId: string): Promise<Vendor[]> {
  return (await repo.listVendors(eventId)).map(toVendor);
}

/** @param vendorId null when the path ID isn't a valid ID: that's a 404 too. */
export async function getVendor(
  eventId: string,
  vendorId: string | null,
): Promise<Vendor> {
  const row =
    vendorId === null ? null : await repo.findVendor(eventId, vendorId);
  if (!row) throw notFound();
  return toVendor(row);
}

export async function createVendor(
  eventId: string,
  body: unknown,
): Promise<Vendor> {
  const vendor = prepare(NEW_VENDOR, body);
  const id = await repo
    .insertVendor(eventId, vendor)
    .catch(checkViolationAs422);
  return getVendor(eventId, id);
}

export async function updateVendor(
  eventId: string,
  vendorId: string | null,
  body: unknown,
): Promise<Vendor> {
  const current = await getVendor(eventId, vendorId); // 404 first, before any validation
  const vendor = prepare(editableFields(current), body);
  await repo
    .updateVendor(eventId, current.id, vendor)
    .catch(checkViolationAs422);
  return getVendor(eventId, current.id);
}

export async function deleteVendor(
  eventId: string,
  vendorId: string | null,
): Promise<void> {
  const current = await getVendor(eventId, vendorId);
  if (current.bookingStatus === "BOOKED" && current.contractStatus === "SIGNED")
    throw signedContract();
  if (await repo.vendorHasExpenses(eventId, current.id)) throw hasExpenses();
  try {
    await repo.deleteVendor(eventId, current.id);
  } catch (error) {
    // The foreign key catches an expense added between the check and the delete.
    if (mysqlErrno(error) === MYSQL_ROW_IS_REFERENCED) throw hasExpenses();
    throw error;
  }
}
