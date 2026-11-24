// Unit tests for TimelineRepository and the timeline mapper with a fake DynamoDB client
// (no AWS or Docker needed). The fake records each command and returns queued responses.

import assert from "node:assert/strict";
import { test } from "node:test";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { TimelineRepository, utcSeconds } from "../../timeline-service/repositories/timelineRepository";
import {
  compareTimeline,
  isGuestVisible,
  toGuestTimelineItem,
  toTimelineItem,
} from "../../timeline-service/services/timelineMapper";
import type { NewTimelineItem, TimelineRecord } from "../../timeline-service/types";

type Command = { constructor: { name: string }; input: Record<string, any> };
type Responder = (command: Command) => unknown;

function fakeClient(responders: Responder[]) {
  const sent: Command[] = [];
  const client = {
    async send(command: Command) {
      sent.push(command);
      const respond = responders.shift();
      if (!respond) throw new Error(`Unexpected command ${command.constructor.name}`);
      return respond(command);
    },
  } as unknown as DynamoDBDocumentClient;
  return { client, sent };
}

const ITEM_ID = "3b1f0c2e-8d4a-4f6b-9e21-7a5c2d9e0f13";

function repository(responders: Responder[]) {
  const fake = fakeClient(responders);
  const repo = new TimelineRepository({
    client: fake.client,
    tableName: "TestTimeline",
    now: () => new Date("2026-11-24T05:12:44.321Z"),
    newId: () => ITEM_ID,
  });
  return { repo, sent: fake.sent };
}

function conditionFailed(item?: Record<string, unknown>) {
  return () => {
    throw new ConditionalCheckFailedException({
      message: "The conditional request failed",
      $metadata: {},
      ...(item ? { Item: item as never } : {}),
    });
  };
}

const newItem: NewTimelineItem = {
  title: "Ceremony begins",
  place: "Garden ceremony",
  notes: null,
  startsAt: "2026-12-05T23:00:00Z",
  endsAt: null,
  visibility: "GUESTS",
  reminderMinutes: 60,
  reminderAt: "2026-12-05T22:00:00Z",
};

function stored(overrides: Partial<TimelineRecord> = {}): TimelineRecord {
  return {
    eventId: "42",
    sk: `ITEM#${ITEM_ID}`,
    itemId: ITEM_ID,
    title: "Ceremony begins",
    place: "Garden ceremony",
    startsAt: "2026-12-05T23:00:00Z",
    visibility: "GUESTS",
    reminderMinutes: 60,
    reminderAt: "2026-12-05T22:00:00Z",
    reminderStatus: "PENDING",
    version: 3,
    createdBy: "sub-owner",
    updatedBy: "sub-owner",
    createdAt: "2026-11-24T05:00:00Z",
    updatedAt: "2026-11-24T05:00:00Z",
    ...overrides,
  };
}

// --- create -----------------------------------------------------------------

test("createItem stores version 1, a PENDING reminder, no empty fields, and never overwrites", async () => {
  const { repo, sent } = repository([() => ({})]);
  const record = await repo.createItem("42", newItem, "sub-owner");

  assert.equal(sent[0]!.constructor.name, "PutCommand");
  assert.equal(sent[0]!.input.TableName, "TestTimeline");
  assert.equal(sent[0]!.input.ConditionExpression, "attribute_not_exists(sk)");
  assert.deepEqual(sent[0]!.input.Item, record);
  assert.deepEqual(record, {
    eventId: "42",
    sk: `ITEM#${ITEM_ID}`,
    itemId: ITEM_ID,
    title: "Ceremony begins",
    place: "Garden ceremony",
    startsAt: "2026-12-05T23:00:00Z",
    visibility: "GUESTS",
    reminderMinutes: 60,
    reminderAt: "2026-12-05T22:00:00Z",
    reminderStatus: "PENDING",
    version: 1,
    createdBy: "sub-owner",
    updatedBy: "sub-owner",
    createdAt: "2026-11-24T05:12:44Z",
    updatedAt: "2026-11-24T05:12:44Z",
  });
});

test("createItem without a reminder leaves the activity out of ReminderIndex", async () => {
  const { repo } = repository([() => ({})]);
  const record = await repo.createItem("42", { ...newItem, reminderMinutes: 0, reminderAt: null }, "sub-owner");
  assert.equal("reminderAt" in record, false);
  assert.equal("reminderStatus" in record, false);
});

// --- read -------------------------------------------------------------------

