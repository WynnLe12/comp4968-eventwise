import assert from "node:assert/strict";
import { test } from "node:test";
import { loadGuestSummary, summarizeGuests } from "../../guest-service/services/guestSummary";
import type { GuestItem } from "../../guest-service/types";

const none = { UNINVITED: 0, PENDING: 0, ACCEPTED: 0, REJECTED: 0 };

test("an event without guests has all counts at zero", () => {
  assert.deepEqual(summarizeGuests([]), { records: 0, plusOnes: 0, expectedHeadcount: 0, rsvp: none });
});

test("guests are counted per RSVP status, and plus-ones are added to the headcount", () => {
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
    rsvp: { UNINVITED: 1, PENDING: 1, ACCEPTED: 2, REJECTED: 1 },
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
    rsvp: { ...none, ACCEPTED: 1, UNINVITED: 1 },
  });
});

test("loadGuestSummary passes DynamoDB errors to the caller", async () => {
  await assert.rejects(
    loadGuestSummary("11", { listByEvent: async () => { throw new Error("DynamoDB unavailable"); } }),
    /DynamoDB unavailable/,
  );
});
