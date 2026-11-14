import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { NEW_VENDOR, type FieldErrors, type VendorDraft, type VendorFields } from "../../vendor-service/types";
import { prepareVendor } from "../../vendor-service/services/prepareVendor";

// Vendors in each state, shaped like rows from the seed data.
const RESEARCHING: VendorDraft = { ...NEW_VENDOR, name: "Rosewood Rentals" };
const QUOTED: VendorDraft = { ...RESEARCHING, bookingStatus: "QUOTED", quoteAmount: "500.00" };
const QUOTED_PENDING: VendorDraft = { ...QUOTED, contractStatus: "PENDING", contractTotal: "480.00" };
const BOOKED_SIGNED: VendorDraft = {
  ...RESEARCHING,
  name: "The Willow House",
  bookingStatus: "BOOKED",
  contractStatus: "SIGNED",
  quoteAmount: "12800.00",
  contractTotal: "12800.00",
};
const DECLINED_CANCELLED: VendorDraft = {
  ...RESEARCHING,
  bookingStatus: "DECLINED",
  contractStatus: "CANCELLED",
  quoteAmount: "950.00",
};
const DECLINED: VendorDraft = { ...RESEARCHING, bookingStatus: "DECLINED", quoteAmount: "950.00" };

function accepted(current: VendorDraft, body: unknown): VendorFields {
  const result = prepareVendor(current, body);
  if (!result.ok) assert.fail(`expected the change to be accepted, got ${JSON.stringify(result.fields)}`);
  return result.vendor;
}

function rejected(current: VendorDraft, body: unknown): FieldErrors {
  const result = prepareVendor(current, body);
  if (result.ok) assert.fail(`expected the change to be rejected, got ${JSON.stringify(result.vendor)}`);
  return result.fields;
}

describe("new vendors", () => {
  test("a vendor with only a name starts as Researching with no contract", () => {
    const v = accepted(NEW_VENDOR, { name: "Rosewood Rentals" });
    assert.equal(v.bookingStatus, "RESEARCHING");
    assert.equal(v.contractStatus, "NOT_STARTED");
    assert.equal(v.quoteAmount, null);
    assert.equal(v.contractTotal, null);
  });

  test("a new vendor with a quote starts as Quoted", () => {
    assert.equal(accepted(NEW_VENDOR, { name: "Rosewood", quoteAmount: "500" }).bookingStatus, "QUOTED");
  });

  test("the add form sending Researching with a quote still becomes Quoted", () => {
    const v = accepted(NEW_VENDOR, { name: "Rosewood", bookingStatus: "RESEARCHING", quoteAmount: "500" });
    assert.equal(v.bookingStatus, "QUOTED");
  });
});

describe("quotes", () => {
  test("a quote on a Researching vendor moves it to Quoted", () => {
    const v = accepted(RESEARCHING, { quoteAmount: "850.00" });
    assert.equal(v.bookingStatus, "QUOTED");
    assert.equal(v.quoteAmount, "850.00");
  });

  test("Booked and Declined vendors can keep a quote", () => {
    assert.equal(accepted(BOOKED_SIGNED, { quoteAmount: "13000" }).bookingStatus, "BOOKED");
    assert.equal(accepted(DECLINED, { quoteAmount: "900" }).bookingStatus, "DECLINED");
  });
});

describe("contracts", () => {
  test("a contract total needs a contract", () => {
    assert.deepEqual(rejected(QUOTED, { contractTotal: "900.00" }), { contractTotal: "Add a contract first" });
  });

  test("a contract total is allowed once the contract is pending", () => {
    const v = accepted(QUOTED, { contractStatus: "PENDING", contractTotal: "900.00" });
    assert.equal(v.contractTotal, "900.00");
  });

  test("a Researching vendor can't have a contract", () => {
    assert.equal(rejected(RESEARCHING, { contractStatus: "PENDING" }).contractStatus, "Researching vendors can't have a contract");
    assert.equal(rejected(RESEARCHING, { contractStatus: "SIGNED" }).contractStatus, "Researching vendors can't have a contract");
  });

  test("a Declined vendor can't get a pending or signed contract", () => {
    const message = "Only quoted or booked vendors can have an active contract";
    assert.deepEqual(rejected(DECLINED, { contractStatus: "PENDING" }), { contractStatus: message });
    assert.deepEqual(rejected(DECLINED, { contractStatus: "SIGNED" }), { contractStatus: message });
  });
});

describe("signing", () => {
  test("signing a pending contract moves the vendor to Booked", () => {
    const v = accepted(QUOTED_PENDING, { contractStatus: "SIGNED" });
    assert.equal(v.contractStatus, "SIGNED");
    assert.equal(v.bookingStatus, "BOOKED");
  });

  test("signing from the edit form, which also sends booking status Quoted, still books it", () => {
    const v = accepted(QUOTED_PENDING, { contractStatus: "SIGNED", bookingStatus: "QUOTED" });
    assert.equal(v.bookingStatus, "BOOKED");
  });

  test("a quote and a signature in one request take a Researching vendor to Booked", () => {
    const v = accepted(RESEARCHING, { quoteAmount: "850", contractStatus: "SIGNED", contractTotal: "850" });
    assert.equal(v.bookingStatus, "BOOKED");
  });

  test("declining a vendor with a signed contract is rejected", () => {
    assert.deepEqual(rejected(BOOKED_SIGNED, { bookingStatus: "DECLINED" }), {
      bookingStatus: "A vendor with a signed contract is booked. Cancel the contract first",
    });
  });

  test("a signed vendor can't be moved back to Quoted", () => {
    assert.equal(
      rejected(BOOKED_SIGNED, { bookingStatus: "QUOTED" }).bookingStatus,
      "A vendor with a signed contract is booked. Cancel the contract first",
    );
  });

  test("declining a vendor with a pending contract is rejected", () => {
    assert.deepEqual(rejected(QUOTED_PENDING, { bookingStatus: "DECLINED" }), { bookingStatus: "Cancel the contract first" });
  });
});

