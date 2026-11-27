// Unit tests for TimelineService: membership, validation order, versioning,
// reminders and change detection (no AWS, Docker or MySQL needed).

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ApiError } from "../../expense-service/errors";
import {
  TimelineService,
  changedFieldsBetween,
  isNotifiable,
  notificationsNotConfigured,
} from "../../timeline-service/services/timelineService";
import type { TimelineRecord } from "../../timeline-service/types";
import { MemoryTimelineStore, RecordingNotifier, memberships } from "./fakes";

const OWNER = "sub-owner";
const PLANNER = "sub-planner";
const OUTSIDER = "sub-outsider";
const NOW = new Date("2026-12-01T12:00:00Z");

function setup(notifier = new RecordingNotifier()) {
  const store = new MemoryTimelineStore();
  const members = memberships([["42", OWNER], ["42", PLANNER], ["77", OUTSIDER]]);
  const logged: string[] = [];
  const service = new TimelineService({
    repository: store,
    requireMember: members.check,
    notifier,
    now: () => NOW,
    logError: (message) => logged.push(message),
  });
  return { service, store, members, notifier, logged };
}

const ceremony = { title: "Ceremony begins", place: "Garden ceremony", startsAt: "2026-12-05T15:00:00-08:00" };

async function rejectsWith(promise: Promise<unknown>, status: number, code: string) {
  await assert.rejects(promise, (error: ApiError) => {
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  });
}

// --- Access -------------------------------------------------------------------

test("owner and co-planner can create, list, edit and delete", async () => {
  const { service } = setup();
  const created = await service.create("42", OWNER, ceremony);
  const updated = await service.update("42", created.itemId, PLANNER, { version: 1, place: "Main hall" });
  assert.equal(updated.item.place, "Main hall");
  assert.equal((await service.list("42", PLANNER)).items.length, 1);
  await service.delete("42", created.itemId, PLANNER);
  assert.deepEqual((await service.list("42", OWNER)).items, []);
});

test("a non-member gets 403 on every operation, before the body is even looked at", async () => {
  const { service, store } = setup();
  const created = await service.create("42", OWNER, ceremony);
  await rejectsWith(service.list("42", OUTSIDER), 403, "FORBIDDEN");
  await rejectsWith(service.create("42", OUTSIDER, { nonsense: true }), 403, "FORBIDDEN");
  await rejectsWith(service.update("42", created.itemId, OUTSIDER, {}), 403, "FORBIDDEN");
  await rejectsWith(service.delete("42", created.itemId, OUTSIDER, { notify: "maybe" }), 403, "FORBIDDEN");
  assert.equal(store.records.size, 1);
});

test("malformed path IDs are 400 before any membership or storage call", async () => {
  const { service, members } = setup();
  await rejectsWith(service.list("abc", OWNER), 400, "BAD_REQUEST");
  await rejectsWith(service.update("42", "ITEM#x", OWNER, { version: 1, title: "x" }), 400, "BAD_REQUEST");
  await rejectsWith(service.delete("042", "00000000-0000-4000-8000-000000000001", OWNER), 400, "BAD_REQUEST");
  assert.equal(members.checked.length, 0);
});

test("an item from another event is 404, even for a member of that other event", async () => {
  const { service } = setup();
  const created = await service.create("42", OWNER, ceremony);
  await rejectsWith(service.update("77", created.itemId, OUTSIDER, { version: 1, title: "Hijacked" }), 404, "NOT_FOUND");
  await rejectsWith(service.delete("77", created.itemId, OUTSIDER), 404, "NOT_FOUND");
  assert.equal((await service.list("42", OWNER)).items[0]!.title, "Ceremony begins");
});

// --- Create and list ----------------------------------------------------------

test("create validates, normalizes to UTC and schedules a reminder", async () => {
  const { service } = setup();
  const item = await service.create("42", OWNER, ceremony);
  assert.equal(item.startsAt, "2026-12-05T23:00:00Z");
  assert.equal(item.visibility, "GUESTS");
  assert.equal(item.reminderMinutes, 60);
  assert.equal(item.reminderAt, "2026-12-05T22:00:00Z");
  assert.equal(item.reminderSent, false);
  assert.equal(item.version, 1);
  await rejectsWith(service.create("42", OWNER, { title: "No time" }), 422, "VALIDATION_ERROR");
});

