import assert from "node:assert/strict";
import { test } from "node:test";
import { createDynamoDBClient, isLocalEndpoint } from "../../shared/db/dynamodb";
import { guestsTableDefinition } from "../../guest-service/tableDefinition";

test("isLocalEndpoint accepts only DynamoDB Local on this machine", () => {
  assert.equal(isLocalEndpoint("http://127.0.0.1:8000"), true);
  assert.equal(isLocalEndpoint("http://localhost:8000"), true);
  assert.equal(isLocalEndpoint("http://dynamodb-local:8000"), true);
  assert.equal(isLocalEndpoint(undefined), false);
  assert.equal(isLocalEndpoint(""), false);
  assert.equal(isLocalEndpoint("not a url"), false);
  assert.equal(isLocalEndpoint("https://dynamodb.us-west-2.amazonaws.com"), false);
});

test("a DynamoDB Local client uses dummy credentials, never the real ones", async () => {
  const client = createDynamoDBClient({ DYNAMODB_ENDPOINT: "http://127.0.0.1:8000", AWS_ACCESS_KEY_ID: "REAL" });
  const credentials = await (client.config.credentials as () => Promise<{ accessKeyId: string }>)();
  assert.equal(credentials.accessKeyId, "local");
  assert.equal(await client.config.region(), "us-west-2");
  client.destroy();
});

test("the local table definition matches the AWS table", () => {
  const definition = guestsTableDefinition("EventWise_Guests");
  assert.equal(definition.TableName, "EventWise_Guests");
  assert.deepEqual(definition.KeySchema, [
    { AttributeName: "eventId", KeyType: "HASH" },
    { AttributeName: "guestId", KeyType: "RANGE" },
  ]);
  assert.equal(definition.BillingMode, "PAY_PER_REQUEST");
});
