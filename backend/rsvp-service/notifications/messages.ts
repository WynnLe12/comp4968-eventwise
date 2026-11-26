// The SQS message contract between the RSVP Lambdas and the RSVP email sender (Feature 8).
// One message per guest. Messages carry addresses and private RSVP links: never log them.

import { rsvpUrl, type LinkSettings } from "../rsvpLink";
import type { GuestRecord, RsvpSettings } from "../types";

export interface RsvpEmailMessage {
  type: "RSVP_INVITATION" | "RSVP_REMINDER";
  to: string;
  /** "Sofia" or "Sofia Martinez"; null when the guest has no name. */
  guestName: string | null;
  eventName: string;
  /** "YYYY-MM-DD" or null. */
  eventDate: string | null;
  /** "HH:MM" or null. */
  startTime: string | null;
  venue: string | null;
  /** ISO 8601 UTC. */
  deadline: string;
  /** Optional note from the hosts. */
  message: string | null;
  /** The guest's private RSVP page. */
  rsvpUrl: string;
}

export function guestName(guest: Pick<GuestRecord, "firstName" | "lastName">): string | null {
  const name = [guest.firstName, guest.lastName].filter((part) => typeof part === "string" && part.trim()).join(" ").trim();
  return name || null;
}

/** Builds one guest's email. Throws a configuration error if the link settings are missing. */
export function rsvpEmail(
  type: RsvpEmailMessage["type"],
  guest: GuestRecord,
  to: string,
  settings: Pick<RsvpSettings, "eventName" | "eventDate" | "startTime" | "venue" | "deadline" | "message">,
  links: LinkSettings,
): RsvpEmailMessage {
  return {
    type,
    to,
    guestName: guestName(guest),
    eventName: settings.eventName,
    eventDate: settings.eventDate,
    startTime: settings.startTime,
    venue: settings.venue,
    deadline: settings.deadline,
    message: settings.message,
    rsvpUrl: rsvpUrl({ eventId: guest.eventId, guestId: guest.guestId }, links),
  };
}
