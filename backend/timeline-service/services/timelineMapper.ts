// Converts stored DynamoDB records into API JSON (docs/api/timeline.md).
// Optional fields are omitted in DynamoDB but always present (as null) in the API.
// Keys and internal fields (sk, reminderStatus, createdBy, updatedBy) are never exposed.

import type { GuestTimelineItem, TimelineItem, TimelineRecord } from "../types";

export function toTimelineItem(record: TimelineRecord): TimelineItem {
  return {
    eventId: record.eventId,
    itemId: record.itemId,
    title: record.title,
    place: record.place ?? null,
    notes: record.notes ?? null,
    startsAt: record.startsAt,
    endsAt: record.endsAt ?? null,
    visibility: record.visibility,
    reminderMinutes: record.reminderMinutes,
    reminderAt: record.reminderAt ?? null,
    reminderSent: record.reminderSentAt !== undefined,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** Guest projection. Callers must pass GUESTS-visible records only; see isGuestVisible. */
export function toGuestTimelineItem(record: TimelineRecord): GuestTimelineItem {
  return {
    itemId: record.itemId,
    title: record.title,
    place: record.place ?? null,
    notes: record.notes ?? null,
    startsAt: record.startsAt,
    endsAt: record.endsAt ?? null,
  };
}

export function isGuestVisible(record: Pick<TimelineRecord, "visibility">): boolean {
  return record.visibility === "GUESTS";
}

/**
 * Chronological order: startsAt, then title, then itemId, so ties are always stable.
 * Plain code-unit comparison (not localeCompare) gives the same order on every machine.
 * startsAt values are normalized UTC strings of equal length, so string order is time order.
 */
export function compareTimeline(
  a: Pick<TimelineRecord, "startsAt" | "title" | "itemId">,
  b: Pick<TimelineRecord, "startsAt" | "title" | "itemId">,
): number {
  return compare(a.startsAt, b.startsAt) || compare(a.title, b.title) || compare(a.itemId, b.itemId);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
