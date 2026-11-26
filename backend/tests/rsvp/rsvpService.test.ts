// RSVP service and deadline workflow steps with in-memory fakes (no AWS needed).

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ApiError } from "../../expense-service/errors";
import { createRsvpToken } from "../../rsvp-service/rsvpLink";
import { DeadlineService, RemindersIncompleteError } from "../../rsvp-service/services/deadlineService";
import { RsvpService } from "../../rsvp-service/services/rsvpService";
import { AUTH, FakeWorkflow, LINKS, MemoryRsvpStore, SECRET, fakeEventAccess, fakePublisher, guest } from "./fakes";

const EVENT = { eventName: "Maya & Eli's Wedding", eventDate: "2026-12-05", venue: "The Willow House" };
const SETTINGS_BODY = { deadline: "2026-12-01T07:59:00Z", startTime: "16:00", reminderDaysBefore: 2, message: "Hope you can come!" };

function setup(failFor: string[] = []) {
  let now = new Date("2026-11-20T18:00:00Z");
  let ids = 0;
  const store = new MemoryRsvpStore();
  store.addGuest(guest({ guestId: "g1", firstName: "Sofia", lastName: "Martinez", email: "sofia@example.com", plusOneAllowed: true }));
  store.addGuest(guest({ guestId: "g2", firstName: "James", email: "james@example.com" }));
  store.addGuest(guest({ guestId: "g3", firstName: "No Email" }));
  store.addGuest(guest({ guestId: "g4", firstName: "Already", email: "already@example.com", rsvpStatus: "ACCEPTED" }));
  store.addGuest(guest({ eventId: "77", guestId: "x1", firstName: "Other event", email: "other@example.com" }));
  const access = fakeEventAccess({ "42": EVENT, "77": { ...EVENT, eventName: "Other" } }, { "42": [AUTH], "77": ["Bearer someone-else"] });
  const workflow = new FakeWorkflow();
  const publish = fakePublisher(failFor);
  const service = new RsvpService({
    repository: store, eventAccess: access, workflow, publish, links: LINKS,
    now: () => now, newId: () => `wf-${++ids}`,
  });
  const deadline = new DeadlineService({ repository: store, publish, links: LINKS, now: () => now, log: () => {} });
  return { store, access, workflow, publish, service, deadline, setNow: (value: string) => { now = new Date(value); } };
}

const token = (guestId: string, eventId = "42") => createRsvpToken({ eventId, guestId }, SECRET);

async function rejects(promise: Promise<unknown>, status: number, code: string) {
  await assert.rejects(promise, (error: ApiError) => error.status === status && error.code === code);
}

test("sending invitations emails each uninvited guest with an address and schedules the workflow first", async () => {
  const { store, workflow, publish, service } = setup();
  const result = await service.sendInvitations("42", "sub-1", AUTH, SETTINGS_BODY);

  assert.equal(result.queued, 2);
  assert.equal(result.failed, 0);
  assert.equal(result.skippedNoEmail, 1);
  assert.deepEqual(publish.sent.map((m) => m.to).sort(), ["james@example.com", "sofia@example.com"]);
  assert.equal(store.guest("42", "g1")!.rsvpStatus, "PENDING");
  assert.equal(store.guest("42", "g3")!.rsvpStatus, "UNINVITED"); // no email
  assert.equal(store.guest("42", "g4")!.rsvpStatus, "ACCEPTED"); // already answered
  assert.equal(store.guest("77", "x1")!.rsvpStatus, "UNINVITED"); // other event untouched

  assert.deepEqual(workflow.started, [{ eventId: "42", workflowId: "wf-1", reminderAt: "2026-11-29T07:59:00Z", deadline: "2026-12-01T07:59:00Z" }]);
  const message = publish.sent.find((m) => m.to === "sofia@example.com")!;
  assert.equal(message.type, "RSVP_INVITATION");
  assert.equal(message.guestName, "Sofia Martinez");
  assert.equal(message.venue, "The Willow House");
  assert.equal(message.startTime, "16:00");
  assert.ok(message.rsvpUrl.endsWith(encodeURIComponent(token("g1"))));
  assert.equal(result.settings.status, "OPEN");
  assert.equal(store.settings.get("42")!.executionArn?.endsWith("run-1"), true);
});

