// The two steps of the RSVP deadline workflow (Feature 8), run by the deadline Lambda when
// Step Functions reaches them:
//
//   REMIND  email guests who were invited but haven't answered, once each
//   CLOSE   close RSVPs (the API also refuses responses after the deadline on its own)
//
// A run whose workflowId is no longer the event's current one (invitations were re-sent
// with new settings) does nothing.

import { rsvpEmail } from "../notifications/messages";
import type { PublishEmails } from "../notifications/publisher";
import type { RsvpRepository } from "../repositories/rsvpRepository";
import type { LinkSettings } from "../rsvpLink";
import type { GuestRecord } from "../types";
import { guestStatus, isClosed } from "./rsvpService";
import { deliverableEmail, toUtcSeconds } from "./validation";

export interface DeadlineTask {
  action: "REMIND" | "CLOSE";
  eventId: string;
  workflowId: string;
}

export type DeadlineResult =
  | { status: "STALE" }
  | { status: "SKIPPED_CLOSED" }
  | { status: "REMINDED"; reminded: number; skippedNoEmail: number }
  | { status: "CLOSED" };

/** Thrown so Step Functions retries the step. Claims of failed emails were released first. */
export class RemindersIncompleteError extends Error {
  constructor(failed: number) {
    super(`${failed} reminder email(s) could not be queued`);
    this.name = "RemindersIncompleteError";
  }
}

export type DeadlineStore = Pick<
  RsvpRepository,
  "getSettings" | "listGuests" | "claimReminder" | "releaseReminder" | "recordReminderRun" | "close"
>;

export interface DeadlineServiceOptions {
  repository: DeadlineStore;
  publish: PublishEmails;
  links: LinkSettings;
  now?: () => Date;
  log?: (message: string) => void;
}

export function parseDeadlineTask(value: unknown): DeadlineTask {
  const task = value as Partial<DeadlineTask> | null;
  if (
    !task || (task.action !== "REMIND" && task.action !== "CLOSE") ||
    typeof task.eventId !== "string" || !/^[1-9][0-9]{0,19}$/.test(task.eventId) ||
    typeof task.workflowId !== "string" || !task.workflowId || task.workflowId.length > 64
  ) {
    throw new Error("Invalid deadline task input");
  }
  return { action: task.action, eventId: task.eventId, workflowId: task.workflowId };
}

export class DeadlineService {
  private readonly repository: DeadlineStore;
  private readonly publish: PublishEmails;
  private readonly links: LinkSettings;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;

  constructor(options: DeadlineServiceOptions) {
    this.repository = options.repository;
    this.publish = options.publish;
    this.links = options.links;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? ((message) => console.log(message));
  }

  async run(input: unknown): Promise<DeadlineResult> {
    const task = parseDeadlineTask(input);
    const settings = await this.repository.getSettings(task.eventId);
    if (!settings || settings.workflowId !== task.workflowId) {
      this.log(`RSVP ${task.action.toLowerCase()} for event ${task.eventId}: stale run, nothing to do`);
      return { status: "STALE" };
    }

    const now = this.now();
    const nowIso = toUtcSeconds(now);

    if (task.action === "CLOSE") {
      const closed = await this.repository.close(task.eventId, task.workflowId, nowIso);
      this.log(`RSVP close for event ${task.eventId}: ${closed ? "closed" : "stale run"}`);
      return closed ? { status: "CLOSED" } : { status: "STALE" };
    }

    if (isClosed(settings, now)) return { status: "SKIPPED_CLOSED" };

    const waiting = (await this.repository.listGuests(task.eventId)).filter(
      (guest) => guestStatus(guest.rsvpStatus) === "PENDING" && !guest.reminderSentAt,
    );
    const claimed: { guest: GuestRecord; to: string }[] = [];
    let skippedNoEmail = 0;
    for (const guest of waiting) {
      const to = deliverableEmail(guest.email);
      if (!to) {
        skippedNoEmail++;
        continue;
      }
      // The claim is what makes the reminder "once": only one run can claim each guest.
      if (await this.repository.claimReminder({ eventId: guest.eventId, guestId: guest.guestId }, nowIso)) {
        claimed.push({ guest, to });
      }
    }

    const messages = claimed.map(({ guest, to }) => rsvpEmail("RSVP_REMINDER", guest, to, settings, this.links));
    const queued = messages.length ? await this.publish(messages) : [];
    let failed = 0;
    for (const [index, { guest }] of claimed.entries()) {
      if (queued[index]) continue;
      failed++;
      await this.repository.releaseReminder({ eventId: guest.eventId, guestId: guest.guestId }, nowIso);
    }
    await this.repository.recordReminderRun(task.eventId, task.workflowId, nowIso);

    // Counts only: never addresses.
    this.log(`RSVP reminders for event ${task.eventId}: ${claimed.length - failed} queued, ${failed} failed, ${skippedNoEmail} without email`);
    if (failed > 0) throw new RemindersIncompleteError(failed);
    return { status: "REMINDED", reminded: claimed.length, skippedNoEmail };
  }
}
