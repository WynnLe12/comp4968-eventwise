// Invitations and RSVP (Feature 8). Contract: docs/api/rsvp.md.
//
// Organizers (signed in, members of the event):
//   getSettings      the event's RSVP settings, or null before invitations are first sent
//   sendInvitations  save deadline/start time/reminder/message, (re)start the deadline
//                    workflow, and email every invitable guest a private RSVP link
//   guestLink        one guest's private RSVP link, to share another way
// Guests (no account; the signed link is the credential):
//   getForGuest      event details + the guest's own current answer
//   respond          accept or decline, meal choice, allergies, plus-one
//
// Any invalid or tampered link, deleted guest, or event without RSVP settings is the same
// 404, so links can't be probed.

import { randomUUID } from "node:crypto";
import { ApiError } from "../../expense-service/errors";
import { rsvpEmail } from "../notifications/messages";
import type { PublishEmails } from "../notifications/publisher";
import type { RsvpRepository } from "../repositories/rsvpRepository";
import { readRsvpToken, rsvpUrl, type LinkSettings } from "../rsvpLink";
import {
  RSVP_STATUSES,
  type EventSnapshot,
  type GuestRecord,
  type GuestRsvpView,
  type RsvpSettings,
  type RsvpSettingsView,
  type RsvpStatus,
  type SendInvitationsResult,
} from "../types";
import type { EventAccess } from "./eventAccess";
import {
  deliverableEmail,
  parseRsvpResponse,
  parseSendInvitations,
  requireEventId,
  requireGuestId,
  toUtcSeconds,
} from "./validation";
import type { Workflow } from "./workflow";

export type RsvpStore = Pick<
  RsvpRepository,
  | "getSettings"
  | "putSettings"
  | "setExecutionArn"
  | "refreshSnapshot"
  | "listGuests"
  | "getGuest"
  | "markInvited"
  | "saveResponse"
>;

export interface RsvpServiceOptions {
  repository: RsvpStore;
  eventAccess: EventAccess;
  workflow: Workflow;
  publish: PublishEmails;
  links: LinkSettings;
  now?: () => Date;
  newId?: () => string;
}

const linkNotFound = () => new ApiError(404, "NOT_FOUND", "This RSVP link isn't valid.");
const rsvpClosed = () => new ApiError(409, "RSVP_CLOSED", "RSVPs for this event have closed.");

export function isClosed(settings: Pick<RsvpSettings, "status" | "deadline">, now: Date): boolean {
  return settings.status === "CLOSED" || Date.parse(settings.deadline) <= now.getTime();
}

export function toSettingsView(settings: RsvpSettings, now: Date): RsvpSettingsView {
  return {
    eventName: settings.eventName,
    eventDate: settings.eventDate,
    venue: settings.venue,
    startTime: settings.startTime,
    deadline: settings.deadline,
    reminderAt: settings.reminderAt,
    message: settings.message,
    status: isClosed(settings, now) ? "CLOSED" : "OPEN",
    invitationsSentAt: settings.invitationsSentAt,
    reminderSentAt: settings.reminderSentAt,
    closedAt: settings.closedAt,
  };
}

export function guestStatus(value: unknown): RsvpStatus {
  return (RSVP_STATUSES as readonly unknown[]).includes(value) ? (value as RsvpStatus) : "UNINVITED";
}

function toGuestView(settings: RsvpSettings, guest: GuestRecord, now: Date): GuestRsvpView {
  return {
    event: { eventName: settings.eventName, eventDate: settings.eventDate, venue: settings.venue, startTime: settings.startTime },
    message: settings.message,
    deadline: settings.deadline,
    closed: isClosed(settings, now),
    guest: {
      firstName: guest.firstName?.trim() || null,
      lastName: guest.lastName?.trim() || null,
      plusOneAllowed: guest.plusOneAllowed === true,
      rsvpStatus: guestStatus(guest.rsvpStatus),
      mealChoice: guest.mealChoice?.trim() || null,
      plusOneAttending: typeof guest.plusOneAttending === "boolean" ? guest.plusOneAttending : null,
      respondedAt: guest.rsvpRespondedAt ?? null,
    },
  };
}

function sameSnapshot(a: EventSnapshot, b: EventSnapshot): boolean {
  return a.eventName === b.eventName && a.eventDate === b.eventDate && a.venue === b.venue;
}

export class RsvpService {
  private readonly repository: RsvpStore;
  private readonly eventAccess: EventAccess;
  private readonly workflow: Workflow;
  private readonly publish: PublishEmails;
  private readonly links: LinkSettings;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(options: RsvpServiceOptions) {
    this.repository = options.repository;
    this.eventAccess = options.eventAccess;
    this.workflow = options.workflow;
    this.publish = options.publish;
    this.links = options.links;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
  }

  // --- Organizers ------------------------------------------------------------------------

  async getSettings(rawEventId: unknown, authorization: string | undefined): Promise<{ settings: RsvpSettingsView | null }> {
    const eventId = requireEventId(rawEventId);
    const snapshot = await this.eventAccess(eventId, authorization);
    const settings = await this.repository.getSettings(eventId);
    if (!settings) return { settings: null };
    // The event may have been renamed or moved since invitations went out; guests see the update.
    if (!sameSnapshot(settings, snapshot)) {
      await this.repository.refreshSnapshot(eventId, snapshot);
      Object.assign(settings, snapshot);
    }
    return { settings: toSettingsView(settings, this.now()) };
  }