describe("mark as cancelled", () => {
  test("cancelled + declined is allowed on a signed vendor and keeps the history", () => {
    const v = accepted(BOOKED_SIGNED, { contractStatus: "CANCELLED", bookingStatus: "DECLINED" });
    assert.equal(v.contractStatus, "CANCELLED");
    assert.equal(v.bookingStatus, "DECLINED");
    assert.equal(v.quoteAmount, "12800.00");
    assert.equal(v.contractTotal, "12800.00");
  });
});

describe("moving back to Researching", () => {
  test("clears the quote and contract", () => {
    const v = accepted(DECLINED_CANCELLED, { bookingStatus: "RESEARCHING" });
    assert.equal(v.bookingStatus, "RESEARCHING");
    assert.equal(v.quoteAmount, null);
    assert.equal(v.contractTotal, null);
    assert.equal(v.contractStatus, "NOT_STARTED");
  });

  test("clears a quote-only vendor", () => {
    const v = accepted(QUOTED, { bookingStatus: "RESEARCHING" });
    assert.equal(v.quoteAmount, null);
  });

  test("is rejected while a contract is pending, with only that error", () => {
    assert.deepEqual(rejected(QUOTED_PENDING, { bookingStatus: "RESEARCHING" }), { bookingStatus: "Cancel the contract first" });
  });

  test("is rejected while a contract is signed, with only that error", () => {
    assert.deepEqual(rejected(BOOKED_SIGNED, { bookingStatus: "RESEARCHING" }), { bookingStatus: "Cancel the contract first" });
  });

  test("is allowed when the same request cancels a pending contract", () => {
    const v = accepted(QUOTED_PENDING, { bookingStatus: "RESEARCHING", contractStatus: "CANCELLED" });
    assert.equal(v.bookingStatus, "RESEARCHING");
    assert.equal(v.contractStatus, "NOT_STARTED");
    assert.equal(v.contractTotal, null);
  });

  test("with a quote in the same request is rejected, not silently cleared", () => {
    assert.deepEqual(rejected(QUOTED, { bookingStatus: "RESEARCHING", quoteAmount: "600" }), {
      quoteAmount: "Researching vendors can't have a quote yet",
    });
  });

  test("with the quote cleared in the same request (what the UI sends after confirming) is allowed", () => {
    const v = accepted(QUOTED, { bookingStatus: "RESEARCHING", quoteAmount: null });
    assert.equal(v.bookingStatus, "RESEARCHING");
  });
});

describe("other edits", () => {
  test("changing one field leaves everything else as it was", () => {
    const v = accepted(BOOKED_SIGNED, { phone: "(555) 014-0000" });
    assert.deepEqual(v, { ...BOOKED_SIGNED, phone: "(555) 014-0000" });
  });

  test("an empty PATCH changes nothing", () => {
    assert.deepEqual(accepted(QUOTED_PENDING, {}), QUOTED_PENDING);
  });

  test("an invalid status value reports the value error, not a rule error", () => {
    assert.deepEqual(rejected(QUOTED, { contractStatus: "sent" }), { contractStatus: "Choose a valid contract status" });
  });
});

describe("matches the database CHECK constraints", () => {
  // Every vendor the rules accept must also pass the CHECKs on the vendors table,
  // so the database never rejects a vendor the API accepted (MySQL error 3819).
  function passesDatabaseChecks(v: VendorFields): boolean {
    const totalNeedsContract = v.contractTotal === null || v.contractStatus !== "NOT_STARTED";
    const researching = v.bookingStatus !== "RESEARCHING" || (v.quoteAmount === null && v.contractStatus === "NOT_STARTED");
    const activeContract = !["PENDING", "SIGNED"].includes(v.contractStatus) || ["QUOTED", "BOOKED"].includes(v.bookingStatus);
    const signedIsBooked = v.contractStatus !== "SIGNED" || v.bookingStatus === "BOOKED";
    return totalNeedsContract && researching && activeContract && signedIsBooked;
  }

  test("every accepted change across all starting states passes the CHECKs", () => {
    const starts = [RESEARCHING, QUOTED, QUOTED_PENDING, BOOKED_SIGNED, DECLINED, DECLINED_CANCELLED];
    const bookings = [undefined, "RESEARCHING", "QUOTED", "BOOKED", "DECLINED"];
    const contracts = [undefined, "NOT_STARTED", "PENDING", "SIGNED", "CANCELLED"];
    const quotes = [undefined, null, "100"];
    const totals = [undefined, null, "90"];

    let acceptedCount = 0;
    for (const start of starts)
      for (const bookingStatus of bookings)
        for (const contractStatus of contracts)
          for (const quoteAmount of quotes)
            for (const contractTotal of totals) {
              const body: Record<string, unknown> = {};
              if (bookingStatus !== undefined) body.bookingStatus = bookingStatus;
              if (contractStatus !== undefined) body.contractStatus = contractStatus;
              if (quoteAmount !== undefined) body.quoteAmount = quoteAmount;
              if (contractTotal !== undefined) body.contractTotal = contractTotal;

              const result = prepareVendor(start, body);
              if (result.ok) {
                acceptedCount++;
                assert.ok(passesDatabaseChecks(result.vendor), `${JSON.stringify(start)} + ${JSON.stringify(body)}`);
              }
            }
    assert.ok(acceptedCount > 100, `only ${acceptedCount} combinations were accepted`);
  });
});
