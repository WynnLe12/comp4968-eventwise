// The real TimelineNotifier (Feature 13, US43): works out who is affected by a change,
// builds one email message each and puts them on SQS for the email sender Lambda.
// Replaces the notificationsNotConfigured placeholder from timelineService.ts.

import { TimelineRepository } from "../repositories/timelineRepository";
import { createEventSummaryLookup, type EventSummaryLookup } from "../repositories/eventSummary";
import type { NotificationResult, TimelineChange, TimelineNotifier } from "../services/timelineService";
import type { Visibility } from "../types";
import { changeMessages, timelineLinks, type LinkSettings } from "./messages";
import { createSqsPublisher, type PublishEmails } from "./publisher";
import { RecipientResolver } from "./recipients";

export interface SqsTimelineNotifierOptions {
  recipients: Pick<RecipientResolver, "resolve">;
  publish: PublishEmails;
  events?: EventSummaryLookup;
  links: LinkSettings;
  log?: (message: string) => void;
}

export class SqsTimelineNotifier implements TimelineNotifier {
  private readonly recipients: Pick<RecipientResolver, "resolve">;
  private readonly publish: PublishEmails;
  private readonly events: EventSummaryLookup;
  private readonly links: LinkSettings;
  private readonly log: (message: string) => void;

  constructor(options: SqsTimelineNotifierOptions) {
    this.recipients = options.recipients;
    this.publish = options.publish;
    this.events = options.events ?? createEventSummaryLookup();
    this.links = options.links;
    this.log = options.log ?? ((message) => console.log(message));
  }

  async timelineChanged(change: TimelineChange): Promise<NotificationResult> {
    // Settings are checked first, so a misconfigured deployment fails before any lookups.
    const links = timelineLinks(change.eventId, this.links);

    // Everyone who could see the activity before or after the change is affected.
    const visibilities = new Set<Visibility>([change.before.visibility]);
    if (change.after) visibilities.add(change.after.visibility);

    const { recipients, truncated } = await this.recipients.resolve(change.eventId, visibilities);
    if (truncated) this.log(`Timeline change for event ${change.eventId}: recipient list truncated`);
    if (recipients.length === 0) return { status: "NO_RECIPIENTS", recipients: 0 };

    const event = await this.events(change.eventId);
    const messages = changeMessages(recipients, change, { eventName: event?.name ?? "Your event", links });
    const { queued, failed } = await this.publish(messages);
    // Counts only: never addresses or message bodies.
    this.log(`Timeline ${change.type.toLowerCase()} for event ${change.eventId}: ${queued} queued, ${failed} failed`);
    return failed > 0 ? { status: "FAILED", recipients: queued } : { status: "QUEUED", recipients: queued };
  }
}

/** The notifier the Lambda uses, configured from its environment variables. */
export function createSqsTimelineNotifier(env: NodeJS.ProcessEnv = process.env): SqsTimelineNotifier {
  return new SqsTimelineNotifier({
    recipients: new RecipientResolver({ subscribers: new TimelineRepository() }),
    publish: createSqsPublisher(env.TIMELINE_EMAIL_QUEUE_URL),
    links: { origin: env.GUEST_APP_ORIGIN, secret: env.TIMELINE_SHARE_SECRET },
  });
}
