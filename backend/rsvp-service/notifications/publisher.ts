// Puts RSVP email messages on the eventwise-rsvp-emails SQS queue (Feature 8).
// SQS accepts at most 10 messages per SendMessageBatch call. Reports which messages were
// queued, so callers only mark those guests as invited or reminded.

import { SQSClient, SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import { RsvpConfigurationError } from "../rsvpLink";
import type { RsvpEmailMessage } from "./messages";

export const SQS_BATCH_LIMIT = 10;

/** For each message, in order: true if it was queued. */
export type PublishEmails = (messages: RsvpEmailMessage[]) => Promise<boolean[]>;

export function createSqsPublisher(
  queueUrl: string | undefined,
  client: Pick<SQSClient, "send"> = new SQSClient({ maxAttempts: 2 }),
): PublishEmails {
  return async (messages) => {
    if (!queueUrl?.trim()) throw new RsvpConfigurationError("RSVP_EMAIL_QUEUE_URL must be set for RSVP emails");
    const queued: boolean[] = [];
    for (let start = 0; start < messages.length; start += SQS_BATCH_LIMIT) {
      const batch = messages.slice(start, start + SQS_BATCH_LIMIT);
      try {
        const result = await client.send(
          new SendMessageBatchCommand({
            QueueUrl: queueUrl,
            Entries: batch.map((message, index) => ({ Id: String(index), MessageBody: JSON.stringify(message) })),
          }),
          { abortSignal: AbortSignal.timeout(4_000) },
        );
        const failed = new Set((result.Failed ?? []).map((entry) => entry.Id));
        batch.forEach((_, index) => queued.push(!failed.has(String(index))));
      } catch {
        // The whole batch's outcome is unknown; treat it as not queued. Bodies are never logged.
        batch.forEach(() => queued.push(false));
      }
    }
    return queued;
  };
}
