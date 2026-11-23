import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";

export interface InvitationEmailMessage {
  to: string;
  eventName: string;
  invitationUrl: string;
}

export type PublishInvitationEmail = (queueUrl: string, message: InvitationEmailMessage) => Promise<void>;

export function createInvitationEmailPublisher(
  client: Pick<SQSClient, "send"> = new SQSClient({ maxAttempts: 1 }),
): PublishInvitationEmail {
  return async (queueUrl, message) => {
    await client.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(message) }),
      { abortSignal: AbortSignal.timeout(4_000) });
  };
}

export function invitationEmailKey(configured: string | undefined): Buffer {
  const text = configured?.trim() ?? "";
  const key = Buffer.from(text, "base64");
  if (key.length !== 32 || key.toString("base64") !== text) {
    throw new Error("EVENTS_INVITATION_EMAIL_KEY must be a base64-encoded 32-byte key");
  }
  return key;
}

export function sealInvitationUrl(url: string, key: Buffer, scope: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv).setAAD(Buffer.from(scope));
  const encrypted = Buffer.concat([cipher.update(url, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
}

export function openInvitationUrl(envelope: Buffer, key: Buffer, scope: string): string {
  const decipher = createDecipheriv("aes-256-gcm", key, envelope.subarray(0, 12))
    .setAAD(Buffer.from(scope)).setAuthTag(envelope.subarray(12, 28));
  return Buffer.concat([decipher.update(envelope.subarray(28)), decipher.final()]).toString("utf8");
}
