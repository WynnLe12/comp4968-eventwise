// Types for invitations and RSVP (Feature 8). API contract: docs/api/rsvp.md.
// Table designs: database/dynamodb/rsvp.md (EventWise_Rsvp) and guests.md (EventWise_Guests).

/** Same values the guest API stores. */
export const RSVP_STATUSES = ["UNINVITED", "PENDING", "ACCEPTED", "REJECTED"] as const;
export type RsvpStatus = (typeof RSVP_STATUSES)[number];

/** The EventWise_Guests table key of one guest. */
export interface GuestKey {
  eventId: string;
  guestId: string;
}

/**
 * The guest attributes this service reads or writes in EventWise_Guests.
 * Other attributes (createdBy, group, …) belong to the guest API and are left untouched.
 */
export interface GuestRecord {
  eventId: string;
  guestId: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  plusOneAllowed?: boolean;
  rsvpStatus?: string;
  mealChoice?: string;
  dietaryNotes?: string;
  /** Set by the guest's RSVP: whether their plus-one is coming. */
  plusOneAttending?: boolean;
  /** ISO 8601 UTC: when the latest invitation email was queued. */
  invitedAt?: string;
  /** ISO 8601 UTC: when the guest last submitted the RSVP form. */
  rsvpRespondedAt?: string;
  /** ISO 8601 UTC: when the one reminder was queued. Never cleared, so a guest is reminded once. */
  reminderSentAt?: string;
}

/** The event details shown on invitations and the RSVP page, copied from the Event API. */
export interface EventSnapshot {
  eventName: string;
  /** "YYYY-MM-DD" or null when the event has no date yet. */
  eventDate: string | null;
  venue: string | null;
}

/** One item per event in EventWise_Rsvp. */
export interface RsvpSettings extends EventSnapshot {
  eventId: string;
  /** "HH:MM" (24-hour, event's local time) or null. Events in MySQL only have a date. */
  startTime: string | null;
  /** ISO 8601 UTC. RSVPs close at this instant. */
  deadline: string;
  /** ISO 8601 UTC, or null for no reminder. Always before the deadline. */
  reminderAt: string | null;
  /** Optional note from the hosts, shown on the invitation and RSVP page. */
  message: string | null;
  /** OPEN until the deadline workflow closes it. The API also treats a passed deadline as closed. */
  status: "OPEN" | "CLOSED";
  /** Changes every time invitations are (re)sent; stale workflow runs compare it and do nothing. */
  workflowId: string;
  executionArn: string | null;
  invitationsSentAt: string;
  reminderSentAt: string | null;
  closedAt: string | null;
  updatedAt: string;
  /** Cognito sub of the organizer who last sent invitations. Not returned by the API. */
  updatedBy: string;
}

/** What organizers see about an event's RSVP settings. */
export interface RsvpSettingsView extends EventSnapshot {
  startTime: string | null;
  deadline: string;
  reminderAt: string | null;
  message: string | null;
  /** CLOSED once the deadline has passed, even before the workflow runs. */
  status: "OPEN" | "CLOSED";
  invitationsSentAt: string;
  reminderSentAt: string | null;
  closedAt: string | null;
}

/** What a guest sees on their RSVP page. Never includes other guests or the guest's email. */
export interface GuestRsvpView {
  event: EventSnapshot & { startTime: string | null };
  message: string | null;
  deadline: string;
  closed: boolean;
  guest: {
    firstName: string | null;
    lastName: string | null;
    plusOneAllowed: boolean;
    rsvpStatus: RsvpStatus;
    /** Meal preference, including any allergies. */
    mealChoice: string | null;
    plusOneAttending: boolean | null;
    respondedAt: string | null;
  };
}

/** The guest's answers from the RSVP form, after validation. */
export interface RsvpResponse {
  attending: boolean;
  /** Meal preference, including any allergies (up to 200 characters). */
  mealChoice: string | null;
  plusOneAttending: boolean;
}

/** Organizer request to save RSVP settings and send invitations, after validation. */
export interface SendInvitationsInput {
  deadline: string;
  startTime: string | null;
  reminderAt: string | null;
  message: string | null;
  /** Also email guests who were invited before but haven't answered. */
  includePending: boolean;
}

export interface SendInvitationsResult {
  settings: RsvpSettingsView;
  /** Invitation emails put on the queue. */
  queued: number;
  /** Emails that could not be queued; those guests keep their old status. */
  failed: number;
  /** Guests who would have been invited but have no email address. */
  skippedNoEmail: number;
}
