// Unit tests for timeline request validation and reminder timing (no AWS, Docker or MySQL needed).

import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../../expense-service/errors";
import {
  LIMITS,
  assertEndsAfterStart,
  parseInstant,
  parseNotifyQuery,
  requireEventId,
  requireItemId,
  validEventId,
  validItemId,
  validateNewItem,
  validatePatch,
  validateSubscriptionBody,
} from "../../timeline-service/services/validation";
import {
  calculateReminderAt,
  describeReminder,
  rescheduleReminder,
} from "../../timeline-service/services/reminders";

/** Runs fn and returns the ApiError it throws, failing the test if it doesn't. */
function apiError(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ApiError, `expected ApiError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected an ApiError");
}

const fieldsOf = (fn: () => unknown) => apiError(fn).fields ?? {};

// --- Instants -----------------------------------------------------------------

test("parseInstant normalizes any offset to UTC with whole minutes", () => {
  assert.equal(parseInstant("2026-12-05T23:00:00Z"), "2026-12-05T23:00:00Z");
  assert.equal(parseInstant("2026-12-05T23:00Z"), "2026-12-05T23:00:00Z");
  assert.equal(parseInstant("2026-12-05T15:00:00-08:00"), "2026-12-05T23:00:00Z");
  assert.equal(parseInstant("2026-12-05T15:00:00.000-08:00"), "2026-12-05T23:00:00Z");
  // Crossing midnight and a half-hour offset.
  assert.equal(parseInstant("2026-12-05T20:30:00-05:30"), "2026-12-06T02:00:00Z");
  assert.equal(parseInstant("2026-12-06T01:00:00+09:00"), "2026-12-05T16:00:00Z");
});

test("parseInstant rejects missing offsets, seconds, impossible dates and odd years", () => {
  for (const bad of [
    "2026-12-05T23:00:00", // no offset: ambiguous
    "2026-12-05 23:00:00Z",
    "2026-12-05T23:00:30Z", // seconds
    "2026-12-05T23:00:00.500Z", // milliseconds
    "2026-02-30T10:00:00Z", // impossible date
    "2026-12-05T24:00:00Z",
    "2026-12-05T23:60:00Z",
    "2026-12-05T23:00:00+15:00", // offset out of range
    "1999-12-31T23:00:00Z",
    "2101-01-01T00:00:00Z",
    "",
    1764975600000,
    null,
  ]) {
    assert.equal(parseInstant(bad), null, String(bad));
  }
});

test("assertEndsAfterStart allows null or later ends and rejects equal or earlier ones", () => {
  assertEndsAfterStart("2026-12-05T23:00:00Z", null);
  assertEndsAfterStart("2026-12-05T23:00:00Z", "2026-12-05T23:01:00Z");
  assert.deepEqual(fieldsOf(() => assertEndsAfterStart("2026-12-05T23:00:00Z", "2026-12-05T23:00:00Z")), {
    endsAt: "Must be after the start time.",
  });
});

// --- Path IDs -----------------------------------------------------------------

test("event and item IDs must be well formed, otherwise 400", () => {
  assert.equal(validEventId("42"), true);
  assert.equal(validEventId("18446744073709551615"), true);
  for (const bad of ["0", "042", "-1", "1.5", "abc", "", 42]) assert.equal(validEventId(bad), false, String(bad));

  assert.equal(validItemId("3b1f0c2e-8d4a-4f6b-9e21-7a5c2d9e0f13"), true);
  for (const bad of ["3B1F0C2E-8D4A-4F6B-9E21-7A5C2D9E0F13", "ITEM#3b1f0c2e-8d4a-4f6b-9e21-7a5c2d9e0f13", "x"]) {
    assert.equal(validItemId(bad), false, bad);
  }
  assert.equal(apiError(() => requireEventId("abc")).status, 400);
  assert.equal(apiError(() => requireItemId("abc")).code, "BAD_REQUEST");
});

// --- POST ---------------------------------------------------------------------

test("validateNewItem trims text, normalizes times and applies defaults", () => {
  const item = validateNewItem({
    title: "  Ceremony begins ",
    place: " ",
    startsAt: "2026-12-05T15:00:00-08:00",
    endsAt: "2026-12-05T15:30:00-08:00",
  });
  assert.deepEqual(item, {
    title: "Ceremony begins",
    place: null,
    notes: null,
    startsAt: "2026-12-05T23:00:00Z",
    endsAt: "2026-12-05T23:30:00Z",
    visibility: "GUESTS",
    reminderMinutes: 60,
  });
});

test("validateNewItem reports every invalid field at once with 422", () => {
  const error = apiError(() =>
    validateNewItem({
      place: 5,
      notes: "x".repeat(LIMITS.notes + 1),
      endsAt: "tomorrow",
      visibility: "PUBLIC",
      reminderMinutes: 30,
      itemId: "forged",
      version: 9,
    }),
  );
  assert.equal(error.status, 422);
  assert.equal(error.code, "VALIDATION_ERROR");
  assert.deepEqual(Object.keys(error.fields ?? {}).sort(), [
    "endsAt", "itemId", "notes", "place", "reminderMinutes", "startsAt", "title", "version", "visibility",
  ]);
  assert.equal(error.fields?.title, "Required.");
  assert.equal(error.fields?.itemId, "Unknown or read-only field.");
});

test("titles and places must be single lines within their limits; notes may have line breaks", () => {
  assert.equal(validateNewItem({ title: "é".repeat(LIMITS.title), startsAt: "2026-12-05T23:00:00Z" }).title.length, LIMITS.title);
  assert.deepEqual(fieldsOf(() => validateNewItem({ title: "a".repeat(LIMITS.title + 1), startsAt: "2026-12-05T23:00:00Z" })), {
    title: "Use 120 characters or fewer.",
  });
  assert.deepEqual(fieldsOf(() => validateNewItem({ title: "Line\nbreak", place: "Hall\u2028B", startsAt: "2026-12-05T23:00:00Z" })), {
    title: "Must be a single line of text.",
    place: "Must be a single line of text.",
  });
  assert.deepEqual(fieldsOf(() => validateNewItem({ title: "   ", startsAt: "2026-12-05T23:00:00Z" })), { title: "Required." });
  assert.equal(validateNewItem({ title: "A", notes: "Line 1\r\nLine 2", startsAt: "2026-12-05T23:00:00Z" }).notes, "Line 1\nLine 2");
  assert.deepEqual(fieldsOf(() => validateNewItem({ title: "A", notes: "bell\u0007", startsAt: "2026-12-05T23:00:00Z" })), {
    notes: "Contains characters that are not allowed.",
  });
});

test("validateNewItem rejects an end time that is not after the start", () => {
  assert.deepEqual(fieldsOf(() => validateNewItem({
    title: "Dinner", startsAt: "2026-12-05T23:00:00Z", endsAt: "2026-12-05T15:00:00-08:00",
  })), { endsAt: "Must be after the start time." });
});

test("a body that is not a JSON object is a 422 on body", () => {
  for (const body of [null, [], "text", 5]) {
    assert.deepEqual(fieldsOf(() => validateNewItem(body)), { body: "Send a JSON object." });
    assert.deepEqual(fieldsOf(() => validatePatch(body)), { body: "Send a JSON object." });
  }
});

// --- PATCH --------------------------------------------------------------------

test("validatePatch returns only the fields sent, the version and the notify flag", () => {
  assert.deepEqual(validatePatch({ version: 3, place: null, startsAt: "2026-12-05T15:30:00-08:00", notify: true }), {
    changes: { place: null, startsAt: "2026-12-05T23:30:00Z" },
    version: 3,
    notify: true,
  });
  assert.equal(validatePatch({ version: 1, title: "x" }).notify, false);
  assert.deepEqual(validatePatch({ version: 1, endsAt: null }).changes, { endsAt: null });
});

test("validatePatch requires a positive integer version and at least one change", () => {
  assert.equal(fieldsOf(() => validatePatch({ title: "x" })).version, "Required. Send the version you last loaded.");
  for (const version of [0, -1, 1.5, "3", null]) {
    assert.equal(fieldsOf(() => validatePatch({ version, title: "x" })).version, "Must be a positive whole number.", String(version));
  }
  assert.deepEqual(fieldsOf(() => validatePatch({ version: 2 })), { body: "Include at least one field to change." });
  assert.deepEqual(fieldsOf(() => validatePatch({ version: 2, notify: true })), { body: "Include at least one field to change." });
});

test("validatePatch rejects clearing required fields, bad notify values and read-only fields", () => {
  assert.deepEqual(fieldsOf(() => validatePatch({
    version: 2, title: null, startsAt: null, visibility: null, notify: "yes", createdBy: "x", eventId: "99",
  })), {
    title: "Required.",
    startsAt: "Use a date and time with a time zone and whole minutes, e.g. 2026-12-05T15:00:00-08:00.",
    visibility: "Use GUESTS or TEAM.",
    notify: "Must be true or false.",
    createdBy: "Unknown or read-only field.",
    eventId: "Unknown or read-only field.",
  });
});

// --- Subscription and query -----------------------------------------------------

test("subscription body needs exactly one JWT-shaped idToken", () => {
  assert.deepEqual(validateSubscriptionBody({ idToken: "aaa.bbb.ccc" }), { idToken: "aaa.bbb.ccc" });
  for (const body of [{}, { idToken: "" }, { idToken: "not-a-jwt" }, { idToken: 5 }]) {
    assert.ok(fieldsOf(() => validateSubscriptionBody(body)).idToken, JSON.stringify(body));
  }
  assert.equal(fieldsOf(() => validateSubscriptionBody({ idToken: "a.b.c", email: "me@x.com" })).email, "Unknown or read-only field.");
});

test("DELETE notify query accepts only true or false", () => {
  assert.equal(parseNotifyQuery(undefined), false);
  assert.equal(parseNotifyQuery(null), false);
  assert.equal(parseNotifyQuery({ notify: "false" }), false);
  assert.equal(parseNotifyQuery({ notify: "true" }), true);
  assert.equal(apiError(() => parseNotifyQuery({ notify: "1" })).status, 400);
  assert.equal(apiError(() => parseNotifyQuery({ force: "true" })).status, 400);
});

// --- Reminders ----------------------------------------------------------------

const NOW = new Date("2026-12-05T20:00:00Z");

test("calculateReminderAt subtracts the reminder minutes from the start time", () => {
  assert.equal(calculateReminderAt("2026-12-05T23:00:00Z", 60, NOW), "2026-12-05T22:00:00Z");
  assert.equal(calculateReminderAt("2026-12-05T23:00:00Z", 15, NOW), "2026-12-05T22:45:00Z");
  assert.equal(calculateReminderAt("2026-12-07T23:00:00Z", 1440, NOW), "2026-12-06T23:00:00Z");
});

test("no reminder when turned off, already past, or exactly now", () => {
  assert.equal(calculateReminderAt("2026-12-05T23:00:00Z", 0, NOW), null);
  assert.equal(calculateReminderAt("2026-12-05T20:30:00Z", 60, NOW), null); // 1 hour before was 19:30
  assert.equal(calculateReminderAt("2026-12-05T21:00:00Z", 60, NOW), null); // exactly now
  assert.equal(calculateReminderAt("2026-12-05T21:01:00Z", 60, NOW), "2026-12-05T20:01:00Z");
});

test("rescheduleReminder changes the reminder only when the start time or setting changes", () => {
  const before = { startsAt: "2026-12-05T23:00:00Z", reminderMinutes: 60 as const };
  assert.equal(rescheduleReminder(before, { ...before }, NOW), undefined);
  assert.equal(rescheduleReminder(before, { ...before, startsAt: "2026-12-05T23:30:00Z" }, NOW), "2026-12-05T22:30:00Z");
  assert.equal(rescheduleReminder(before, { ...before, reminderMinutes: 15 }, NOW), "2026-12-05T22:45:00Z");
  assert.equal(rescheduleReminder(before, { ...before, reminderMinutes: 0 }, NOW), null);
  // Moved to a time whose reminder moment has passed: cancel rather than send late.
  assert.equal(rescheduleReminder(before, { ...before, startsAt: "2026-12-05T20:30:00Z" }, NOW), null);
});

test("describeReminder gives readable labels", () => {
  assert.deepEqual([0, 15, 60, 1440].map((m) => describeReminder(m as 0 | 15 | 60 | 1440)), [
    "No reminder", "15 minutes before", "1 hour before", "1 day before",
  ]);
});
