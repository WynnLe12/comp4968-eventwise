// RSVP email sender Lambda (handler: rsvp-service/lambda/emailSender.handler). Feature 8.
// Triggered by the eventwise-rsvp-emails SQS queue; sends each invitation or reminder with SES.
//
// Enable "Report batch item failures" on the SQS trigger: failed messages are returned in
// batchItemFailures and retried; after the queue's maxReceiveCount they move to the DLQ.
// Logs contain SQS message IDs and error types only, never addresses, links or content.

import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { parseEmailMessage, renderEmail } from "../notifications/emailContent";

export interface SqsEvent {
  Records?: { messageId: string; body: string }[];
}

export interface BatchResponse {
  batchItemFailures: { itemIdentifier: string }[];
}

export type SendEmail = (input: { from: string; to: string; subject: string; text: string; html: string }) => Promise<void>;

export function createSesSender(client: Pick<SESv2Client, "send"> = new SESv2Client({ maxAttempts: 3 })): SendEmail {
  return async ({ from, to, subject, text, html }) => {
    await client.send(new SendEmailCommand({
      FromEmailAddress: from,
      Destination: { ToAddresses: [to] },
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: "UTF-8" },
          Body: { Text: { Data: text, Charset: "UTF-8" }, Html: { Data: html, Charset: "UTF-8" } },
        },
      },
    }), { abortSignal: AbortSignal.timeout(8_000) });
  };
}

export function createEmailSenderHandler(
  send: SendEmail = createSesSender(),
  env: NodeJS.ProcessEnv = process.env,
  log: (message: string) => void = (message) => console.error(message),
) {
  return async (event: SqsEvent): Promise<BatchResponse> => {
    const records = event.Records ?? [];
    const from = env.SES_FROM_ADDRESS?.trim();
    if (!from) {
      // Retry everything: nothing can be sent until the setting is fixed.
      log("SES_FROM_ADDRESS must be set for RSVP emails");
      return { batchItemFailures: records.map((record) => ({ itemIdentifier: record.messageId })) };
    }

    const failures: { itemIdentifier: string }[] = [];
    for (const record of records) {
      const message = parseEmailMessage(record.body);
      if (!message) {
        // Malformed messages never succeed; fail them so they land in the DLQ for inspection.
        log(`RSVP email ${record.messageId} rejected: message does not match the contract`);
        failures.push({ itemIdentifier: record.messageId });
        continue;
      }
      try {
        await send({ from, to: message.to, ...renderEmail(message) });
      } catch (error) {
        log(`RSVP email ${record.messageId} failed: ${error instanceof Error ? error.name : "unknown error"}`);
        failures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures: failures };
  };
}

export const handler = createEmailSenderHandler();
