// Puts timeline email messages on the eventwise-timeline-emails SQS queue (Feature 13).
// The timeline Lambda reaches SQS through the VPC interface endpoint (eventwise-sqs-endpoint).
// SQS accepts at most 10 messages per SendMessageBatch call.

import { SQSClient, SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import { TimelineConfigurationError } from "../errors";
import type { TimelineEmailMessage } from "./messages";

export const SQS_BATCH_LIMIT = 10;

export interface PublishResult {
  queued: number;
  failed: number;
}

export type PublishEmails = (messages: TimelineEmailMessage[]) => Promise<PublishResult>;

export function createSqsPublisher(
  queueUrl: string | undefined,
  client: Pick<SQSClient, "send"> = new SQSClient({ maxAttempts: 2 }),
): PublishEmails {
  return async (messages) => {
    if (!queueUrl?.trim()) throw new TimelineConfigurationError("TIMELINE_EMAIL_QUEUE_URL must be set for timeline emails");
    let queued = 0;
    let failed = 0;
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
        const failures = result.Failed?.length ?? 0;
        failed += failures;
        queued += batch.length - failures;
      } catch {
        // The whole batch is unknown; count it as failed. Message bodies are never logged.
        failed += batch.length;
      }
    }
    return { queued, failed };
  };
}
