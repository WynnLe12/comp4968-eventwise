import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function loadModule(path) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module = { exports: {} };
  new Function("module", "exports", outputText)(module, module.exports);
  return module.exports;
}

const { attendeeCount, attendeeOptions, partySize, peopleByStatus, plusOneAttendingFor, totalHeadcount } =
  loadModule("../src/features/guests/guestHeadcount.ts");
const STATUSES = ["UNINVITED", "PENDING", "ACCEPTED", "REJECTED"];

test("a guest counts as one person, two with a plus-one", () => {
  assert.equal(partySize({ plusOneAllowed: false }), 1);
  assert.equal(partySize({ plusOneAllowed: true }), 2);
});

test("Attendee(s) shows who is actually coming, from the guest's RSVP", () => {
  // No answer yet: shown as "-".
  assert.equal(attendeeCount({ rsvpStatus: "UNINVITED", plusOneAllowed: true }), null);
  assert.equal(attendeeCount({ rsvpStatus: "PENDING", plusOneAllowed: true, plusOneAttending: null }), null);
  // Declined: nobody, even with a plus-one allowed.
  assert.equal(attendeeCount({ rsvpStatus: "REJECTED", plusOneAllowed: true, plusOneAttending: false }), 0);
  // Accepted: 2 only when the plus-one is coming.
  assert.equal(attendeeCount({ rsvpStatus: "ACCEPTED", plusOneAllowed: true, plusOneAttending: true }), 2);
  assert.equal(attendeeCount({ rsvpStatus: "ACCEPTED", plusOneAllowed: true, plusOneAttending: false }), 1);
  assert.equal(attendeeCount({ rsvpStatus: "ACCEPTED", plusOneAllowed: false }), 1);
  // Marked accepted by an organizer, so the plus-one never answered: just the guest.
  assert.equal(attendeeCount({ rsvpStatus: "ACCEPTED", plusOneAllowed: true, plusOneAttending: null }), 1);
  // A plus-one answer can't count without an allowed plus-one.
  assert.equal(attendeeCount({ rsvpStatus: "ACCEPTED", plusOneAllowed: false, plusOneAttending: true }), 1);
});

test("the Edit guest form offers attendee counts that match the RSVP status", () => {
  assert.deepEqual(attendeeOptions("ACCEPTED", true), [1, 2]);
  assert.deepEqual(attendeeOptions("ACCEPTED", false), [1]);
  assert.deepEqual(attendeeOptions("REJECTED", true), [0]);
  assert.equal(attendeeOptions("PENDING", true), null);
  assert.equal(attendeeOptions("UNINVITED", false), null);
});

test("a chosen attendee count is saved as plusOneAttending, and reads back the same", () => {
  for (const [status, allowed, attendees] of [["ACCEPTED", true, 2], ["ACCEPTED", true, 1], ["ACCEPTED", false, 1], ["REJECTED", true, 0]]) {
    const plusOneAttending = plusOneAttendingFor(status, allowed, attendees);
    assert.equal(attendeeCount({ rsvpStatus: status, plusOneAllowed: allowed, plusOneAttending }), attendees);
  }
  // 2 isn't possible without an allowed plus-one.
  assert.equal(plusOneAttendingFor("ACCEPTED", false, 2), false);
  // No answer yet: the guest's own value is left alone.
  assert.equal(plusOneAttendingFor("PENDING", true, null), undefined);
});

test("total guests includes plus-ones", () => {
  // The reported case: one guest without and one with a plus-one is 3 people, not 2.
  assert.equal(totalHeadcount([{ plusOneAllowed: false }, { plusOneAllowed: true }]), 3);
  assert.equal(totalHeadcount([{ plusOneAllowed: true }, { plusOneAllowed: true }]), 4);
});

test("an empty guest list has no guests", () => {
  assert.equal(totalHeadcount([]), 0);
  assert.deepEqual(peopleByStatus([], STATUSES), { UNINVITED: 0, PENDING: 0, ACCEPTED: 0, REJECTED: 0 });
});

test("RSVP cards count people: a guest with a plus-one adds 2 to its status", () => {
  // The reported guest list: 2 uninvited, 1 accepted, 1 accepted with a plus-one.
  const guests = [
    { plusOneAllowed: false, rsvpStatus: "UNINVITED" },
    { plusOneAllowed: false, rsvpStatus: "ACCEPTED" },
    { plusOneAllowed: false, rsvpStatus: "UNINVITED" },
    { plusOneAllowed: true, rsvpStatus: "ACCEPTED" },
  ];
  const counts = peopleByStatus(guests, STATUSES);
  assert.deepEqual(counts, { UNINVITED: 2, PENDING: 0, ACCEPTED: 3, REJECTED: 0 });
  // Every card adds up to the total people.
  assert.equal(Object.values(counts).reduce((sum, count) => sum + count, 0), totalHeadcount(guests));
});

test("an accepted guest whose plus-one isn't coming counts 1 accepted and 1 rejected", () => {
  const guests = [
    { plusOneAllowed: true, rsvpStatus: "ACCEPTED", plusOneAttending: false },
    { plusOneAllowed: true, rsvpStatus: "ACCEPTED", plusOneAttending: true },
    { plusOneAllowed: true, rsvpStatus: "ACCEPTED" },
  ];
  const counts = peopleByStatus(guests, STATUSES);
  assert.deepEqual(counts, { UNINVITED: 0, PENDING: 0, ACCEPTED: 5, REJECTED: 1 });
  assert.equal(Object.values(counts).reduce((sum, count) => sum + count, 0), totalHeadcount(guests));
});

test("rejected and pending guests with a plus-one also count as 2", () => {
  const counts = peopleByStatus([
    { plusOneAllowed: true, rsvpStatus: "REJECTED" },
    { plusOneAllowed: true, rsvpStatus: "PENDING" },
    { plusOneAllowed: false, rsvpStatus: "PENDING" },
  ], STATUSES);
  assert.deepEqual(counts, { UNINVITED: 0, PENDING: 3, ACCEPTED: 0, REJECTED: 2 });
});

test("an unknown status is not counted in any card", () => {
  assert.deepEqual(peopleByStatus([{ plusOneAllowed: true, rsvpStatus: "MAYBE" }], STATUSES),
    { UNINVITED: 0, PENDING: 0, ACCEPTED: 0, REJECTED: 0 });
});
