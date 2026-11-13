// Unit tests for GuestRepository with a fake DynamoDB client (no AWS or Docker needed).
// The fake records each command and returns queued responses.

import assert from "node:assert/strict";
import { test } from "node:test";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { GuestRepository } from "../../guest-service/repositories/guestRepository";

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

function repository(responders: Responder[]) {
  const fake = fakeClient(responders);
  const repo = new GuestRepository({
    client: fake.client,
    tableName: "TestGuests",
    now: () => new Date("2026-11-12T10:00:00.000Z"),
    newId: () => "guest-1",
  });
  return { repo, sent: fake.sent };
}

const conditionFailed = () => {
  throw new ConditionalCheckFailedException({ message: "The conditional request failed", $metadata: {} });
};

test("create stores a PENDING guest, omits empty fields and never overwrites", async () => {
  const { repo, sent } = repository([() => ({})]);
  const guest = await repo.create("42", { firstName: "Sofia", lastName: "", group: "Friends" }, "sub-1");

  assert.equal(sent[0]!.constructor.name, "PutCommand");
  assert.equal(sent[0]!.input.TableName, "TestGuests");
  assert.equal(sent[0]!.input.ConditionExpression, "attribute_not_exists(guestId)");
  assert.deepEqual(guest, {
    eventId: "42",
    guestId: "guest-1",
    firstName: "Sofia",
    group: "Friends",
    plusOneAllowed: false,
    rsvpStatus: "PENDING",
    createdBy: "sub-1",
    createdAt: "2026-11-12T10:00:00.000Z",
    updatedAt: "2026-11-12T10:00:00.000Z",
  });
});

test("listByEvent queries only the given event, follows pages and sorts by createdAt", async () => {
  const { repo, sent } = repository([
    () => ({ Items: [{ guestId: "b", createdAt: "2026-11-12T10:00:02Z" }], LastEvaluatedKey: { eventId: "42", guestId: "b" } }),
    () => ({ Items: [{ guestId: "a", createdAt: "2026-11-12T10:00:01Z" }] }),
  ]);
  const guests = await repo.listByEvent("42");

  assert.equal(sent.length, 2);
  assert.equal(sent[0]!.input.KeyConditionExpression, "eventId = :eventId");
  assert.deepEqual(sent[0]!.input.ExpressionAttributeValues, { ":eventId": "42" });
  assert.deepEqual(sent[1]!.input.ExclusiveStartKey, { eventId: "42", guestId: "b" });
  assert.deepEqual(guests.map((g) => g.guestId), ["a", "b"]);
});

test("get returns null when the guest is not in the event", async () => {
  const { repo, sent } = repository([() => ({})]);
  assert.equal(await repo.get("42", "missing"), null);
  assert.deepEqual(sent[0]!.input.Key, { eventId: "42", guestId: "missing" });
});

test("update sets changed fields, removes cleared ones and only touches existing guests", async () => {
  const { repo, sent } = repository([() => ({ Attributes: { guestId: "guest-1" } })]);
  await repo.update("42", "guest-1", { mealChoice: "Vegetarian", dietaryNotes: null, plusOneAllowed: true });

  const input = sent[0]!.input;
  assert.equal(input.ConditionExpression, "attribute_exists(guestId)");
  assert.equal(
    input.UpdateExpression,
    "SET #updatedAt = :updatedAt, #plusOneAllowed = :plusOneAllowed, #mealChoice = :mealChoice REMOVE #dietaryNotes",
  );
  assert.equal(input.ExpressionAttributeValues[":mealChoice"], "Vegetarian");
  assert.equal(input.ExpressionAttributeValues[":plusOneAllowed"], true);
});

test("update ignores keys and system fields sent by the client", async () => {
  const { repo, sent } = repository([() => ({ Attributes: {} })]);
  await repo.update("42", "guest-1", { firstName: "Ana", eventId: "99", rsvpStatus: "ATTENDING" } as never);

  const names = Object.values(sent[0]!.input.ExpressionAttributeNames);
  assert.deepEqual(names.sort(), ["firstName", "updatedAt"]);
});

test("update refuses to clear a required field", async () => {
  const { repo } = repository([]);
  await assert.rejects(repo.update("42", "guest-1", { firstName: null as never }), /firstName cannot be cleared/);
});

test("update returns null when the guest does not exist", async () => {
  const { repo } = repository([conditionFailed]);
  assert.equal(await repo.update("42", "missing", { firstName: "Ana" }), null);
});

test("delete returns true when deleted and false when missing", async () => {
  const { repo } = repository([() => ({}), conditionFailed]);
  assert.equal(await repo.delete("42", "guest-1"), true);
  assert.equal(await repo.delete("42", "missing"), false);
});

test("deleteAllForEvent deletes in batches of 25 and retries unprocessed items", async () => {
  const items = Array.from({ length: 30 }, (_, i) => ({ eventId: "42", guestId: `g${i}` }));
  const leftover = [{ DeleteRequest: { Key: { eventId: "42", guestId: "g0" } } }];
  const { repo, sent } = repository([
    () => ({ Items: items }),
    () => ({ UnprocessedItems: { TestGuests: leftover } }),
    () => ({}),
    () => ({}),
  ]);
  assert.equal(await repo.deleteAllForEvent("42"), 30);

  const batches = sent.filter((c) => c.constructor.name === "BatchWriteCommand");
  assert.deepEqual(batches.map((c) => c.input.RequestItems.TestGuests.length), [25, 1, 5]);
});