  async sendInvitations(
    rawEventId: unknown,
    sub: string,
    authorization: string | undefined,
    body: unknown,
  ): Promise<SendInvitationsResult> {
    const eventId = requireEventId(rawEventId);
    const snapshot = await this.eventAccess(eventId, authorization);
    const now = this.now();
    const input = parseSendInvitations(body, snapshot.eventDate, now);
    // Fail on missing link settings before anything is saved or scheduled.
    rsvpUrl({ eventId, guestId: "check" }, this.links);

    const previous = await this.repository.getSettings(eventId);
    const nowIso = toUtcSeconds(now);
    const settings: RsvpSettings = {
      eventId,
      ...snapshot,
      startTime: input.startTime,
      deadline: input.deadline,
      reminderAt: input.reminderAt,
      message: input.message,
      status: "OPEN",
      workflowId: this.newId(),
      executionArn: null,
      invitationsSentAt: nowIso,
      reminderSentAt: previous?.reminderSentAt ?? null,
      closedAt: null,
      updatedAt: nowIso,
      updatedBy: sub,
    };
    await this.repository.putSettings(settings);

    // Schedule the reminder and deadline before any email goes out.
    try {
      settings.executionArn = await this.workflow.start({
        eventId, workflowId: settings.workflowId, reminderAt: settings.reminderAt, deadline: settings.deadline,
      });
    } catch (error) {
      if (error instanceof ApiError || (error instanceof Error && error.name === "RsvpConfigurationError")) throw error;
      // The AWS error type (e.g. AccessDeniedException, StateMachineDoesNotExist) says what to fix.
      console.error(`Starting the RSVP workflow for event ${eventId} failed: ${error instanceof Error ? error.name : "unknown error"}`);
      throw new ApiError(502, "SCHEDULING_FAILED",
        "We couldn't schedule the RSVP reminder and deadline, so no invitations were sent. Please try again.");
    }
    await this.repository.setExecutionArn(eventId, settings.workflowId, settings.executionArn);
    if (previous?.executionArn) await this.workflow.stop(previous.executionArn);

    // Invite everyone not yet invited (and, if asked, re-send to those who haven't answered).
    const guests = await this.repository.listGuests(eventId);
    const invitable = guests.filter((guest) => {
      const status = guestStatus(guest.rsvpStatus);
      return status === "UNINVITED" || (input.includePending && status === "PENDING");
    });
    const recipients = invitable.flatMap((guest) => {
      const to = deliverableEmail(guest.email);
      return to ? [{ guest, to }] : [];
    });
    const messages = recipients.map(({ guest, to }) => rsvpEmail("RSVP_INVITATION", guest, to, settings, this.links));
    const queued = messages.length ? await this.publish(messages) : [];

    let sent = 0;
    for (const [index, { guest }] of recipients.entries()) {
      if (!queued[index]) continue;
      sent++;
      await this.repository.markInvited({ eventId, guestId: guest.guestId }, nowIso);
    }
    // Counts only: never addresses.
    console.log(`RSVP invitations for event ${eventId}: ${sent} queued, ${recipients.length - sent} failed`);

    return {
      settings: toSettingsView(settings, now),
      queued: sent,
      failed: recipients.length - sent,
      skippedNoEmail: invitable.length - recipients.length,
    };
  }

  async guestLink(rawEventId: unknown, rawGuestId: unknown, authorization: string | undefined): Promise<{ url: string }> {
    const eventId = requireEventId(rawEventId);
    await this.eventAccess(eventId, authorization);
    const guestId = requireGuestId(rawGuestId);
    const guest = await this.repository.getGuest({ eventId, guestId });
    if (!guest) throw new ApiError(404, "NOT_FOUND", "This guest isn't on the guest list.");
    return { url: rsvpUrl({ eventId, guestId }, this.links) };
  }

  // --- Guests ------------------------------------------------------------------------------

  private async load(token: unknown): Promise<{ settings: RsvpSettings; guest: GuestRecord }> {
    const key = readRsvpToken(token, this.links.secret);
    if (!key) throw linkNotFound();
    const [settings, guest] = await Promise.all([this.repository.getSettings(key.eventId), this.repository.getGuest(key)]);
    if (!settings || !guest) throw linkNotFound();
    return { settings, guest };
  }

  async getForGuest(token: unknown): Promise<GuestRsvpView> {
    const { settings, guest } = await this.load(token);
    return toGuestView(settings, guest, this.now());
  }

  async respond(token: unknown, body: unknown): Promise<GuestRsvpView> {
    const { settings, guest } = await this.load(token);
    const now = this.now();
    if (isClosed(settings, now)) throw rsvpClosed();
    const response = parseRsvpResponse(body, guest.plusOneAllowed === true);
    const key = { eventId: guest.eventId, guestId: guest.guestId };
    const result = await this.repository.saveResponse(key, response, toUtcSeconds(now));
    if (result === "CLOSED") throw rsvpClosed();
    if (result === "GUEST_NOT_FOUND") throw linkNotFound();
    const saved = await this.repository.getGuest(key);
    if (!saved) throw linkNotFound();
    console.log(`RSVP saved for event ${key.eventId}: ${response.attending ? "accepted" : "declined"}`);
    return toGuestView(settings, saved, now);
  }
}
