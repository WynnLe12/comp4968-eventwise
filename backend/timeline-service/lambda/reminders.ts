// Timeline reminders Lambda (handler: timeline-service/lambda/reminders.handler). Feature 13, US42.
// Invoked every 5 minutes by EventBridge Scheduler; the event payload is ignored.
// Ships in the same eventwise-timeline.zip as the API Lambda, with a different handler.
// Runs in the RDS VPC (membership and event names come from MySQL) and reaches DynamoDB
// and SQS through the VPC endpoints, like eventwise-timeline.

import { createSqsPublisher } from "../notifications/publisher";
import { RecipientResolver } from "../notifications/recipients";
import { ReminderService, type ReminderRunSummary } from "../notifications/reminderService";
import { TimelineRepository } from "../repositories/timelineRepository";

export function createRemindersHandler(
  service: Pick<ReminderService, "run"> = (() => {
    const repository = new TimelineRepository();
    return new ReminderService({
      repository,
      recipients: new RecipientResolver({ subscribers: repository }),
      publish: createSqsPublisher(process.env.TIMELINE_EMAIL_QUEUE_URL),
      links: { origin: process.env.GUEST_APP_ORIGIN, secret: process.env.TIMELINE_SHARE_SECRET },
    });
  })(),
) {
  // Failures of single reminders are counted in the summary. Only a failure to list due
  // reminders (e.g. DynamoDB unreachable) throws, so the invocation shows as failed in CloudWatch.
  return async (): Promise<ReminderRunSummary> => service.run();
}

export const handler = createRemindersHandler();