test("listItems queries only this event's activities, follows pages and sorts chronologically", async () => {
  const { repo, sent } = repository([
    () => ({
      Items: [
        stored({ itemId: "c", title: "Dinner", startsAt: "2026-12-06T01:45:00Z" }),
        stored({ itemId: "b", title: "Ceremony", startsAt: "2026-12-05T23:00:00Z" }),
      ],
      LastEvaluatedKey: { eventId: "42", sk: "ITEM#c" },
    }),
    () => ({ Items: [stored({ itemId: "a", title: "Ceremony", startsAt: "2026-12-05T23:00:00Z" })] }),
  ]);
  const records = await repo.listItems("42");

  assert.equal(sent.length, 2);
  assert.equal(sent[0]!.input.KeyConditionExpression, "eventId = :eventId AND begins_with(sk, :prefix)");
  assert.deepEqual(sent[0]!.input.ExpressionAttributeValues, { ":eventId": "42", ":prefix": "ITEM#" });
  assert.deepEqual(sent[1]!.input.ExclusiveStartKey, { eventId: "42", sk: "ITEM#c" });
  // Same start time and title: itemId breaks the tie.
  assert.deepEqual(records.map((r) => r.itemId), ["a", "b", "c"]);
});

test("countItems counts activities without reading them", async () => {
  const { repo, sent } = repository([
    () => ({ Count: 25, LastEvaluatedKey: { eventId: "42", sk: "ITEM#x" } }),
    () => ({ Count: 3 }),
  ]);
  assert.equal(await repo.countItems("42"), 28);
  assert.equal(sent[0]!.input.Select, "COUNT");
  assert.deepEqual(sent[0]!.input.ExpressionAttributeValues, { ":eventId": "42", ":prefix": "ITEM#" });
});

test("getItem uses the event + ITEM# key with a consistent read, and returns null when absent", async () => {
  const { repo, sent } = repository([() => ({})]);
  assert.equal(await repo.getItem("42", ITEM_ID), null);
  assert.deepEqual(sent[0]!.input.Key, { eventId: "42", sk: `ITEM#${ITEM_ID}` });
  assert.equal(sent[0]!.input.ConsistentRead, true);
});

// --- update -----------------------------------------------------------------

