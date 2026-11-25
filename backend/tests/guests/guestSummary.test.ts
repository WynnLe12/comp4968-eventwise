import assert from "node:assert/strict";
import { test } from "node:test";
import { loadGuestSummary, summarizeGuests } from "../../guest-service/services/guestSummary";
import type { GuestItem } from "../../guest-service/types";

const none = { UNINVITED: 0, PENDING: 0, ACCEPTED: 0, REJECTED: 0 };

test("an event without guests has all counts at zero", () => {
  assert.deepEqual(summarizeGuests([]), { records: 0, plusOnes: 0, expectedHeadcount: 0, rsvp: none });
});

test("people are counted per RSVP status: a guest with a plus-one counts as 2", () => {
  const summary = summarizeGuests([
    { plusOneAllowed: true, rsvpStatus: "ACCEPTED" },
    { plusOneAllowed: false, rsvpStatus: "ACCEPTED" },
    { plusOneAllowed: true, rsvpStatus: "PENDING" },
    { plusOneAllowed: false, rsvpStatus: "REJECTED" },
    { plusOneAllowed: false, rsvpStatus: "UNINVITED" },
  ]);
  assert.deepEqual(summary, {
    records: 5,
    plusOnes: 2,
    expectedHeadcount: 7,
    rsvp: { UNINVITED: 1, PENDING: 2, ACCEPTED: 3, REJECTED: 1 },
  });
});

test("the RSVP counts add up to the expected headcount", () => {
  const summary = summarizeGuests([
    { plusOneAllowed: true, rsvpStatus: "REJECTED" },
    { plusOneAllowed: true, rsvpStatus: "UNINVITED" },
    { plusOneAllowed: false, rsvpStatus: "PENDING" },
    { plusOneAllowed: true },
  ]);
  const total = Object.values(summary.rsvp).reduce((sum, count) => sum + count, 0);
  assert.equal(total, summary.expectedHeadcount);
  assert.deepEqual(summary.rsvp, { UNINVITED: 4, PENDING: 1, ACCEPTED: 0, REJECTED: 2 });
});

test("the reported guest list: 2 accepted guests, one with a plus-one, is 3 people accepted", () => {
  const summary = summarizeGuests([
    { plusOneAllowed: false, rsvpStatus: "UNINVITED" }, // John Snow
    { plusOneAllowed: false, rsvpStatus: "ACCEPTED" }, // Katnis Everdie
    { plusOneAllowed: false, rsvpStatus: "UNINVITED" }, // BCIT PARTY
    { plusOneAllowed: true, rsvpStatus: "ACCEPTED" }, // Peta Pit + plus-one
  ]);
  assert.deepEqual(summary, {
    records: 4, plusOnes: 1, expectedHeadcount: 5,
    rsvp: { UNINVITED: 2, PENDING: 0, ACCEPTED: 3, REJECTED: 0 },
  });
});

test("headcount does not depend on RSVP answers", () => {
  // A rejected guest with a plus-one still counts in the planned headcount (Feature 7 rule).
  const summary = summarizeGuests([{ plusOneAllowed: true, rsvpStatus: "REJECTED" }]);
  assert.equal(summary.expectedHeadcount, 2);
});

test("a missing status counts as UNINVITED; an unknown status is not guessed", () => {
  const summary = summarizeGuests([
    { plusOneAllowed: false },
    { plusOneAllowed: false, rsvpStatus: "MAYBE" },
    { plusOneAllowed: false, rsvpStatus: "ATTENDING" },
  ]);
  assert.equal(summary.records, 3);
  assert.deepEqual(summary.rsvp, { ...none, UNINVITED: 1 });
});

test("only a real true counts as a plus-one", () => {
  const summary = summarizeGuests([
    { plusOneAllowed: "true", rsvpStatus: "PENDING" },
    { rsvpStatus: "PENDING" },
    { plusOneAllowed: true, rsvpStatus: "PENDING" },
  ]);
  assert.equal(summary.plusOnes, 1);
  assert.equal(summary.expectedHeadcount, 4);
  assert.equal(summary.rsvp.PENDING, 4);
});

test("loadGuestSummary reads the event's guests from the repository", async () => {
  const asked: string[] = [];
  const items = [
    { eventId: "11", guestId: "a", firstName: "Ann", plusOneAllowed: true, rsvpStatus: "ACCEPTED" },
    { eventId: "11", guestId: "b", firstName: "Bo", plusOneAllowed: false, rsvpStatus: "UNINVITED" },
  ] as GuestItem[];
  const summary = await loadGuestSummary("11", {
    listByEvent: async (eventId: string) => { asked.push(eventId); return items; },
  });
  assert.deepEqual(asked, ["11"]);
  assert.deepEqual(summary, {
    records: 2,
    plusOnes: 1,
    expectedHeadcount: 3,
    rsvp: { ...none, ACCEPTED: 2, UNINVITED: 1 },
  });
});

test("loadGuestSummary passes DynamoDB errors to the caller", async () => {
  await assert.rejects(
    loadGuestSummary("11", { listByEvent: async () => { throw new Error("DynamoDB unavailable"); } }),
    /DynamoDB unavailable/,
  );
});
