// MySQL CHECK failures (error 3819) must come back as a 422 under the right field, never a 500.
// The database checks prove the real error message has this format.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ApiError } from "../../expense-service/errors";
import { checkViolationAs422 } from "../../vendor-service/services/vendorService";

function checkError(constraint: string): Error {
  return Object.assign(new Error(`Check constraint '${constraint}' is violated.`), {
    errno: 3819,
    code: "ER_CHECK_CONSTRAINT_VIOLATED",
  });
}

function fieldsFor(error: unknown): Record<string, string> | undefined {
  try {
    checkViolationAs422(error);
  } catch (thrown) {
    assert.ok(thrown instanceof ApiError);
    assert.equal(thrown.status, 422);
    assert.equal(thrown.code, "VALIDATION_ERROR");
    return thrown.fields;
  }
  assert.fail("checkViolationAs422 always throws");
}

describe("checkViolationAs422", () => {
  test("each vendors CHECK constraint maps to its field", () => {
    const expected: Record<string, string> = {
      chk_vendor_quote: "quoteAmount",
      chk_vendor_contract_total: "contractTotal",
      chk_vendor_total_needs_contract: "contractTotal",
      chk_vendor_researching: "bookingStatus",
      chk_vendor_active_contract: "contractStatus",
      chk_vendor_signed_is_booked: "bookingStatus",
    };
    for (const [constraint, field] of Object.entries(expected)) {
      assert.deepEqual(Object.keys(fieldsFor(checkError(constraint))!), [field], constraint);
    }
  });

  test("an unknown constraint still gives a 422, not a 500", () => {
    assert.deepEqual(fieldsFor(checkError("chk_something_new")), {
      bookingStatus: "This status combination isn't allowed",
    });
  });

  test("any other error is rethrown unchanged", () => {
    for (const error of [
      Object.assign(new Error("Duplicate entry"), { errno: 1062 }),
      new Error("connect ECONNREFUSED"),
      "not even an Error",
    ]) {
      assert.throws(() => checkViolationAs422(error), (thrown) => thrown === error);
    }
  });
});
