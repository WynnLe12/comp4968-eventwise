import assert from "node:assert/strict";
import { test } from "node:test";
import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { createInvitationEmailPublisher, invitationEmailKey, openInvitationUrl, sealInvitationUrl } from "../event-service/services/invitationEmailPublisher";

const key = invitationEmailKey(Buffer.alloc(32, 7).toString("base64"));
const queueUrl = "https://sqs.us-west-2.amazonaws.com/123456789012/eventwise-invitation-emails";
const message = { to: "planner@example.com", eventName: "Example Wedding", invitationUrl: "https://organizer.example/accept-invitation#token=test-link" };

test("publisher sends the exact existing email consumer contract with SendMessage", async () => {
  const send = async (command: SendMessageCommand) => {
    assert.ok(command instanceof SendMessageCommand);
    assert.equal(command.input.QueueUrl, queueUrl);
    assert.deepEqual(JSON.parse(command.input.MessageBody!), message);
  };
  await createInvitationEmailPublisher({ send } as unknown as Pick<SQSClient, "send">)(queueUrl, message);
});

test("stored invitation links are authenticated ciphertext bound to their event and address", () => {
  const scope = "42:planner@example.com";
  const encrypted = sealInvitationUrl(message.invitationUrl, key, scope);
  assert.ok(!encrypted.includes(Buffer.from(message.invitationUrl)));
  assert.equal(openInvitationUrl(encrypted, key, scope), message.invitationUrl);
  assert.throws(() => openInvitationUrl(encrypted, key, "41:planner@example.com"));
  assert.throws(() => openInvitationUrl(encrypted, Buffer.alloc(32), scope));
  assert.throws(() => invitationEmailKey("invalid"));
});
