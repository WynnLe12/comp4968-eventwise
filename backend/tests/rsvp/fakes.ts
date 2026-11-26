// In-memory stand-ins for the RSVP repository, Event API, workflow and queue.
// The store applies the same conditions as the DynamoDB expressions in rsvpRepository.ts.

import { ApiError } from "../../expense-service/errors";
import type { RsvpEmailMessage } from "../../rsvp-service/notifications/messages";
import type { SaveResponseResult } from "../../rsvp-service/repositories/rsvpRepository";
import type { EventAccess } from "../../rsvp-service/services/eventAccess";
import type { Workflow, WorkflowInput } from "../../rsvp-service/services/workflow";
import type { EventSnapshot, GuestKey, GuestRecord, RsvpResponse, RsvpSettings } from "../../rsvp-service/types";

export const SECRET = "rsvp-link-secret-0123456789abcdef-xyz";
export const ORIGIN = "https://main.d220ourpslhwbp.amplifyapp.com";
export const LINKS = { origin: ORIGIN, secret: SECRET };
export const AUTH = "Bearer organizer-access-token";

const key = (k: GuestKey) => `${k.eventId}#${k.guestId}`;

export class MemoryRsvpStore {
  settings = new Map<string, RsvpSettings>();
  guests = new Map<string, GuestRecord>();

  addGuest(guest: GuestRecord): void {
    this.guests.set(key(guest), { ...guest });
  }

  guest(eventId: string, guestId: string): GuestRecord | undefined {
    return this.guests.get(key({ eventId, guestId }));
  }

  async getSettings(eventId: string) {
    const found = this.settings.get(eventId);
    return found ? { ...found } : null;
  }

  async putSettings(settings: RsvpSettings) {
    this.settings.set(settings.eventId, { ...settings });
  }

  async setExecutionArn(eventId: string, workflowId: string, executionArn: string) {
    const found = this.settings.get(eventId);
    if (found?.workflowId === workflowId) found.executionArn = executionArn;
  }

  async refreshSnapshot(eventId: string, snapshot: EventSnapshot) {
    const found = this.settings.get(eventId);
    if (found) Object.assign(found, snapshot);
  }

  async recordReminderRun(eventId: string, workflowId: string, at: string) {
    const found = this.settings.get(eventId);
    if (found?.workflowId === workflowId) found.reminderSentAt = at;
  }

  async close(eventId: string, workflowId: string, at: string) {
    const found = this.settings.get(eventId);
    if (found?.workflowId !== workflowId) return false;
    found.status = "CLOSED";
    found.closedAt = at;
    return true;
  }

  async listGuests(eventId: string) {
    return [...this.guests.values()].filter((guest) => guest.eventId === eventId).map((guest) => ({ ...guest }));
  }

  async getGuest(k: GuestKey) {
    const found = this.guests.get(key(k));
    return found ? { ...found } : null;
  }

  async markInvited(k: GuestKey, at: string) {
    const found = this.guests.get(key(k));
    if (!found || !(found.rsvpStatus === undefined || found.rsvpStatus === "UNINVITED" || found.rsvpStatus === "PENDING")) {
      return false;
    }
    Object.assign(found, { rsvpStatus: "PENDING", invitedAt: at, updatedAt: at });
    return true;
  }

  async claimReminder(k: GuestKey, at: string) {
    const found = this.guests.get(key(k));
    if (!found || found.rsvpStatus !== "PENDING" || found.reminderSentAt) return false;
    found.reminderSentAt = at;
    return true;
  }

  async releaseReminder(k: GuestKey, at: string) {
    const found = this.guests.get(key(k));
    if (found?.reminderSentAt === at) delete found.reminderSentAt;
  }

  async saveResponse(k: GuestKey, response: RsvpResponse, now: string): Promise<SaveResponseResult> {
    const settings = this.settings.get(k.eventId);
    if (!settings || settings.status !== "OPEN" || !(settings.deadline > now)) return "CLOSED";
    const found = this.guests.get(key(k));
    if (!found) return "GUEST_NOT_FOUND";
    Object.assign(found, {
      rsvpStatus: response.attending ? "ACCEPTED" : "REJECTED",
      plusOneAttending: response.plusOneAttending,
      rsvpRespondedAt: now,
    });
    for (const field of ["mealChoice", "dietaryNotes"] as const) {
      if (response[field] === null) delete found[field];
      else found[field] = response[field]!;
    }
    return "SAVED";
  }
}

/** Members are the tokens listed for each event; everyone else gets 403 like the Event API. */
export function fakeEventAccess(
  events: Record<string, EventSnapshot>,
  members: Record<string, string[]> = Object.fromEntries(Object.keys(events).map((id) => [id, [AUTH]])),
): EventAccess & { calls: string[] } {
  const calls: string[] = [];
  const access = async (eventId: string, authorization: string | undefined) => {
    calls.push(eventId);
    if (!authorization) throw new ApiError(401, "UNAUTHENTICATED", "Sign in to continue.");
    if (!members[eventId]?.includes(authorization) || !events[eventId]) {
      throw new ApiError(403, "FORBIDDEN", "You don't have access to this event.");
    }
    return { ...events[eventId]! };
  };
  return Object.assign(access, { calls });
}

export class FakeWorkflow implements Workflow {
  started: WorkflowInput[] = [];
  stopped: string[] = [];
  failStart = false;

  async start(input: WorkflowInput) {
    if (this.failStart) throw new Error("StepFunctionsUnavailable");
    this.started.push(input);
    return `arn:aws:states:us-west-2:123456789012:execution:eventwise-rsvp-deadline:run-${this.started.length}`;
  }

  async stop(executionArn: string) {
    this.stopped.push(executionArn);
  }
}

/** Records messages. `failFor` addresses are reported as not queued. */
export function fakePublisher(failFor: string[] = []) {
  const sent: RsvpEmailMessage[] = [];
  const publish = async (messages: RsvpEmailMessage[]) =>
    messages.map((message) => {
      if (failFor.includes(message.to)) return false;
      sent.push(message);
      return true;
    });
  return Object.assign(publish, { sent });
}

export function guest(overrides: Partial<GuestRecord> & Pick<GuestRecord, "guestId">): GuestRecord {
  return { eventId: "42", firstName: "Guest", plusOneAllowed: false, rsvpStatus: "UNINVITED", ...overrides };
}
