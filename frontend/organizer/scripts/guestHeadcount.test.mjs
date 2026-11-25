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

const { partySize, peopleByStatus, totalHeadcount } = loadModule("../src/features/guests/guestHeadcount.ts");
const STATUSES = ["UNINVITED", "PENDING", "ACCEPTED", "REJECTED"];

test("a guest counts as one person, two with a plus-one", () => {
  assert.equal(partySize({ plusOneAllowed: false }), 1);
  assert.equal(partySize({ plusOneAllowed: true }), 2);
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
