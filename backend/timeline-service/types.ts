// Timeline types shared by the timeline service (Feature 13).
// API contract: docs/api/timeline.md. Table design: database/dynamodb/timeline.md.

export const VISIBILITIES = ["GUESTS", "TEAM"] as const;
export type Visibility = (typeof VISIBILITIES)[number];

/** Minutes before `startsAt` to send a reminder. 0 means no reminder. */
export const REMINDER_MINUTES = [0, 15, 60, 1440] as const;
export type ReminderMinutes = (typeof REMINDER_MINUTES)[number];

/** Fields an organizer may set. Instants are UTC ISO 8601 strings, e.g. "2026-12-05T23:00:00Z". */
export interface TimelineFields {
  title: string;
  place: string | null;
  notes: string | null;
  startsAt: string;
  endsAt: string | null;
  visibility: Visibility;
  reminderMinutes: ReminderMinutes;
}

/** A validated new activity, with its reminder time already calculated by the service. */
export interface NewTimelineItem extends TimelineFields {
  reminderAt: string | null;
}

/**
 * A validated partial update. A null value clears a nullable field.
 * When `reminderAt` is present, the reminder is rescheduled (string) or cancelled (null).
 */
export type TimelineChanges = Partial<TimelineFields> & { reminderAt?: string | null };

/**
 * One activity as stored in DynamoDB (key: eventId + sk = "ITEM#<itemId>").
 * Optional fields are omitted from the item when empty, never stored as null.
 */
export interface TimelineRecord {
  eventId: string;
  sk: string;
  itemId: string;
  title: string;
  place?: string;
  notes?: string;
  startsAt: string;
  endsAt?: string;
  visibility: Visibility;
  reminderMinutes: ReminderMinutes;
  reminderAt?: string;
  /** "PENDING" only while a reminder is waiting; keeps ReminderIndex sparse. */
  reminderStatus?: string;
  reminderSentAt?: string;
  version: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

/** Activity JSON returned to organizers. */
export interface TimelineItem {
  eventId: string;
  itemId: string;
  title: string;
  place: string | null;
  notes: string | null;
  startsAt: string;
  endsAt: string | null;
  visibility: Visibility;
  reminderMinutes: ReminderMinutes;
  reminderAt: string | null;
  reminderSent: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** Activity JSON returned on the public guest timeline: no visibility, reminder or audit fields. */
export interface GuestTimelineItem {
  itemId: string;
  title: string;
  place: string | null;
  notes: string | null;
  startsAt: string;
  endsAt: string | null;
}

/** Result of a versioned update. */
export type UpdateOutcome =
  | { status: "UPDATED"; record: TimelineRecord; previous: TimelineRecord }
  | { status: "NOT_FOUND" }
  | { status: "VERSION_CONFLICT" };

/** An organizer who opted in to timeline emails (key: eventId + sk = "SUBSCRIBER#<sub>"). */
export interface SubscriberRecord {
  eventId: string;
  sk: string;
  sub: string;
  /** Verified email from the organizer's Cognito ID token, lowercased. */
  email: string;
  subscribedAt: string;
}

export interface Subscription {
  subscribed: boolean;
  email: string | null;
}
