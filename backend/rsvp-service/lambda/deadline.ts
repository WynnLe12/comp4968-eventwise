// RSVP deadline Lambda (handler: rsvp-service/lambda/deadline.handler). Feature 8.
// Invoked only by the eventwise-rsvp-deadline Step Functions state machine, with
// { action: "REMIND" | "CLOSE", eventId, workflowId }. Runs OUTSIDE the VPC.
//
// Errors are thrown on purpose: Step Functions retries the step (see the Retry block in
// infrastructure/stepfunctions/rsvp-deadline.asl.json).

import { createSqsPublisher } from "../notifications/publisher";
import { RsvpRepository } from "../repositories/rsvpRepository";
import { DeadlineService, type DeadlineResult } from "../services/deadlineService";

export function createDeadlineHandler(
  service: Pick<DeadlineService, "run"> = new DeadlineService({
    repository: new RsvpRepository(),
    publish: createSqsPublisher(process.env.RSVP_EMAIL_QUEUE_URL),
    links: { origin: process.env.GUEST_APP_ORIGIN, secret: process.env.RSVP_LINK_SECRET },
  }),
) {
  return async (event: unknown): Promise<DeadlineResult> => service.run(event);
}

export const handler = createDeadlineHandler();
