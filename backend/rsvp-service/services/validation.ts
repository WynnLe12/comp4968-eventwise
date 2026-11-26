// Input validation for Feature 8. Errors use the shared ApiError format:
// 422 VALIDATION_ERROR with { fields: { <json field>: <message> } }.

import { ApiError } from "../../expense-service/errors";
import type { RsvpResponse, SendInvitationsInput } from "../types";

export const EVENT_TIME_ZONE = "America/Vancouver";
export const MESSAGE_MAX = 1000;
export const MEAL_CHOICE_MAX = 50;
export const DIETARY_NOTES_MAX = 500;
export const REMINDER_DAYS_MAX = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DEADLINE_MS = 400 * DAY_MS;

const EVENT_ID = /^[1-9][0-9]{0,19}$/;
const GUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

function fieldError(fields: Record<string, string>): never {
  throw new ApiError(422, "VALIDATION_ERROR", "Check the highlighted fields.", fields);
}

export function requireEventId(value: unknown): string {
  // Same 403 as a non-member, so the API never reveals which IDs exist.
  if (typeof value !== "string" || !EVENT_ID.test(value)) {
    throw new ApiError(403, "FORBIDDEN", "You don't have access to this event.");
  }
  return value;
}

export function requireGuestId(value: unknown): string {
  if (typeof value !== "string" || !GUEST_ID.test(value)) {
    throw new ApiError(404, "NOT_FOUND", "This guest isn't on the guest list.");
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Optional trimmed text: missing, null or blank → null. */
function optionalText(body: Record<string, unknown>, field: string, max: number): string | null {
  const value = body[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") fieldError({ [field]: "Enter text." });
  const trimmed = value.trim();
  if ([...trimmed].length > max) fieldError({ [field]: `Use at most ${max} characters.` });
  return trimmed || null;
}

/** The calendar date ("YYYY-MM-DD") of an instant in the event's time zone. */
export function localDate(instant: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: EVENT_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(instant);
}

/** Normalizes an instant to "YYYY-MM-DDTHH:MM:SSZ" (whole seconds, UTC), as Step Functions Wait expects. */
export function toUtcSeconds(instant: Date): string {
  return instant.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Validates the organizer's "save and send invitations" body.
 * `eventDate` ("YYYY-MM-DD" or null) comes from the Event API: the deadline can't be after it.
 */
export function parseSendInvitations(body: unknown, eventDate: string | null, now: Date): SendInvitationsInput {
  if (!isObject(body)) throw new ApiError(400, "BAD_REQUEST", "Send the RSVP settings as a JSON object.");

  const rawDeadline = body.deadline;
  if (typeof rawDeadline !== "string" || !INSTANT.test(rawDeadline) || Number.isNaN(Date.parse(rawDeadline))) {
    fieldError({ deadline: "Choose an RSVP deadline." });
  }
  const deadline = new Date(rawDeadline);
  if (deadline.getTime() <= now.getTime()) fieldError({ deadline: "The RSVP deadline must be in the future." });
  if (deadline.getTime() - now.getTime() > MAX_DEADLINE_MS) {
    fieldError({ deadline: "The RSVP deadline must be within the next year." });
  }
  if (eventDate && localDate(deadline) > eventDate) {
    fieldError({ deadline: "The RSVP deadline can't be after the event date." });
  }

  let startTime: string | null = null;
  if (body.startTime !== undefined && body.startTime !== null && body.startTime !== "") {
    if (typeof body.startTime !== "string" || !CLOCK.test(body.startTime)) {
      fieldError({ startTime: "Enter a start time like 16:00." });
    }
    startTime = body.startTime;
  }

  const days = body.reminderDaysBefore ?? 0;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 0 || days > REMINDER_DAYS_MAX) {
    fieldError({ reminderDaysBefore: `Choose between 0 and ${REMINDER_DAYS_MAX} days.` });
  }
  let reminderAt: string | null = null;
  if (days > 0) {
    const at = new Date(deadline.getTime() - days * DAY_MS);
    if (at.getTime() <= now.getTime()) {
      fieldError({ reminderDaysBefore: "That reminder time has already passed. Choose fewer days, or no reminder." });
    }
    reminderAt = toUtcSeconds(at);
  }

  if (body.includePending !== undefined && typeof body.includePending !== "boolean") {
    fieldError({ includePending: "Choose yes or no." });
  }

  return {
    deadline: toUtcSeconds(deadline),
    startTime,
    reminderAt,
    message: optionalText(body, "message", MESSAGE_MAX),
    includePending: body.includePending === true,
  };
}

/** Validates a guest's RSVP form. `plusOneAllowed` comes from the guest record, never the body. */
export function parseRsvpResponse(body: unknown, plusOneAllowed: boolean): RsvpResponse {
  if (!isObject(body)) throw new ApiError(400, "BAD_REQUEST", "Send your response as a JSON object.");
  if (typeof body.attending !== "boolean") fieldError({ attending: "Let the hosts know whether you're coming." });
  const attending = body.attending;

  const plusOne = body.plusOneAttending;
  if (plusOne !== undefined && plusOne !== null && typeof plusOne !== "boolean") {
    fieldError({ plusOneAttending: "Choose yes or no." });
  }
  if (plusOne === true && !plusOneAllowed) {
    fieldError({ plusOneAttending: "Your invitation doesn't include a plus-one." });
  }

  return {
    attending,
    mealChoice: optionalText(body, "mealChoice", MEAL_CHOICE_MAX),
    dietaryNotes: optionalText(body, "dietaryNotes", DIETARY_NOTES_MAX),
    // A guest who isn't coming can't bring a plus-one.
    plusOneAttending: attending && plusOne === true,
  };
}

/** A usable email address on a guest record, or null. */
export function deliverableEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim();
  return email.length <= 254 && /^[^\s@]{1,64}@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}
