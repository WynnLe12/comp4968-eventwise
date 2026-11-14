// Booking and contract status rules (docs/api/vendors.md).
//
// Takes the vendor as it is now and the requested changes, applies the automatic
// changes, then reports any combination that isn't allowed. Each check mirrors a
// CHECK constraint on the vendors table, so a vendor that passes here also passes there.
// Contract extraction (Feature 15) should call this same function before saving a vendor.
import type { FieldErrors, VendorChanges, VendorDraft } from "../types";

/** A contract that has been sent or signed. */
const ACTIVE_CONTRACT: readonly unknown[] = ["PENDING", "SIGNED"];

export interface StatusRulesResult {
  /** The vendor as it will be saved, with the automatic changes applied. */
  next: VendorDraft;
  /** Rule violations, by field. Empty when the combination is allowed. */
  fields: FieldErrors;
}

export function applyStatusRules(
  current: VendorDraft,
  changes: VendorChanges,
): StatusRulesResult {
  const next: VendorDraft = { ...current, ...changes };
  const fields: FieldErrors = {};

  // 1. Moving back to Researching clears the quote and the contract,
  //    unless the contract is still pending or signed.
  const movingToResearching =
    changes.bookingStatus === "RESEARCHING" &&
    current.bookingStatus !== "RESEARCHING";
  if (movingToResearching) {
    if (ACTIVE_CONTRACT.includes(next.contractStatus)) {
      fields.bookingStatus = "Cancel the contract first";
      next.bookingStatus = current.bookingStatus; // keep the other checks from piling on
    } else {
      next.contractStatus = "NOT_STARTED";
      // Clear only what the request didn't set. A quote sent together with
      // Researching is a contradiction, and the checks below report it.
      if (!("quoteAmount" in changes)) next.quoteAmount = null;
      if (!("contractTotal" in changes)) next.contractTotal = null;
    }
  }

  // 2. Entering a quote on a Researching vendor makes it Quoted
  //    (unless the request is itself moving the vendor to Researching).
  if (
    next.bookingStatus === "RESEARCHING" &&
    next.quoteAmount != null &&
    !movingToResearching
  ) {
    next.bookingStatus = "QUOTED";
  }

  // 3. Signing a contract makes a Quoted vendor Booked. Only when the contract
  //    becomes signed now, so a signed vendor can't be silently re-booked.
  if (
    changes.contractStatus === "SIGNED" &&
    current.contractStatus !== "SIGNED" &&
    next.bookingStatus === "QUOTED"
  ) {
    next.bookingStatus = "BOOKED";
  }

  // 4. Combinations that are never allowed. The first problem per field wins.
  if (next.quoteAmount != null && next.bookingStatus === "RESEARCHING") {
    fields.quoteAmount ??= "Researching vendors can't have a quote yet";
  }
  if (next.contractTotal != null && next.contractStatus === "NOT_STARTED") {
    fields.contractTotal ??= "Add a contract first";
  }
  if (
    next.contractStatus !== "NOT_STARTED" &&
    next.bookingStatus === "RESEARCHING"
  ) {
    fields.contractStatus ??= "Researching vendors can't have a contract";
  }
  const activeContractNotAllowed =
    ACTIVE_CONTRACT.includes(next.contractStatus) &&
    next.bookingStatus !== "QUOTED" &&
    next.bookingStatus !== "BOOKED";
  const signedButNotBooked =
    next.contractStatus === "SIGNED" && next.bookingStatus !== "BOOKED";
  if (activeContractNotAllowed || signedButNotBooked) {
    // Report it under the field the request changed: signing a Declined vendor is a
    // contract problem; declining a signed vendor is a booking problem.
    const contractChanged =
      "contractStatus" in changes &&
      changes.contractStatus !== current.contractStatus;
    if (contractChanged) {
      fields.contractStatus ??=
        "Only quoted or booked vendors can have an active contract";
    } else if (next.contractStatus === "SIGNED") {
      fields.bookingStatus ??=
        "A vendor with a signed contract is booked. Cancel the contract first";
    } else {
      fields.bookingStatus ??= "Cancel the contract first";
    }
  }

  return { next, fields };
}
