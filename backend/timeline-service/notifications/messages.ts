// The SQS message contract between the timeline Lambdas and the email sender (Feature 13).
// One message per recipient. Messages carry addresses and share links: never log them.
// Contract: docs/api/timeline.md §7.

import { MIN_SECRET_BYTES, createEventShare } from "../../shared/auth/eventShare";
import { TimelineConfigurationError } from "../errors";
import { SHARE_PURPOSE, guestTimelineUrl, parseAppOrigin } from "../services/guestTimelineService";
import type { TimelineFields, TimelineRecord } from "../types";
import type { Audience, Recipient } from "./recipients";

export interface EmailItem {
  title: string;
  place: string | null;
  startsAt: string;
  endsAt: string | null;
}

export interface TimelineEmailMessage {
  type: "TIMELINE_CHANGED" | "TIMELINE_REMINDER";
  to: string;
  audience: Audience;
  eventName: string;
  /** TIMELINE_CHANGED only. */
  change?: "UPDATED" | "DELETED";
  /** TIMELINE_CHANGED + UPDATED only: which fields changed. */
  changedFields?: (keyof TimelineFields)[];
  /** The activity as it is now (or was, when deleted). */
  item: EmailItem;
  /** TIMELINE_CHANGED + UPDATED only: the activity before the change, for "moved from … to …". */
  previous?: EmailItem;
  /** Guests: their schedule page. Organizers: the app's Timeline page. */
  timelineUrl: string;
}

export interface LinkSettings {
  /** GUEST_APP_ORIGIN */
  origin?: string;
  /** TIMELINE_SHARE_SECRET */
  secret?: string;
}

/** Builds the link each audience should follow. Throws a configuration error naming the missing setting. */
export function timelineLinks(eventId: string, settings: LinkSettings): Record<Audience, string> {
  const origin = settings.origin && parseAppOrigin(settings.origin);
  if (!origin) throw new TimelineConfigurationError("GUEST_APP_ORIGIN must be set for timeline emails");
  if (!settings.secret || Buffer.byteLength(settings.secret) < MIN_SECRET_BYTES) {
    throw new TimelineConfigurationError(`TIMELINE_SHARE_SECRET must be at least ${MIN_SECRET_BYTES} bytes`);
  }
  return {
    GUEST: guestTimelineUrl(origin, createEventShare(eventId, SHARE_PURPOSE, settings.secret)),
    ORGANIZER: `${origin}/app/timeline`,
  };
}

export function emailItem(record: Pick<TimelineRecord, "title" | "place" | "startsAt" | "endsAt">): EmailItem {
  return { title: record.title, place: record.place ?? null, startsAt: record.startsAt, endsAt: record.endsAt ?? null };
}

interface Common {
  eventName: string;
  links: Record<Audience, string>;
}

export function changeMessages(
  recipients: Recipient[],
  change: { type: "UPDATED" | "DELETED"; before: TimelineRecord; after: TimelineRecord | null; changedFields: (keyof TimelineFields)[] },
  common: Common,
): TimelineEmailMessage[] {
  const current = emailItem(change.after ?? change.before);
  return recipients.map((recipient) => ({
    type: "TIMELINE_CHANGED",
    to: recipient.email,
    audience: recipient.audience,
    eventName: common.eventName,
    change: change.type,
    ...(change.type === "UPDATED" ? { changedFields: change.changedFields, previous: emailItem(change.before) } : {}),
    item: current,
    timelineUrl: common.links[recipient.audience],
  }));
}

export function reminderMessages(recipients: Recipient[], record: TimelineRecord, common: Common): TimelineEmailMessage[] {
  const item = emailItem(record);
  return recipients.map((recipient) => ({
    type: "TIMELINE_REMINDER",
    to: recipient.email,
    audience: recipient.audience,
    eventName: common.eventName,
    item,
    timelineUrl: common.links[recipient.audience],
  }));
}
