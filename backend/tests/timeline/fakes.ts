// In-memory test doubles for the timeline service (no AWS, Docker or MySQL).
// MemoryTimelineStore follows TimelineRepository's contract: chronological lists,
// version-checked updates, reminder rescheduling, and null for missing items.

import { ApiError } from "../../expense-service/errors";
import { REMINDER_PENDING, itemSortKey } from "../../timeline-service/tableDefinition";
import { compareTimeline } from "../../timeline-service/services/timelineMapper";
import type {
  NotificationResult,
  TimelineChange,
  TimelineNotifier,
  TimelineStore,
} from "../../timeline-service/services/timelineService";
import type { NewTimelineItem, TimelineChanges, TimelineRecord, UpdateOutcome } from "../../timeline-service/types";

export class MemoryTimelineStore implements TimelineStore {
  readonly records = new Map<string, TimelineRecord>();
  private nextId = 1;

  constructor(private readonly clock: () => string = () => "2026-11-24T05:00:00Z") {}

  private key(eventId: string, itemId: string) {
    return `${eventId}|${itemId}`;
  }

  /** Deterministic UUID-shaped IDs: 00000000-0000-4000-8000-000000000001, ... */
  private newId(): string {
    return `00000000-0000-4000-8000-${String(this.nextId++).padStart(12, "0")}`;
  }

  async listItems(eventId: string) {
    return [...this.records.values()].filter((r) => r.eventId === eventId).map((r) => ({ ...r })).sort(compareTimeline);
  }

  async countItems(eventId: string) {
    return [...this.records.values()].filter((r) => r.eventId === eventId).length;
  }

  async getItem(eventId: string, itemId: string) {
    const record = this.records.get(this.key(eventId, itemId));
    return record ? { ...record } : null;
  }

  async createItem(eventId: string, item: NewTimelineItem, actor: string) {
    const itemId = this.newId();
    const now = this.clock();
    const record: TimelineRecord = { eventId, sk: itemSortKey(itemId), itemId, title: item.title, startsAt: item.startsAt,
      visibility: item.visibility, reminderMinutes: item.reminderMinutes, version: 1,
      createdBy: actor, updatedBy: actor, createdAt: now, updatedAt: now };
    if (item.place !== null) record.place = item.place;
    if (item.notes !== null) record.notes = item.notes;
    if (item.endsAt !== null) record.endsAt = item.endsAt;
    if (item.reminderAt !== null) {
      record.reminderAt = item.reminderAt;
      record.reminderStatus = REMINDER_PENDING;
    }
    this.records.set(this.key(eventId, itemId), record);
    return { ...record };
  }

  async updateItem(eventId: string, itemId: string, expectedVersion: number, changes: TimelineChanges, actor: string): Promise<UpdateOutcome> {
    const stored = this.records.get(this.key(eventId, itemId));
    if (!stored) return { status: "NOT_FOUND" };
    if (stored.version !== expectedVersion) return { status: "VERSION_CONFLICT" };
    const previous = { ...stored };
    const next: Record<string, unknown> = { ...stored };
    for (const [field, value] of Object.entries(changes)) {
      if (field === "reminderAt" || value === undefined) continue;
      if (value === null) delete next[field];
      else next[field] = value;
    }
    if (changes.reminderAt !== undefined) {
      delete next.reminderSentAt;
      if (changes.reminderAt === null) {
        delete next.reminderAt;
        delete next.reminderStatus;
      } else {
        next.reminderAt = changes.reminderAt;
        next.reminderStatus = REMINDER_PENDING;
      }
    }
    next.version = expectedVersion + 1;
    next.updatedBy = actor;
    next.updatedAt = this.clock();
    this.records.set(this.key(eventId, itemId), next as unknown as TimelineRecord);
    return { status: "UPDATED", previous, record: { ...(next as unknown as TimelineRecord) } };
  }

  async deleteItem(eventId: string, itemId: string) {
    const stored = this.records.get(this.key(eventId, itemId));
    if (!stored) return null;
    this.records.delete(this.key(eventId, itemId));
    return { ...stored };
  }
}

/** Membership the same way requireMember answers it: OWNER/CO_PLANNER pass, anything else is 403. */
export function memberships(entries: [eventId: string, sub: string][]) {
  const members = new Set(entries.map(([eventId, sub]) => `${eventId}|${sub}`));
  const checked: [string, string][] = [];
  const check = async (eventId: string, sub: string) => {
    checked.push([eventId, sub]);
    if (!members.has(`${eventId}|${sub}`)) throw new ApiError(403, "FORBIDDEN", "You do not have access to this event.");
    return eventId;
  };
  return { check, checked };
}

/** Records every change it is asked to send and answers with a fixed result (or throws). */
export class RecordingNotifier implements TimelineNotifier {
  readonly changes: TimelineChange[] = [];
  constructor(private readonly answer: NotificationResult | Error = { status: "QUEUED", recipients: 3 }) {}
  async timelineChanged(change: TimelineChange) {
    this.changes.push(change);
    if (this.answer instanceof Error) throw this.answer;
    return this.answer;
  }
}
