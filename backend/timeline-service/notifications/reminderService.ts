// Sends due activity reminders (Feature 13, US42). Run every 5 minutes by EventBridge Scheduler.
// Rules: docs/api/timeline.md §7.
//
// Each due reminder is claimed before anything is sent, so a reminder is sent at most once:
// overlapping runs cannot both claim it, and a failed SQS send means a missed reminder,
// never a duplicate. Reminders for activities that already started are skipped, not sent late.

import { createEventSummaryLookup, type EventSummaryLookup } from "../repositories/eventSummary";
import type { TimelineRepository } from "../repositories/timelineRepository";
import type { TimelineRecord } from "../types";
import { reminderMessages, timelineLinks, type LinkSettings } from "./messages";
import type { PublishEmails } from "./publisher";
import type { RecipientResolver } from "./recipients";

/** Reminders handled per run; the next run picks up any remainder. */
export const MAX_REMINDERS_PER_RUN = 100;

export interface ReminderRunSummary {
  due: number;
  sent: number;
  skipped: number;
  alreadyClaimed: number;
  noRecipients: number;
  messagesQueued: number;
  messagesFailed: number;
  errors: number;
}

export interface ReminderServiceOptions {
  repository: Pick<TimelineRepository, "listDueReminders" | "claimReminder">;
  recipients: Pick<RecipientResolver, "resolve">;
  publish: PublishEmails;
  links: LinkSettings;
  events?: EventSummaryLookup;
  now?: () => Date;
  log?: (message: string) => void;
}

export class ReminderService {
  constructor(private readonly options: ReminderServiceOptions) {}

  async run(): Promise<ReminderRunSummary> {
    const { repository, recipients, publish } = this.options;
    const events = this.options.events ?? createEventSummaryLookup();
    const log = this.options.log ?? ((message: string) => console.log(message));
    const now = (this.options.now ?? (() => new Date()))();
    const summary: ReminderRunSummary = {
      due: 0, sent: 0, skipped: 0, alreadyClaimed: 0, noRecipients: 0, messagesQueued: 0, messagesFailed: 0, errors: 0,
    };

    const due = await repository.listDueReminders(now, MAX_REMINDERS_PER_RUN);
    summary.due = due.length;
    const eventNames = new Map<string, string>();

    for (const record of due) {
      try {
        if (Date.parse(record.startsAt) <= now.getTime()) {
          // Too late to say "starts soon": take it out of the queue without emailing.
          if (await repository.claimReminder(record, "SKIPPED", now)) summary.skipped++;
          else summary.alreadyClaimed++;
          continue;
        }
        // Check settings before claiming, so a misconfiguration doesn't silently use up reminders.
        const links = timelineLinks(record.eventId, this.options.links);
        const claimed = await repository.claimReminder(record, "SENT", now);
        if (!claimed) {
          summary.alreadyClaimed++;
          continue;
        }
        summary.sent++;
        const { recipients: list } = await recipients.resolve(claimed.eventId, new Set([claimed.visibility]));
        if (list.length === 0) {
          summary.noRecipients++;
          continue;
        }
        const eventName = await this.eventName(claimed, events, eventNames);
        const result = await publish(reminderMessages(list, claimed, { eventName, links }));
        summary.messagesQueued += result.queued;
        summary.messagesFailed += result.failed;
      } catch (error) {
        summary.errors++;
        // Event ID and error type only; never addresses or message bodies.
        const detail = error instanceof Error && error.name === "TimelineConfigurationError" ? error.message : error instanceof Error ? error.name : "unknown error";
        log(`Timeline reminder failed for event ${record.eventId}: ${detail}`);
      }
    }
    log(`Timeline reminders: ${JSON.stringify(summary)}`);
    return summary;
  }

  private async eventName(record: TimelineRecord, events: EventSummaryLookup, cache: Map<string, string>): Promise<string> {
    let name = cache.get(record.eventId);
    if (name === undefined) {
      name = (await events(record.eventId))?.name ?? "Your event";
      cache.set(record.eventId, name);
    }
    return name;
  }
}