test("an activity whose reminder moment already passed is saved without a reminder", async () => {
  const { service } = setup();
  const item = await service.create("42", OWNER, { title: "Rehearsal", startsAt: "2026-12-01T12:30:00Z" });
  assert.equal(item.reminderAt, null);
});

test("list returns items in time order with stable ties", async () => {
  const { service } = setup();
  await service.create("42", OWNER, { title: "Dinner", startsAt: "2026-12-06T01:45:00Z" });
  await service.create("42", OWNER, { title: "Toasts", startsAt: "2026-12-06T03:15:00Z" });
  await service.create("42", OWNER, { title: "Cocktails", startsAt: "2026-12-05T23:30:00Z" });
  await service.create("42", OWNER, { title: "Ceremony", startsAt: "2026-12-05T23:30:00Z" });
  const list = await service.list("42", OWNER);
  assert.equal(list.eventId, "42");
  assert.deepEqual(list.items.map((i) => i.title), ["Ceremony", "Cocktails", "Dinner", "Toasts"]);
});

test("an event is capped at 100 activities", async () => {
  const { service, store } = setup();
  store.countItems = async () => 100;
  await rejectsWith(service.create("42", OWNER, ceremony), 409, "TIMELINE_FULL");
});

// --- Update -------------------------------------------------------------------

test("a stale version is 409 and changes nothing", async () => {
  const { service } = setup();
  const created = await service.create("42", OWNER, ceremony);
  await service.update("42", created.itemId, OWNER, { version: 1, title: "First edit" });
  await rejectsWith(service.update("42", created.itemId, PLANNER, { version: 1, title: "Second edit" }), 409, "VERSION_CONFLICT");
  const [item] = (await service.list("42", OWNER)).items;
  assert.equal(item!.title, "First edit");
  assert.equal(item!.version, 2);
});

test("a write that loses a race after the read is still a 409", async () => {
  const { service, store } = setup();
  const created = await service.create("42", OWNER, ceremony);
  store.updateItem = async () => ({ status: "VERSION_CONFLICT" });
  await rejectsWith(service.update("42", created.itemId, OWNER, { version: 1, title: "x" }), 409, "VERSION_CONFLICT");
});

test("endsAt must stay after startsAt, checked against the stored item", async () => {
  const { service } = setup();
  const created = await service.create("42", OWNER, { ...ceremony, endsAt: "2026-12-05T15:30:00-08:00" });
  // Moving the start past the stored end time is rejected.
  await rejectsWith(service.update("42", created.itemId, OWNER, { version: 1, startsAt: "2026-12-05T16:00:00-08:00" }), 422, "VALIDATION_ERROR");
  // Moving both, or clearing the end, is fine.
  await service.update("42", created.itemId, OWNER, { version: 1, startsAt: "2026-12-05T16:00:00-08:00", endsAt: null });
});

test("moving an activity reschedules its reminder and clears the sent mark; editing notes does not", async () => {
  const { service, store } = setup();
  const created = await service.create("42", OWNER, ceremony);
  const key = `42|${created.itemId}`;
  store.records.set(key, { ...store.records.get(key)!, reminderStatus: undefined, reminderSentAt: "2026-12-05T22:00:10Z" });

  const notesOnly = await service.update("42", created.itemId, OWNER, { version: 1, notes: "Bring umbrellas" });
  assert.equal(notesOnly.item.reminderSent, true);
  assert.equal(notesOnly.item.reminderAt, "2026-12-05T22:00:00Z");

  const moved = await service.update("42", created.itemId, OWNER, { version: 2, startsAt: "2026-12-05T15:30:00-08:00" });
  assert.equal(moved.item.reminderAt, "2026-12-05T22:30:00Z");
  assert.equal(moved.item.reminderSent, false);
  assert.equal(store.records.get(key)!.reminderStatus, "PENDING");

  const off = await service.update("42", created.itemId, OWNER, { version: 3, reminderMinutes: 0 });
  assert.equal(off.item.reminderAt, null);
  assert.equal(store.records.get(key)!.reminderStatus, undefined);
});

