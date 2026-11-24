// Activity reminders: due-reminder query and claim, the reminder run and its Lambda
// (no AWS, Docker or MySQL needed).

import assert from "node:assert/strict";
import { test } from "node:test";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createRemindersHandler } from "../../timeline-service/lambda/reminders";
import type { TimelineEmailMessage } from "../../timeline-service/notifications/messages";
import { RecipientResolver } from "../../timeline-service/notifications/recipients";
import { MAX_REMINDERS_PER_RUN, ReminderService } from "../../timeline-service/notifications/reminderService";
import { TimelineRepository } from "../../timeline-service/repositories/timelineRepository";
import type { NewTimelineItem } from "../../timeline-service/types";
import { MemoryTimelineStore } from "./fakes";

const SECRET = "timeline-secret-0123456789abcdef-xyz";
const LINKS = { origin: "https://main.example.amplifyapp.com", secret: SECRET };
const NOW = new Date("2026-12-05T22:02:00Z");

// --- Repository (fake DynamoDB client) ---------------------------------------------------

function fakeClient(responders: ((input: Record<string, any>) => unknown)[]) {
  const sent: { name: string; input: Record<string, any> }[] = [];
  const client = {
    async send(command: { constructor: { name: string }; input: Record<string, any> }) {
      sent.push({ name: command.constructor.name, input: command.input });
      const respond = responders.shift();
      if (!respond) throw new Error("unexpected command");
      return respond(command.input);
    },
  } as unknown as DynamoDBDocumentClient;
  return { repo: new TimelineRepository({ client, tableName: "T" }), sent };
}

test("listDueReminders queries the sparse ReminderIndex for PENDING reminders due by now, up to the limit", async () => {
  const { repo, sent } = fakeClient([
    () => ({ Items: [{ itemId: "a" }, { itemId: "b" }], LastEvaluatedKey: { k: 1 } }),
    () => ({ Items: [{ itemId: "c" }] }),
  ]);
  const due = await repo.listDueReminders(new Date("2026-12-05T22:02:30.500Z"), 3);
  assert.deepEqual(due.map((r) => r.itemId), ["a", "b", "c"]);
  assert.equal(sent[0]!.name, "QueryCommand");
  assert.equal(sent[0]!.input.IndexName, "ReminderIndex");
  assert.equal(sent[0]!.input.KeyConditionExpression, "reminderStatus = :pending AND reminderAt <= :now");
  assert.deepEqual(sent[0]!.input.ExpressionAttributeValues, { ":pending": "PENDING", ":now": "2026-12-05T22:02:30Z" });
  assert.equal(sent[0]!.input.Limit, 3);
  assert.equal(sent[1]!.input.Limit, 1);
});

test("claimReminder succeeds only while still PENDING at the reminder time that was seen", async () => {
  const { repo, sent } = fakeClient([
    () => ({ Attributes: { itemId: "a", reminderSentAt: "2026-12-05T22:02:00Z" } }),
    () => { throw new ConditionalCheckFailedException({ message: "x", $metadata: {} }); },
    () => ({ Attributes: { itemId: "b" } }),
  ]);
  const record = { eventId: "42", itemId: "a", reminderAt: "2026-12-05T22:00:00Z" };
  assert.equal((await repo.claimReminder(record, "SENT", NOW))?.itemId, "a");
  assert.deepEqual(sent[0]!.input.Key, { eventId: "42", sk: "ITEM#a" });
  assert.equal(sent[0]!.input.UpdateExpression, "SET #mark = :now REMOVE #status");
  assert.equal(sent[0]!.input.ConditionExpression, "#status = :pending AND #reminderAt = :seen");
  assert.equal(sent[0]!.input.ExpressionAttributeNames["#mark"], "reminderSentAt");
  assert.equal(sent[0]!.input.ExpressionAttributeValues[":seen"], "2026-12-05T22:00:00Z");

  assert.equal(await repo.claimReminder(record, "SENT", NOW), null);

  await repo.claimReminder({ ...record, itemId: "b" }, "SKIPPED", NOW);
  assert.equal(sent[2]!.input.ExpressionAttributeNames["#mark"], "reminderSkippedAt");
});

