import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import type { AlertNotificationMessage, AlertPublisher } from "../types";

const MAX_SNS_SUBJECT_LENGTH = 100;

export function truncateSnsSubject(subject: string): string {
  const normalized = subject.replace(/[\r\n]+/g, " ").trim();
  if (normalized.length <= MAX_SNS_SUBJECT_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_SNS_SUBJECT_LENGTH - 3).trimEnd()}...`;
}

export function createSnsAlertPublisher(
  topicArn: string | undefined = process.env.ALERTS_SNS_TOPIC_ARN,
  client: Pick<SNSClient, "send"> = new SNSClient({}),
): AlertPublisher {
  return {
    async publish(message: AlertNotificationMessage): Promise<string | undefined> {
      const arn = topicArn?.trim();
      if (!arn) {
        throw new Error("ALERTS_SNS_TOPIC_ARN is required to publish alerts.");
      }

      const response = await client.send(
        new PublishCommand({
          TopicArn: arn,
          Subject: truncateSnsSubject(message.subject),
          Message: message.body,
          MessageAttributes: {
            ownerSub: { DataType: "String", StringValue: message.ownerSub },
            eventId: { DataType: "String", StringValue: message.eventId },
            alertTypes: { DataType: "String", StringValue: message.alertTypes.join(",") },
          },
        }),
      );
      return response.MessageId;
    },
  };
}