test("updateItem sets, clears and bumps the version only at the expected version", async () => {
  const previous = stored({ notes: "Bring umbrellas" });
  const { repo, sent } = repository([() => ({ Attributes: previous })]);
  const outcome = await repo.updateItem("42", ITEM_ID, 3, { place: "Main hall", notes: null }, "sub-planner");

  const input = sent[0]!.input;
  assert.equal(sent[0]!.constructor.name, "UpdateCommand");
  assert.deepEqual(input.Key, { eventId: "42", sk: `ITEM#${ITEM_ID}` });
  assert.equal(input.ConditionExpression, "attribute_exists(sk) AND #version = :expected");
  assert.equal(input.ExpressionAttributeValues[":expected"], 3);
  assert.equal(input.ReturnValues, "ALL_OLD");
  assert.equal(input.ReturnValuesOnConditionCheckFailure, "ALL_OLD");
  assert.match(input.UpdateExpression, /^SET #version = #version \+ :one, .*#place = :place/);
  assert.match(input.UpdateExpression, / REMOVE #notes$/);

  assert.equal(outcome.status, "UPDATED");
  if (outcome.status !== "UPDATED") return;
  assert.equal(outcome.previous, previous);
  assert.equal(outcome.record.place, "Main hall");
  assert.equal("notes" in outcome.record, false);
  assert.equal(outcome.record.version, 4);
  assert.equal(outcome.record.updatedBy, "sub-planner");
  assert.equal(outcome.record.updatedAt, "2026-11-24T05:12:44Z");
  // Reminder untouched when reminderAt is not in the changes.
  assert.equal(outcome.record.reminderStatus, "PENDING");
});

test("updateItem with a new reminderAt makes the reminder PENDING again and clears the sent mark", async () => {
  const previous = stored({ reminderStatus: undefined, reminderSentAt: "2026-12-05T22:00:30Z" });
  const { repo, sent } = repository([() => ({ Attributes: previous })]);
  const outcome = await repo.updateItem(
    "42", ITEM_ID, 3,
    { startsAt: "2026-12-05T23:30:00Z", reminderAt: "2026-12-05T22:30:00Z" },
    "sub-owner",
  );

  const input = sent[0]!.input;
  assert.match(input.UpdateExpression, /#reminderAt = :reminderAt, #reminderStatus = :pending/);
  assert.match(input.UpdateExpression, /REMOVE #reminderSentAt, #reminderSkippedAt$/);
  assert.equal(input.ExpressionAttributeValues[":pending"], "PENDING");
  assert.equal(outcome.status, "UPDATED");
  if (outcome.status !== "UPDATED") return;
  assert.equal(outcome.record.reminderAt, "2026-12-05T22:30:00Z");
  assert.equal(outcome.record.reminderStatus, "PENDING");
  assert.equal("reminderSentAt" in outcome.record, false);
});

test("updateItem with reminderAt null cancels the reminder", async () => {
  const { repo, sent } = repository([() => ({ Attributes: stored() })]);
  const outcome = await repo.updateItem("42", ITEM_ID, 3, { reminderMinutes: 0, reminderAt: null }, "sub-owner");

  assert.match(sent[0]!.input.UpdateExpression, /REMOVE #reminderAt, #reminderStatus, #reminderSentAt, #reminderSkippedAt$/);
  assert.equal(outcome.status, "UPDATED");
  if (outcome.status !== "UPDATED") return;
  assert.equal(outcome.record.reminderMinutes, 0);
  assert.equal("reminderAt" in outcome.record, false);
  assert.equal("reminderStatus" in outcome.record, false);
});

test("updateItem tells a version conflict apart from a missing activity", async () => {
  const conflict = repository([conditionFailed({ eventId: { S: "42" }, version: { N: "4" } })]);
  assert.deepEqual(await conflict.repo.updateItem("42", ITEM_ID, 3, { title: "New" }, "s"), { status: "VERSION_CONFLICT" });

  const missing = repository([conditionFailed()]);
  assert.deepEqual(await missing.repo.updateItem("42", ITEM_ID, 3, { title: "New" }, "s"), { status: "NOT_FOUND" });
});

test("updateItem refuses to clear a required field and rethrows other errors", async () => {
  const { repo } = repository([]);
  await assert.rejects(repo.updateItem("42", ITEM_ID, 1, { title: null as never }, "s"), /title cannot be cleared/);

  const failing = repository([() => { throw new Error("throttled"); }]);
  await assert.rejects(failing.repo.updateItem("42", ITEM_ID, 1, { title: "x" }, "s"), /throttled/);
});

test("updateItem never writes keys or audit fields from the changes object", async () => {
  const { repo, sent } = repository([() => ({ Attributes: stored() })]);
  await repo.updateItem("42", ITEM_ID, 3, { title: "x", eventId: "99", version: 50, createdBy: "evil" } as never, "s");
  const names = Object.values(sent[0]!.input.ExpressionAttributeNames as Record<string, string>);
  assert.equal(names.includes("eventId"), false);
  assert.equal(names.includes("createdBy"), false);
  assert.equal(sent[0]!.input.ExpressionAttributeValues[":version"], undefined);
});

// --- delete -----------------------------------------------------------------

test("deleteItem returns the deleted activity, or null when it was not in the event", async () => {
  const existing = stored();
  const { repo, sent } = repository([() => ({ Attributes: existing }), conditionFailed()]);
  assert.equal(await repo.deleteItem("42", ITEM_ID), existing);
  assert.equal(sent[0]!.input.ConditionExpression, "attribute_exists(sk)");
  assert.equal(sent[0]!.input.ReturnValues, "ALL_OLD");
  assert.equal(await repo.deleteItem("42", "missing"), null);
});

// --- mapper -----------------------------------------------------------------

test("toTimelineItem exposes nulls for empty fields and hides keys and audit fields", () => {
  const item = toTimelineItem(stored({ reminderSentAt: "2026-12-05T22:00:30Z" }));
  assert.deepEqual(item, {
    eventId: "42",
    itemId: ITEM_ID,
    title: "Ceremony begins",
    place: "Garden ceremony",
    notes: null,
    startsAt: "2026-12-05T23:00:00Z",
    endsAt: null,
    visibility: "GUESTS",
    reminderMinutes: 60,
    reminderAt: "2026-12-05T22:00:00Z",
    reminderSent: true,
    version: 3,
    createdAt: "2026-11-24T05:00:00Z",
    updatedAt: "2026-11-24T05:00:00Z",
  });
  for (const hidden of ["sk", "reminderStatus", "reminderSentAt", "createdBy", "updatedBy"]) {
    assert.equal(hidden in item, false, hidden);
  }
});

test("toGuestTimelineItem returns only guest-safe fields; TEAM items are not guest-visible", () => {
  assert.deepEqual(Object.keys(toGuestTimelineItem(stored())).sort(), ["endsAt", "itemId", "notes", "place", "startsAt", "title"]);
  assert.equal(isGuestVisible(stored()), true);
  assert.equal(isGuestVisible(stored({ visibility: "TEAM" })), false);
});

test("compareTimeline orders by start time, then title, then itemId", () => {
  const items = [
    { startsAt: "2026-12-05T23:00:00Z", title: "b", itemId: "2" },
    { startsAt: "2026-12-05T22:00:00Z", title: "z", itemId: "9" },
    { startsAt: "2026-12-05T23:00:00Z", title: "a", itemId: "3" },
    { startsAt: "2026-12-05T23:00:00Z", title: "a", itemId: "1" },
  ];
  assert.deepEqual(items.sort(compareTimeline).map((i) => i.itemId), ["9", "1", "3", "2"]);
});

test("utcSeconds drops milliseconds", () => {
  assert.equal(utcSeconds(new Date("2026-11-24T05:12:44.999Z")), "2026-11-24T05:12:44Z");
});