// --- Reminder run ------------------------------------------------------------------------

const base: Omit<NewTimelineItem, "title" | "startsAt" | "reminderAt"> = {
  place: "Garden", notes: null, endsAt: null, visibility: "GUESTS", reminderMinutes: 60,
};

async function setup(options: { publishFails?: number; links?: typeof LINKS | { origin?: string } } = {}) {
  const store = new MemoryTimelineStore();
  await store.putSubscriber("42", "sub-owner", "maya@example.com");
  const published: TimelineEmailMessage[][] = [];
  const logged: string[] = [];
  const eventLookups: string[] = [];
  const service = new ReminderService({
    repository: store,
    recipients: new RecipientResolver({
      subscribers: store,
      members: async () => new Set(["sub-owner"]),
      guests: async () => [{ email: "aunt.jo@example.com", rsvpStatus: "ATTENDING" }, { email: "no@example.com", rsvpStatus: "DECLINED" }],
    }),
    publish: async (messages) => {
      published.push(messages);
      const failed = Math.min(options.publishFails ?? 0, messages.length);
      return { queued: messages.length - failed, failed };
    },
    links: options.links ?? LINKS,
    events: async (eventId) => {
      eventLookups.push(eventId);
      return { name: "Maya & Eli's Wedding", eventDate: "2026-12-05", venue: null };
    },
    now: () => NOW,
    log: (line) => logged.push(line),
  });
  const add = (title: string, startsAt: string, reminderAt: string | null, extra: Partial<NewTimelineItem> = {}) =>
    store.createItem("42", { ...base, title, startsAt, reminderAt, ...extra }, "sub-owner");
  return { store, service, published, logged, eventLookups, add };
}

test("a due reminder is sent once to organizers and guests, then leaves the queue", async () => {
  const { store, service, published, add } = await setup();
  const ceremony = await add("Ceremony", "2026-12-05T23:00:00Z", "2026-12-05T22:00:00Z");
  await add("Dinner", "2026-12-06T01:45:00Z", "2026-12-06T00:45:00Z"); // not due yet

  const summary = await service.run();
  assert.equal(summary.due, 1);
  assert.equal(summary.sent, 1);
  assert.equal(summary.messagesQueued, 2);
  assert.deepEqual(published[0]!.map((m) => `${m.type}:${m.audience}:${m.to}`), [
    "TIMELINE_REMINDER:ORGANIZER:maya@example.com",
    "TIMELINE_REMINDER:GUEST:aunt.jo@example.com",
  ]);
  assert.equal(published[0]![0]!.item.title, "Ceremony");
  assert.equal(published[0]![0]!.eventName, "Maya & Eli's Wedding");

  const stored = (await store.getItem("42", ceremony.itemId))!;
  assert.equal(stored.reminderStatus, undefined);
  assert.equal(stored.reminderSentAt, "2026-12-05T22:02:00Z");

  // A second run finds nothing to do.
  assert.equal((await service.run()).due, 0);
  assert.equal(published.length, 1);
});

test("TEAM reminders go to organizers only", async () => {
  const { service, published, add } = await setup();
  await add("Vendor setup", "2026-12-05T23:00:00Z", "2026-12-05T22:00:00Z", { visibility: "TEAM" });
  await service.run();
  assert.deepEqual(published[0]!.map((m) => m.to), ["maya@example.com"]);
});