test("sending again only reaches new guests unless pending ones are included, and replaces the workflow", async () => {
  const { store, workflow, publish, service } = setup();
  await service.sendInvitations("42", "sub-1", AUTH, SETTINGS_BODY);
  store.addGuest(guest({ guestId: "g5", firstName: "New", email: "new@example.com" }));
  publish.sent.length = 0;

  const second = await service.sendInvitations("42", "sub-1", AUTH, SETTINGS_BODY);
  assert.deepEqual(publish.sent.map((m) => m.to), ["new@example.com"]);
  assert.equal(second.queued, 1);
  assert.deepEqual(workflow.stopped, ["arn:aws:states:us-west-2:123456789012:execution:eventwise-rsvp-deadline:run-1"]);
  assert.equal(store.settings.get("42")!.workflowId, "wf-2");

  publish.sent.length = 0;
  await service.sendInvitations("42", "sub-1", AUTH, { ...SETTINGS_BODY, includePending: true });
  assert.equal(publish.sent.length, 3); // g1, g2, g5 are all still pending
});

test("a guest whose email couldn't be queued stays uninvited so a later send retries them", async () => {
  const { store, service } = setup(["james@example.com"]);
  const result = await service.sendInvitations("42", "sub-1", AUTH, SETTINGS_BODY);
  assert.equal(result.queued, 1);
  assert.equal(result.failed, 1);
  assert.equal(store.guest("42", "g2")!.rsvpStatus, "UNINVITED");
});

test("if the workflow can't start, no invitations go out", async () => {
  const { workflow, publish, service } = setup();
  workflow.failStart = true;
  await rejects(service.sendInvitations("42", "sub-1", AUTH, SETTINGS_BODY), 502, "SCHEDULING_FAILED");
  assert.equal(publish.sent.length, 0);
});

test("organizer routes are for members only", async () => {
  const { service } = setup();
  await rejects(service.sendInvitations("77", "sub-1", AUTH, SETTINGS_BODY), 403, "FORBIDDEN");
  await rejects(service.getSettings("42", undefined), 401, "UNAUTHENTICATED");
  await rejects(service.guestLink("42", "missing", AUTH), 404, "NOT_FOUND");
  await rejects(service.guestLink("77", "x1", AUTH), 403, "FORBIDDEN");
  const { url } = await service.guestLink("42", "g1", AUTH);
  assert.ok(url.includes(encodeURIComponent(token("g1"))));
});

test("organizers see refreshed event details after the event is edited", async () => {
  const { store, service } = setup();
  await service.sendInvitations("42", "sub-1", AUTH, SETTINGS_BODY);
  assert.equal((await service.getSettings("42", AUTH)).settings?.venue, "The Willow House");
  // Simulate the Event API now returning a new venue.
  const moved = new RsvpService({
    repository: store,
    eventAccess: fakeEventAccess({ "42": { ...EVENT, venue: "Garden Room" } }),
    workflow: new FakeWorkflow(), publish: fakePublisher(), links: LINKS,
    now: () => new Date("2026-11-21T00:00:00Z"),
  });
  assert.equal((await moved.getSettings("42", AUTH)).settings?.venue, "Garden Room");
  assert.equal(store.settings.get("42")!.venue, "Garden Room");
  assert.equal((await service.getSettings("77", "Bearer someone-else")).settings, null);
});

test("guests see the event and their own answer, never their email or other guests", async () => {
  const { service } = setup();
  await service.sendInvitations("42", "sub-1", AUTH, SETTINGS_BODY);
  const view = await service.getForGuest(token("g1"));
  assert.deepEqual(view.event, { ...EVENT, startTime: "16:00" });
  assert.equal(view.message, "Hope you can come!");
  assert.equal(view.closed, false);
  assert.equal(view.guest.firstName, "Sofia");
  assert.equal(view.guest.plusOneAllowed, true);
  assert.equal(view.guest.rsvpStatus, "PENDING");
  assert.equal(JSON.stringify(view).includes("sofia@example.com"), false);
});

test("a guest accepts with a meal, allergies and a plus-one, then changes their mind", async () => {
  const { store, service } = setup();
  await service.sendInvitations("42", "sub-1", AUTH, SETTINGS_BODY);

  const accepted = await service.respond(token("g1"), { attending: true, mealChoice: "Vegetarian", dietaryNotes: "No nuts", plusOneAttending: true });
  assert.equal(accepted.guest.rsvpStatus, "ACCEPTED");
  assert.equal(accepted.guest.plusOneAttending, true);
  assert.equal(store.guest("42", "g1")!.dietaryNotes, "No nuts");
  assert.equal(store.guest("42", "g2")!.rsvpStatus, "PENDING"); // only this guest changed

  const declined = await service.respond(token("g1"), { attending: false, mealChoice: "", plusOneAttending: true });
  assert.equal(declined.guest.rsvpStatus, "REJECTED");
  assert.equal(declined.guest.plusOneAttending, false);
  assert.equal(store.guest("42", "g1")!.mealChoice, undefined);
});

