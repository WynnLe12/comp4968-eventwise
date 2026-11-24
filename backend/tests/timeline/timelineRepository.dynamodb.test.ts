// Opt-in integration test against DynamoDB Local. Skipped unless enabled:
//
//   npm run ddb:up && DYNAMODB_ENDPOINT=http://127.0.0.1:8000 npm run ddb:create-timeline-table
//   EVENTWISE_DYNAMODB_TEST=1 DYNAMODB_ENDPOINT=http://127.0.0.1:8000 npm test
//
// Uses a random event ID and deletes what it creates. Refuses to run against AWS.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createDocumentClient, isLocalEndpoint } from "../../shared/db/dynamodb";
import { TimelineRepository } from "../../timeline-service/repositories/timelineRepository";

const enabled = process.env.EVENTWISE_DYNAMODB_TEST === "1" && isLocalEndpoint(process.env.DYNAMODB_ENDPOINT);

test("DynamoDB Local: create, list, versioned update, reminders, subscribers and delete", { skip: !enabled }, async () => {
  const client = createDocumentClient();
  const repo = new TimelineRepository({ client });
  const eventId = `test-${randomUUID()}`;
  try {
    const dinner = await repo.createItem(eventId, {
      title: "Dinner", place: "Main hall", notes: null, startsAt: "2026-12-06T01:45:00Z", endsAt: null,
      visibility: "GUESTS", reminderMinutes: 0, reminderAt: null,
    }, "sub-owner");
    const ceremony = await repo.createItem(eventId, {
      title: "Ceremony", place: "Garden", notes: "Outdoor", startsAt: "2026-12-05T23:00:00Z", endsAt: null,
      visibility: "GUESTS", reminderMinutes: 60, reminderAt: "2026-12-05T22:00:00Z",
    }, "sub-owner");

    assert.deepEqual((await repo.listItems(eventId)).map((r) => r.title), ["Ceremony", "Dinner"]);
    assert.equal(await repo.countItems(eventId), 2);

    // Move the ceremony, clear its notes, reschedule its reminder.
    const moved = await repo.updateItem(eventId, ceremony.itemId, 1, {
      startsAt: "2026-12-06T02:00:00Z", notes: null, reminderAt: "2026-12-06T01:00:00Z",
    }, "sub-planner");
    assert.equal(moved.status, "UPDATED");
    const reread = await repo.getItem(eventId, ceremony.itemId);
    assert.equal(reread?.version, 2);
    assert.equal(reread?.startsAt, "2026-12-06T02:00:00Z");
    assert.equal(reread?.notes, undefined);
    assert.equal(reread?.reminderStatus, "PENDING");
    assert.equal(reread?.updatedBy, "sub-planner");
    if (moved.status === "UPDATED") assert.deepEqual(moved.record, reread);

    // Same stale version again: conflict. Unknown item: not found.
    assert.equal((await repo.updateItem(eventId, ceremony.itemId, 1, { title: "x" }, "s")).status, "VERSION_CONFLICT");
    assert.equal((await repo.updateItem(eventId, randomUUID(), 1, { title: "x" }, "s")).status, "NOT_FOUND");

    // Cancel the reminder.
    await repo.updateItem(eventId, ceremony.itemId, 2, { reminderMinutes: 0, reminderAt: null }, "s");
    const cancelled = await repo.getItem(eventId, ceremony.itemId);
    assert.equal(cancelled?.reminderAt, undefined);
    assert.equal(cancelled?.reminderStatus, undefined);

    assert.deepEqual((await repo.listItems(eventId)).map((r) => r.title), ["Dinner", "Ceremony"]);

    // Reminders: the sparse index lists the due one, and only the first claim wins.
    const reminder = await repo.createItem(eventId, {
      title: "Reminder test", place: null, notes: null, startsAt: "2001-01-01T01:00:00Z", endsAt: null,
      visibility: "TEAM", reminderMinutes: 60, reminderAt: "2001-01-01T00:00:00Z",
    }, "sub-owner");
    const due = (await repo.listDueReminders(new Date("2001-01-01T00:05:00Z"), 100)).filter((r) => r.eventId === eventId);
    assert.deepEqual(due.map((r) => r.itemId), [reminder.itemId]);
    assert.equal((await repo.claimReminder(due[0]!, "SENT", new Date("2001-01-01T00:05:00Z")))?.reminderSentAt, "2001-01-01T00:05:00Z");
    assert.equal(await repo.claimReminder(due[0]!, "SENT", new Date("2001-01-01T00:05:00Z")), null);
    assert.equal((await repo.getItem(eventId, reminder.itemId))?.reminderStatus, undefined);
    await repo.deleteItem(eventId, reminder.itemId);

    // Subscribers share the partition but never appear in the activity list.
    await repo.putSubscriber(eventId, "sub-owner", "maya@example.com");
    await repo.putSubscriber(eventId, "sub-planner", "eli@example.com");
    assert.deepEqual((await repo.listSubscribers(eventId)).map((r) => r.email).sort(), ["eli@example.com", "maya@example.com"]);
    assert.equal((await repo.getSubscriber(eventId, "sub-owner"))?.email, "maya@example.com");
    assert.equal(await repo.countItems(eventId), 2);
    await repo.deleteSubscriber(eventId, "sub-owner");
    await repo.deleteSubscriber(eventId, "sub-owner");
    assert.equal(await repo.getSubscriber(eventId, "sub-owner"), null);
    assert.equal((await repo.deleteItem(eventId, dinner.itemId))?.title, "Dinner");
    assert.equal(await repo.deleteItem(eventId, dinner.itemId), null);
  } finally {
    for (const record of await repo.listItems(eventId)) await repo.deleteItem(eventId, record.itemId);
    for (const record of await repo.listSubscribers(eventId)) await repo.deleteSubscriber(eventId, record.sub);
    client.destroy();
  }
});