test("a reminder for an activity that already started is skipped, not sent late", async () => {
  const { store, service, published, add } = await setup();
  const late = await add("Rehearsal", "2026-12-05T22:00:00Z", "2026-12-05T21:00:00Z");
  const summary = await service.run();
  assert.equal(summary.skipped, 1);
  assert.equal(summary.sent, 0);
  assert.equal(published.length, 0);
  const stored = (await store.getItem("42", late.itemId))!;
  assert.equal(stored.reminderStatus, undefined);
  assert.equal(stored.reminderSkippedAt, "2026-12-05T22:02:00Z");
  assert.equal(stored.reminderSentAt, undefined);
});

test("overlapping runs and moved activities never double-send", async () => {
  const { store, service, published, add } = await setup();
  const ceremony = await add("Ceremony", "2026-12-05T23:00:00Z", "2026-12-05T22:00:00Z");
  // Another run claims it between our list and our claim.
  const list = store.listDueReminders.bind(store);
  store.listDueReminders = async (now, limit) => {
    const due = await list(now, limit);
    await store.claimReminder(due[0]!, "SENT", now);
    return due;
  };
  const summary = await service.run();
  assert.equal(summary.alreadyClaimed, 1);
  assert.equal(published.length, 0);

  // An activity moved (new reminderAt) after being listed is left for its new time.
  const moved = await setup();
  const item = await moved.add("Toasts", "2026-12-05T23:00:00Z", "2026-12-05T22:00:00Z");
  const listMoved = moved.store.listDueReminders.bind(moved.store);
  moved.store.listDueReminders = async (now, limit) => {
    const due = await listMoved(now, limit);
    await moved.store.updateItem("42", item.itemId, 1, { startsAt: "2026-12-06T02:00:00Z", reminderAt: "2026-12-06T01:00:00Z" }, "s");
    return due;
  };
  assert.equal((await moved.service.run()).alreadyClaimed, 1);
  assert.equal((await moved.store.getItem("42", item.itemId))!.reminderStatus, "PENDING");
  void ceremony;
});

test("missing settings leave reminders PENDING and are logged by name", async () => {
  const { store, service, logged, add } = await setup({ links: { origin: "https://main.example.amplifyapp.com" } });
  const item = await add("Ceremony", "2026-12-05T23:00:00Z", "2026-12-05T22:00:00Z");
  const summary = await service.run();
  assert.equal(summary.errors, 1);
  assert.equal((await store.getItem("42", item.itemId))!.reminderStatus, "PENDING");
  assert.ok(logged.some((line) => line.includes("TIMELINE_SHARE_SECRET")));
});

test("SQS failures are counted, the summary is logged without addresses, and event names are cached", async () => {
  const { service, logged, eventLookups, add } = await setup({ publishFails: 1 });
  await add("Ceremony", "2026-12-05T23:00:00Z", "2026-12-05T22:00:00Z");
  await add("Cocktails", "2026-12-05T23:30:00Z", "2026-12-05T22:00:00Z", { reminderMinutes: 15 });
  const summary = await service.run();
  assert.equal(summary.sent, 2);
  assert.equal(summary.messagesQueued, 2);
  assert.equal(summary.messagesFailed, 2);
  assert.deepEqual(eventLookups, ["42"]);
  assert.equal(logged.join("\n").includes("@"), false);
  assert.match(logged.at(-1)!, /^Timeline reminders: \{"due":2,"sent":2/);
});

test("a run handles at most MAX_REMINDERS_PER_RUN reminders", async () => {
  const { service, add } = await setup();
  for (let i = 0; i < MAX_REMINDERS_PER_RUN + 3; i++) await add(`A${i}`, "2026-12-05T23:00:00Z", "2026-12-05T22:00:00Z");
  assert.equal((await service.run()).due, MAX_REMINDERS_PER_RUN);
});

test("the reminders handler returns the run summary", async () => {
  const handler = createRemindersHandler({ run: async () => ({ due: 0, sent: 0, skipped: 0, alreadyClaimed: 0, noRecipients: 0, messagesQueued: 0, messagesFailed: 0, errors: 0 }) });
  assert.equal((await handler()).due, 0);
});