// --- Change detection and notifications ---------------------------------------

test("update reports exactly which fields changed", async () => {
  const { service } = setup();
  const created = await service.create("42", OWNER, ceremony);
  const result = await service.update("42", created.itemId, OWNER, {
    version: 1, title: "Ceremony begins", place: null, startsAt: "2026-12-05T15:30:00-08:00",
  });
  // title was sent but is unchanged.
  assert.deepEqual(result.changedFields, ["place", "startsAt"]);
});

test("no email unless notify is true and a field people care about changed", async () => {
  const { service, notifier } = setup();
  const created = await service.create("42", OWNER, ceremony);

  const quiet = await service.update("42", created.itemId, OWNER, { version: 1, place: "Main hall" });
  assert.deepEqual(quiet.notification, { status: "NOT_REQUESTED", recipients: 0 });

  const notesOnly = await service.update("42", created.itemId, OWNER, { version: 2, notes: "x", reminderMinutes: 15, notify: true });
  assert.deepEqual(notesOnly.notification, { status: "NO_CHANGE", recipients: 0 });
  assert.equal(notifier.changes.length, 0);

  const moved = await service.update("42", created.itemId, OWNER, { version: 3, startsAt: "2026-12-05T15:30:00-08:00", notify: true });
  assert.deepEqual(moved.notification, { status: "QUEUED", recipients: 3 });
  assert.equal(notifier.changes.length, 1);
  const [change] = notifier.changes;
  assert.equal(change!.type, "UPDATED");
  assert.equal(change!.eventId, "42");
  assert.deepEqual(change!.changedFields, ["startsAt"]);
  assert.equal(change!.before.startsAt, "2026-12-05T23:00:00Z");
  assert.equal(change!.after!.startsAt, "2026-12-05T23:30:00Z");
});

test("deleting with notify sends a DELETED change; without notify sends nothing", async () => {
  const { service, notifier } = setup();
  const a = await service.create("42", OWNER, ceremony);
  const b = await service.create("42", OWNER, { title: "Dinner", startsAt: "2026-12-06T01:45:00Z" });

  assert.deepEqual(await service.delete("42", a.itemId, OWNER), { notification: { status: "NOT_REQUESTED", recipients: 0 } });
  const result = await service.delete("42", b.itemId, OWNER, { notify: "true" });
  assert.equal(result.notification.status, "QUEUED");
  assert.equal(notifier.changes[0]!.type, "DELETED");
  assert.equal(notifier.changes[0]!.before.title, "Dinner");
  assert.equal(notifier.changes[0]!.after, null);
  await rejectsWith(service.delete("42", b.itemId, OWNER), 404, "NOT_FOUND");
});

test("a failed notification still saves the edit, reports FAILED and logs no addresses", async () => {
  const { service, logged } = setup(new RecordingNotifier(new Error("SQS unavailable for guest@example.com")));
  const created = await service.create("42", OWNER, ceremony);
  const result = await service.update("42", created.itemId, OWNER, { version: 1, title: "Moved", notify: true });
  assert.equal(result.item.title, "Moved");
  assert.deepEqual(result.notification, { status: "FAILED", recipients: 0 });
  assert.deepEqual(logged, ["Timeline updated notification failed for event 42"]);
});

test("without a notifier configured, a requested notification reaches nobody", async () => {
  assert.deepEqual(await notificationsNotConfigured.timelineChanged({} as never), { status: "NO_RECIPIENTS", recipients: 0 });
});

test("changedFieldsBetween treats omitted optional fields as null; isNotifiable ignores notes and reminders", () => {
  const base = { title: "A", startsAt: "2026-12-05T23:00:00Z", visibility: "GUESTS", reminderMinutes: 60 } as TimelineRecord;
  assert.deepEqual(changedFieldsBetween(base, { ...base, place: undefined }), []);
  assert.deepEqual(changedFieldsBetween(base, { ...base, place: "Hall", visibility: "TEAM" }), ["place", "visibility"]);
  assert.equal(isNotifiable({ type: "UPDATED", changedFields: ["notes", "reminderMinutes"] }), false);
  assert.equal(isNotifiable({ type: "UPDATED", changedFields: ["visibility"] }), true);
  assert.equal(isNotifiable({ type: "DELETED", changedFields: [] }), true);
});

