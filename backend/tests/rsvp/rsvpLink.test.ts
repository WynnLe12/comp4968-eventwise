// Private RSVP links and input validation (no AWS needed).

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ApiError } from "../../expense-service/errors";
import { createRsvpToken, parseAppOrigin, readRsvpToken, rsvpUrl } from "../../rsvp-service/rsvpLink";
import { parseRsvpResponse, parseSendInvitations } from "../../rsvp-service/services/validation";
import { ORIGIN, SECRET } from "./fakes";

const OTHER_SECRET = "another-secret-0123456789abcdef-xyz-0";
const GUEST = "7f3c9a2e-1b4d-4e8a-9c21-5d6f8a0b3e17";
const NOW = new Date("2026-11-20T18:00:00Z");

function fieldsOf(fn: () => unknown): Record<string, string> {
  try {
    fn();
  } catch (error) {
    return (error as ApiError).fields ?? {};
  }
  assert.fail("expected a validation error");
}

// --- Links --------------------------------------------------------------------------

test("an RSVP token round-trips to exactly one guest in one event", () => {
  const token = createRsvpToken({ eventId: "42", guestId: GUEST }, SECRET);
  assert.match(token, /^42\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(readRsvpToken(token, SECRET), { eventId: "42", guestId: GUEST });
  assert.equal(readRsvpToken(token, OTHER_SECRET), undefined);
});

test("one guest's signature can't open another guest's or another event's RSVP", () => {
  const token = createRsvpToken({ eventId: "42", guestId: GUEST }, SECRET);
  const signature = token.split(".")[2]!;
  const flipped = signature[0] === "A" ? `B${signature.slice(1)}` : `A${signature.slice(1)}`;
  for (const bad of [
    `42.other-guest.${signature}`, // same signature, another guest
    `43.${GUEST}.${signature}`, // same signature, another event
    `42.${GUEST}.${flipped}`, // tampered
    `042.${GUEST}.${signature}`,
    token.slice(0, -1),
    `${token}=`,
    "",
    42,
    null,
  ]) {
    assert.equal(readRsvpToken(bad, SECRET), undefined, String(bad));
  }
});

test("links need a long secret and an https (or localhost) origin", () => {
  assert.throws(() => createRsvpToken({ eventId: "42", guestId: GUEST }, "short"), /RSVP_LINK_SECRET/);
  assert.throws(() => readRsvpToken("x", undefined), /RSVP_LINK_SECRET/);
  assert.throws(() => rsvpUrl({ eventId: "42", guestId: GUEST }, { origin: "http://example.com", secret: SECRET }), /GUEST_APP_ORIGIN/);
  assert.equal(parseAppOrigin("http://localhost:5173/"), "http://localhost:5173");
  assert.equal(parseAppOrigin(`${ORIGIN}/app`), undefined);
  const url = rsvpUrl({ eventId: "42", guestId: GUEST }, { origin: ORIGIN, secret: SECRET });
  assert.ok(url.startsWith(`${ORIGIN}/rsvp/42.`));
});

// --- Organizer settings -------------------------------------------------------------

test("valid settings normalize the deadline and work out the reminder time", () => {
  const input = parseSendInvitations(
    { deadline: "2026-12-01T07:59:00.000Z", startTime: "16:00", reminderDaysBefore: 2, message: "  See you there!  " },
    "2026-12-05",
    NOW,
  );
  assert.deepEqual(input, {
    deadline: "2026-12-01T07:59:00Z",
    startTime: "16:00",
    reminderAt: "2026-11-29T07:59:00Z",
    message: "See you there!",
    includePending: false,
  });
});

test("the deadline must be in the future and no later than the event date", () => {
  assert.ok(fieldsOf(() => parseSendInvitations({ deadline: "2026-11-19T00:00:00Z" }, null, NOW)).deadline);
  // Dates are compared in Vancouver time. These instants fall on the same Vancouver day whether
  // the time-zone data has BC on UTC-8 or on permanent UTC-7.
  // Dec 6 08:30 UTC is already Dec 6 in Vancouver: after a Dec 5 event.
  assert.ok(fieldsOf(() => parseSendInvitations({ deadline: "2026-12-06T08:30:00Z" }, "2026-12-05", NOW)).deadline);
  assert.ok(fieldsOf(() => parseSendInvitations({ deadline: "tomorrow" }, null, NOW)).deadline);
  // Dec 6 06:30 UTC is still the evening of Dec 5 in Vancouver: allowed.
  assert.equal(parseSendInvitations({ deadline: "2026-12-06T06:30:00Z" }, "2026-12-05", NOW).deadline, "2026-12-06T06:30:00Z");
});

test("a reminder that would already have passed, or a bad start time, is rejected", () => {
  assert.ok(fieldsOf(() => parseSendInvitations({ deadline: "2026-11-21T18:00:00Z", reminderDaysBefore: 2 }, null, NOW)).reminderDaysBefore);
  assert.ok(fieldsOf(() => parseSendInvitations({ deadline: "2026-12-01T00:00:00Z", reminderDaysBefore: 30 }, null, NOW)).reminderDaysBefore);
  assert.ok(fieldsOf(() => parseSendInvitations({ deadline: "2026-12-01T00:00:00Z", startTime: "4pm" }, null, NOW)).startTime);
  assert.equal(parseSendInvitations({ deadline: "2026-12-01T00:00:00Z", reminderDaysBefore: 0 }, null, NOW).reminderAt, null);
});

// --- Guest answers ------------------------------------------------------------------

test("guests must say whether they're coming; text fields are trimmed and limited", () => {
  assert.ok(fieldsOf(() => parseRsvpResponse({}, true)).attending);
  assert.ok(fieldsOf(() => parseRsvpResponse({ attending: true, mealChoice: "x".repeat(201) }, true)).mealChoice);
  assert.equal(parseRsvpResponse({ attending: true, mealChoice: "x".repeat(200) }, true).mealChoice?.length, 200);
  assert.deepEqual(parseRsvpResponse({ attending: true, mealChoice: " Fish, no shellfish ", dietaryNotes: "x", plusOneAttending: true }, true), {
    attending: true, mealChoice: "Fish, no shellfish", plusOneAttending: true,
  });
  assert.equal(parseRsvpResponse({ attending: true, mealChoice: "  " }, true).mealChoice, null);
});

test("a plus-one needs an invitation that allows one, and a guest who is coming", () => {
  assert.ok(fieldsOf(() => parseRsvpResponse({ attending: true, plusOneAttending: true }, false)).plusOneAttending);
  assert.equal(parseRsvpResponse({ attending: false, plusOneAttending: true }, true).plusOneAttending, false);
});