test("invalid links, missing settings and guests without a plus-one are refused", async () => {
  const { service } = setup();
  await rejects(service.getForGuest(token("g1")), 404, "NOT_FOUND"); // no settings yet
  await service.sendInvitations("42", "sub-1", AUTH, SETTINGS_BODY);
  await rejects(service.getForGuest("42.g1.not-a-signature"), 404, "NOT_FOUND");
  await rejects(service.getForGuest(token("deleted")), 404, "NOT_FOUND");
  await rejects(service.respond(token("g2"), { attending: true, plusOneAttending: true }), 422, "VALIDATION_ERROR");
});

test("after the deadline the page shows closed and answers are refused", async () => {
  const { setNow, service } = setup();
  await service.sendInvitations("42", "sub-1", AUTH, SETTINGS_BODY);
  setNow("2026-12-01T08:00:00Z");
  assert.equal((await service.getForGuest(token("g1"))).closed, true);
  await rejects(service.respond(token("g1"), { attending: true }), 409, "RSVP_CLOSED");
  assert.equal((await service.getSettings("42", AUTH)).settings?.status, "CLOSED");
});

// --- Deadline workflow steps -----------------------------------------------------------

test("the reminder step emails each pending guest once, even if it runs again", async () => {
  const { store, publish, service, deadline, setNow } = setup();
  await service.sendInvitations("42", "sub-1", AUTH, SETTINGS_BODY);
  await service.respond(token("g2"), { attending: false });
  publish.sent.length = 0;
  setNow("2026-11-29T08:00:00Z");

  const first = await deadline.run({ action: "REMIND", eventId: "42", workflowId: "wf-1" });
  assert.deepEqual(first, { status: "REMINDED", reminded: 1, skippedNoEmail: 0 });
  assert.equal(publish.sent[0]!.type, "RSVP_REMINDER");
  assert.equal(publish.sent[0]!.to, "sofia@example.com");
  assert.ok(store.guest("42", "g1")!.reminderSentAt);

  const second = await deadline.run({ action: "REMIND", eventId: "42", workflowId: "wf-1" });
  assert.deepEqual(second, { status: "REMINDED", reminded: 0, skippedNoEmail: 0 });
  assert.equal(publish.sent.length, 1);
});

test("a reminder that couldn't be queued is released and the step fails so Step Functions retries", async () => {
  const { store, service, deadline, setNow } = setup(["sofia@example.com"]);
  // Sofia's invitation fails to queue too, so invite her by hand for this test.
  await service.sendInvitations("42", "sub-1", AUTH, SETTINGS_BODY);
  await store.markInvited({ eventId: "42", guestId: "g1" }, "2026-11-20T18:00:00Z");
  setNow("2026-11-29T08:00:00Z");
  await assert.rejects(deadline.run({ action: "REMIND", eventId: "42", workflowId: "wf-1" }), RemindersIncompleteError);
  assert.equal(store.guest("42", "g1")!.reminderSentAt, undefined);
});

test("stale workflow runs do nothing, and the close step closes RSVPs", async () => {
  const { store, publish, service, deadline } = setup();
  await service.sendInvitations("42", "sub-1", AUTH, SETTINGS_BODY);
  await service.sendInvitations("42", "sub-1", AUTH, SETTINGS_BODY); // now wf-2
  publish.sent.length = 0;

  assert.deepEqual(await deadline.run({ action: "REMIND", eventId: "42", workflowId: "wf-1" }), { status: "STALE" });
  assert.deepEqual(await deadline.run({ action: "CLOSE", eventId: "42", workflowId: "wf-1" }), { status: "STALE" });
  assert.equal(publish.sent.length, 0);
  assert.equal(store.settings.get("42")!.status, "OPEN");

  assert.deepEqual(await deadline.run({ action: "CLOSE", eventId: "42", workflowId: "wf-2" }), { status: "CLOSED" });
  assert.equal(store.settings.get("42")!.status, "CLOSED");
  await rejects(service.respond(token("g1"), { attending: true }), 409, "RSVP_CLOSED");
  await assert.rejects(deadline.run({ action: "DELETE", eventId: "42", workflowId: "wf-2" }), /Invalid deadline task/);
});
