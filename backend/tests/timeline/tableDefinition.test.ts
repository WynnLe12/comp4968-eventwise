import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_TIMELINE_TABLE_NAME,
  ITEM_SORT_KEY_PREFIX,
  REMINDER_INDEX_NAME,
  SUBSCRIBER_SORT_KEY_PREFIX,
  itemSortKey,
  subscriberSortKey,
  timelineTableDefinition,
  timelineTableName,
} from "../../timeline-service/tableDefinition";

test("the timeline table uses eventId + sk keys and on-demand billing", () => {
  const definition = timelineTableDefinition("EventWise_Timeline");
  assert.equal(definition.TableName, "EventWise_Timeline");
  assert.deepEqual(definition.KeySchema, [
    { AttributeName: "eventId", KeyType: "HASH" },
    { AttributeName: "sk", KeyType: "RANGE" },
  ]);
  assert.equal(definition.BillingMode, "PAY_PER_REQUEST");
});

test("ReminderIndex is keyed by reminderStatus + reminderAt and projects all attributes", () => {
  const definition = timelineTableDefinition("EventWise_Timeline");
  assert.equal(definition.GlobalSecondaryIndexes?.length, 1);
  const [index] = definition.GlobalSecondaryIndexes ?? [];
  assert.equal(index.IndexName, REMINDER_INDEX_NAME);
  assert.deepEqual(index.KeySchema, [
    { AttributeName: "reminderStatus", KeyType: "HASH" },
    { AttributeName: "reminderAt", KeyType: "RANGE" },
  ]);
  assert.deepEqual(index.Projection, { ProjectionType: "ALL" });
});

test("every key attribute is declared as a string, and nothing else is declared", () => {
  const definition = timelineTableDefinition("EventWise_Timeline");
  assert.deepEqual(
    definition.AttributeDefinitions?.map((a) => `${a.AttributeName}:${a.AttributeType}`).sort(),
    ["eventId:S", "reminderAt:S", "reminderStatus:S", "sk:S"],
  );
});

test("sort keys separate activities from subscribers", () => {
  const item = itemSortKey("3b1f0c2e-8d4a-4f6b-9e21-7a5c2d9e0f13");
  const subscriber = subscriberSortKey("a1b2c3d4-0000-0000-0000-000000000000");
  assert.equal(item, "ITEM#3b1f0c2e-8d4a-4f6b-9e21-7a5c2d9e0f13");
  assert.equal(subscriber, "SUBSCRIBER#a1b2c3d4-0000-0000-0000-000000000000");
  assert.ok(item.startsWith(ITEM_SORT_KEY_PREFIX) && !item.startsWith(SUBSCRIBER_SORT_KEY_PREFIX));
  assert.ok(subscriber.startsWith(SUBSCRIBER_SORT_KEY_PREFIX) && !subscriber.startsWith(ITEM_SORT_KEY_PREFIX));
});

test("the table name comes from TIMELINE_TABLE_NAME, with a default", () => {
  assert.equal(timelineTableName({}), DEFAULT_TIMELINE_TABLE_NAME);
  assert.equal(timelineTableName({ TIMELINE_TABLE_NAME: "  " }), DEFAULT_TIMELINE_TABLE_NAME);
  assert.equal(timelineTableName({ TIMELINE_TABLE_NAME: "EventWise_Timeline_Test" }), "EventWise_Timeline_Test");
});
