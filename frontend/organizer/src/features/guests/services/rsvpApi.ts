// Invitations and RSVP API (Feature 8). Contract: docs/api/rsvp.md.
// Organizer calls send the Cognito access token; guest calls are public and use the
// private token from the RSVP link, so they never send a referrer.

import { apiUrl } from "../../../services/apiConfig";
import { EventSessionError, authenticatedEventRequest } from "../../events/services/eventApi";
import type { RsvpStatus } from "./guestApi";

export class RsvpApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly fields: Record<string, string> = {},
  ) {
    super(message);
    this.name = "RsvpApiError";
  }
}

export interface RsvpSettings {
  eventName: string;
  eventDate: string | null;
  venue: string | null;
  startTime: string | null;
  /** ISO 8601 UTC. */
  deadline: string;
  reminderAt: string | null;
  message: string | null;
  status: "OPEN" | "CLOSED";
  invitationsSentAt: string;
  reminderSentAt: string | null;
  closedAt: string | null;
}

export interface SendInvitationsBody {
  deadline: string;
  startTime: string | null;
  reminderDaysBefore: number;
  message: string | null;
  includePending: boolean;
}

export interface SendInvitationsResult {
  settings: RsvpSettings;
  queued: number;
  failed: number;
  skippedNoEmail: number;
}

export interface GuestRsvp {
  event: { eventName: string; eventDate: string | null; venue: string | null; startTime: string | null };
  message: string | null;
  deadline: string;
  closed: boolean;
  guest: {
    firstName: string | null;
    lastName: string | null;
    plusOneAllowed: boolean;
    rsvpStatus: RsvpStatus;
    mealChoice: string | null;
    dietaryNotes: string | null;
    plusOneAttending: boolean | null;
    respondedAt: string | null;
  };
}

export interface RsvpAnswer {
  attending: boolean;
  mealChoice: string | null;
  dietaryNotes: string | null;
  plusOneAttending: boolean;
}

const friendly: Record<string, string> = {
  FORBIDDEN: "You no longer have access to this event.",
  VALIDATION_ERROR: "Check the highlighted fields.",
  SCHEDULING_FAILED: "We couldn't schedule the reminder and deadline, so no invitations were sent. Please try again.",
  UPSTREAM_ERROR: "We couldn't check your access to this event. Please try again.",
  RSVP_CLOSED: "RSVPs for this event have closed.",
  NOT_FOUND: "This RSVP link isn't valid. Ask the hosts for a new one.",
};

async function send<T>(path: string, init: RequestInit, token?: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      ...init,
      cache: "no-store",
      ...(token ? {} : { referrerPolicy: "no-referrer" as const }),
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new RsvpApiError("We couldn't reach the server. Check your connection and try again.", 0, "NETWORK");
  }
  const body = await response.json().catch(() => null);
  if (response.ok) return body as T;
  if (response.status === 401 && token) throw new EventSessionError("Your session has expired. Please sign in again.");
  const code: string = typeof body?.error?.code === "string" ? body.error.code : "ERROR";
  throw new RsvpApiError(friendly[code] ?? "Something went wrong. Please try again.", response.status, code, body?.error?.fields ?? {});
}

async function organizer<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { token } = await authenticatedEventRequest();
  return send<T>(path, init, token.toString());
}

const base = (eventId: string) => `/events/${encodeURIComponent(eventId)}/rsvp`;

// --- Organizers ----------------------------------------------------------------------------

export async function getRsvpSettings(eventId: string, signal?: AbortSignal): Promise<RsvpSettings | null> {
  const body = await organizer<{ settings: RsvpSettings | null }>(base(eventId), { signal });
  return body?.settings ?? null;
}

export function sendInvitations(eventId: string, input: SendInvitationsBody): Promise<SendInvitationsResult> {
  return organizer(`${base(eventId)}/invitations`, { method: "POST", body: JSON.stringify(input) });
}

export async function getGuestRsvpLink(eventId: string, guestId: string): Promise<string> {
  const body = await organizer<{ url: string }>(`${base(eventId)}/links/${encodeURIComponent(guestId)}`);
  if (typeof body?.url !== "string") throw new RsvpApiError("We couldn't create the link. Please try again.", 200, "INVALID_RESPONSE");
  return body.url;
}

// --- Guests (public) -----------------------------------------------------------------------

export async function fetchGuestRsvp(token: string, signal?: AbortSignal): Promise<GuestRsvp> {
  const body = await send<GuestRsvp>(`/rsvp/${encodeURIComponent(token)}`, { signal });
  if (!body?.event || !body.guest) throw new RsvpApiError("The RSVP page is temporarily unavailable. Please try again soon.", 200, "INVALID_RESPONSE");
  return body;
}

export function submitGuestRsvp(token: string, answer: RsvpAnswer): Promise<GuestRsvp> {
  return send(`/rsvp/${encodeURIComponent(token)}`, { method: "PUT", body: JSON.stringify(answer) });
}

// --- Formatting shared by the organizer and guest pages ----------------------------------

/** "Saturday, December 5, 2026" from "2026-12-05" (a calendar date, no time zone shift). */
export function formatEventDate(date: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric", year: "numeric" })
    .format(new Date(`${date}T12:00:00Z`));
}

/** "4:00 PM" from "16:00". */
export function formatStartTime(time: string): string {
  const [hours, minutes] = time.split(":").map(Number) as [number, number];
  return `${hours % 12 === 0 ? 12 : hours % 12}:${String(minutes).padStart(2, "0")} ${hours >= 12 ? "PM" : "AM"}`;
}

/** "Monday, November 30 at 11:59 PM" in the viewer's own time zone. */
export function formatInstant(instant: string): string {
  const date = new Date(instant);
  const day = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" }).format(date);
  const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(date);
  return `${day} at ${time}`;
}
