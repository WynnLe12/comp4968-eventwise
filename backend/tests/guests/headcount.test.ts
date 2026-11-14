import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateHeadcount } from "../../guest-service/services/headcount";
import { toGuest } from "../../guest-service/services/guestMapper";
import type { GuestItem } from "../../guest-service/types";

test("headcount of an empty guest list is zero", () => {
  assert.deepEqual(calculateHeadcount([]), { invited: 0, plusOnes: 0, expectedTotal: 0 });
});

test("headcount adds one person for each allowed plus-one", () => {
  const guests = [{ plusOneAllowed: true }, { plusOneAllowed: false }, { plusOneAllowed: true }];
  assert.deepEqual(calculateHeadcount(guests), { invited: 3, plusOnes: 2, expectedTotal: 5 });
});

test("headcount ignores RSVP answers", () => {
  const guests = [
    { plusOneAllowed: false, rsvpStatus: "DECLINED" },
    { plusOneAllowed: true, rsvpStatus: "PENDING" },
  ];
  assert.deepEqual(calculateHeadcount(guests), { invited: 2, plusOnes: 1, expectedTotal: 3 });
});

test("toGuest returns null for omitted optional fields and hides createdBy", () => {
  const item: GuestItem = {
    eventId: "42",
    guestId: "g-1",
    firstName: "Sofia",
    plusOneAllowed: false,
    rsvpStatus: "PENDING",
    createdBy: "sub-123",
    createdAt: "2026-11-12T10:00:00.000Z",
    updatedAt: "2026-11-12T10:00:00.000Z",
  };
  const guest = toGuest(item);
  assert.equal(guest.lastName, null);
  assert.equal(guest.email, null);
  assert.equal(guest.group, null);
  assert.equal(guest.mealChoice, null);
  assert.equal(guest.dietaryNotes, null);
  assert.equal("createdBy" in guest, false);
});