// --- Past times (same rule as the RSVP deadline) ----------------------------------------

function clockSetup(start: string) {
  let now = new Date(start);
  const store = new MemoryTimelineStore();
  const service = new TimelineService({
    repository: store,
    requireMember: memberships([["42", OWNER]]).check,
    notifier: new RecordingNotifier(),
    now: () => now,
    logError: () => {},
  });
  return { service, store, moveTo: (instant: string) => { now = new Date(instant); } };
}

async function rejectsField(promise: Promise<unknown>, field: string, message: string) {
  await assert.rejects(promise, (error: ApiError) => {
    assert.equal(error.status, 422);
    assert.equal(error.code, "VALIDATION_ERROR");
    assert.deepEqual(error.fields, { [field]: message });
    return true;
  });
}

test("a new activity must start in the future; exactly now counts as past", async () => {
  const { service, store } = clockSetup("2026-12-05T20:00:00Z");
  await rejectsField(service.create("42", OWNER, { title: "Yesterday", startsAt: "2026-12-04T20:00:00Z" }),
    "startsAt", "The start time must be in the future.");
  await rejectsField(service.create("42", OWNER, { title: "Now", startsAt: "2026-12-05T20:00:00Z" }),
    "startsAt", "The start time must be in the future.");
  assert.equal(store.records.size, 0);
  const item = await service.create("42", OWNER, { title: "Soon", startsAt: "2026-12-05T20:01:00Z" });
  assert.equal(item.startsAt, "2026-12-05T20:01:00Z");
});

test("an activity can't be moved into the past, and its end can't be changed to the past", async () => {
  const { service, moveTo } = clockSetup("2026-12-05T12:00:00Z");
  const item = await service.create("42", OWNER, { title: "Ceremony", startsAt: "2026-12-05T23:00:00Z", endsAt: "2026-12-05T23:30:00Z" });
  await rejectsField(service.update("42", item.itemId, OWNER, { version: 1, startsAt: "2026-12-05T11:00:00Z" }),
    "startsAt", "The start time must be in the future.");

  moveTo("2026-12-05T23:10:00Z"); // the ceremony has started
  await rejectsField(service.update("42", item.itemId, OWNER, { version: 1, endsAt: "2026-12-05T23:05:00Z" }),
    "endsAt", "The end time must be in the future.");
  // Extending a running activity into the future is fine.
  const extended = await service.update("42", item.itemId, OWNER, { version: 1, endsAt: "2026-12-05T23:45:00Z" });
  assert.equal(extended.item.endsAt, "2026-12-05T23:45:00Z");
});

test("an activity that is already over can still have its details corrected", async () => {
  const { service, moveTo } = clockSetup("2026-12-05T12:00:00Z");
  const item = await service.create("42", OWNER, { title: "Ceremony", place: "Garden", startsAt: "2026-12-05T23:00:00Z", endsAt: "2026-12-05T23:30:00Z" });
  moveTo("2026-12-06T02:00:00Z"); // after the ceremony

  const fixed = await service.update("42", item.itemId, OWNER, { version: 1, title: "Ceremony (moved indoors)", place: "Main hall", notes: "Rain plan" });
  assert.equal(fixed.item.title, "Ceremony (moved indoors)");
  // Re-sending the unchanged times (what a full edit form does) is not a change.
  const same = await service.update("42", item.itemId, OWNER, { version: 2, startsAt: "2026-12-05T15:00:00-08:00", endsAt: "2026-12-05T23:30:00Z", notes: "Rain plan." });
  assert.equal(same.item.version, 3);
  // Clearing the end time is allowed too.
  const cleared = await service.update("42", item.itemId, OWNER, { version: 3, endsAt: null });
  assert.equal(cleared.item.endsAt, null);
});
