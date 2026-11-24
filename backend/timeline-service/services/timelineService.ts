// What each organizer timeline route does (Feature 13, US40 and US43).
// Rules: docs/api/timeline.md, sections 2, 4 and 7.
//
// Order for every operation: path IDs (400) -> event membership (403) -> body (422)
// -> storage (404/409). Non-members therefore get 403 whatever they send.
// Throws ApiError for every expected failure.

import { ApiError } from "../../expense-service/errors";
import { TimelineConfigurationError } from "../errors";
import { requireMember as requireMemberInMySql } from "../../shared/auth/requireMember";
import type { TimelineRepository } from "../repositories/timelineRepository";
import type { TimelineFields, TimelineItem, TimelineRecord } from "../types";
import { calculateReminderAt, rescheduleReminder } from "./reminders";
import { toTimelineItem } from "./timelineMapper";
import {
  LIMITS,
  assertEndsAfterStart,
  parseNotifyQuery,
  requireEventId,
  requireItemId,
  validateNewItem,
  validatePatch,
} from "./validation";

/** Editable fields, in the order they are reported in `changedFields`. */
const TRACKED_FIELDS = [
  "title", "place", "notes", "startsAt", "endsAt", "visibility", "reminderMinutes",
] as const satisfies readonly (keyof TimelineFields)[];

/**
 * Fields people need to hear about. Changing only notes or the reminder setting
 * never sends a change email (docs/api/timeline.md, section 7).
 */
export const NOTIFY_FIELDS: ReadonlySet<keyof TimelineFields> = new Set([
  "title", "place", "startsAt", "endsAt", "visibility",
]);

export type NotificationStatus = "NOT_REQUESTED" | "NO_CHANGE" | "NO_RECIPIENTS" | "QUEUED" | "FAILED";

export interface NotificationResult {
  status: NotificationStatus;
  recipients: number;
}

/** A change worth telling people about. `after` is null when the activity was deleted. */
export interface TimelineChange {
  type: "UPDATED" | "DELETED";
  eventId: string;
  before: TimelineRecord;
  after: TimelineRecord | null;
  changedFields: (keyof TimelineFields)[];
}

/** Sends change emails. The SQS implementation is added with the notification commit. */
export interface TimelineNotifier {
  timelineChanged(change: TimelineChange): Promise<NotificationResult>;
}

/** Until notifications are wired up, a requested notification reaches nobody. */
export const notificationsNotConfigured: TimelineNotifier = {
  async timelineChanged() {
    return { status: "NO_RECIPIENTS", recipients: 0 };
  },
};

export type TimelineStore = Pick<
  TimelineRepository,
  "listItems" | "countItems" | "getItem" | "createItem" | "updateItem" | "deleteItem"
>;

/** Resolves when `sub` is an OWNER or CO_PLANNER of the event; otherwise throws ApiError 403. */
export type MembershipCheck = (eventId: string, sub: string) => Promise<unknown>;

export interface TimelineServiceOptions {
  repository: TimelineStore;
  requireMember?: MembershipCheck;
  notifier?: TimelineNotifier;
  now?: () => Date;
  /** Logs a failed notification without addresses or message bodies. */
  logError?: (message: string, error: unknown) => void;
}

export interface TimelineList {
  eventId: string;
  items: TimelineItem[];
}

export interface UpdateResult {
  item: TimelineItem;
  changedFields: (keyof TimelineFields)[];
  notification: NotificationResult;
}

export interface DeleteResult {
  notification: NotificationResult;
}

const notFound = () => new ApiError(404, "NOT_FOUND", "Timeline item not found.");
const versionConflict = () =>
  new ApiError(409, "VERSION_CONFLICT", "Someone else changed this activity. Reload the timeline and try again.");
const timelineFull = () =>
  new ApiError(409, "TIMELINE_FULL", `An event can have at most ${LIMITS.itemsPerEvent} timeline activities.`);

export class TimelineService {
  private readonly repository: TimelineStore;
  private readonly requireMember: MembershipCheck;
  private readonly notifier: TimelineNotifier;
  private readonly now: () => Date;
  private readonly logError: (message: string, error: unknown) => void;

  constructor(options: TimelineServiceOptions) {
    this.repository = options.repository;
    this.requireMember = options.requireMember ?? requireMemberInMySql;
    this.notifier = options.notifier ?? notificationsNotConfigured;
    this.now = options.now ?? (() => new Date());
    // A configuration problem names the missing setting; anything else logs only its type.
    this.logError = options.logError ?? ((message, error) => console.error(
      error instanceof TimelineConfigurationError ? `${message}: ${error.message}` : message,
      error instanceof TimelineConfigurationError ? "" : error instanceof Error ? error.name : "unknown error",
    ));
  }

  async list(rawEventId: unknown, sub: string): Promise<TimelineList> {
    const eventId = requireEventId(rawEventId);
    await this.requireMember(eventId, sub);
    const records = await this.repository.listItems(eventId);
    return { eventId, items: records.map(toTimelineItem) };
  }

  async create(rawEventId: unknown, sub: string, body: unknown): Promise<TimelineItem> {
    const eventId = requireEventId(rawEventId);
    await this.requireMember(eventId, sub);
    const fields = validateNewItem(body);
    // Best-effort limit: two simultaneous creates at 99 can both succeed. Acceptable for a soft cap.
    if ((await this.repository.countItems(eventId)) >= LIMITS.itemsPerEvent) throw timelineFull();
    const reminderAt = calculateReminderAt(fields.startsAt, fields.reminderMinutes, this.now());
    const record = await this.repository.createItem(eventId, { ...fields, reminderAt }, sub);
    return toTimelineItem(record);
  }

  async update(rawEventId: unknown, rawItemId: unknown, sub: string, body: unknown): Promise<UpdateResult> {
    const eventId = requireEventId(rawEventId);
    const itemId = requireItemId(rawItemId);
    await this.requireMember(eventId, sub);
    const { changes, version, notify } = validatePatch(body);

    const stored = await this.repository.getItem(eventId, itemId);
    if (!stored) throw notFound();
    // Fail fast on a stale version; the conditional write below still guards against races.
    if (stored.version !== version) throw versionConflict();

    const merged = { ...fieldsOf(stored), ...changes };
    assertEndsAfterStart(merged.startsAt, merged.endsAt);
    const reminderAt = rescheduleReminder(fieldsOf(stored), merged, this.now());

    const outcome = await this.repository.updateItem(
      eventId, itemId, version,
      reminderAt === undefined ? changes : { ...changes, reminderAt },
      sub,
    );
    if (outcome.status === "NOT_FOUND") throw notFound();
    if (outcome.status === "VERSION_CONFLICT") throw versionConflict();

    const changedFields = changedFieldsBetween(outcome.previous, outcome.record);
    const notification = await this.notifyIfRequested(notify, {
      type: "UPDATED", eventId, before: outcome.previous, after: outcome.record, changedFields,
    });
    return { item: toTimelineItem(outcome.record), changedFields, notification };
  }

  async delete(
    rawEventId: unknown,
    rawItemId: unknown,
    sub: string,
    query?: Record<string, string | undefined> | null,
  ): Promise<DeleteResult> {
    const eventId = requireEventId(rawEventId);
    const itemId = requireItemId(rawItemId);
    await this.requireMember(eventId, sub);
    const notify = parseNotifyQuery(query);

    const deleted = await this.repository.deleteItem(eventId, itemId);
    if (!deleted) throw notFound();

    const notification = await this.notifyIfRequested(notify, {
      type: "DELETED", eventId, before: deleted, after: null, changedFields: [],
    });
    return { notification };
  }

  /**
   * Notifies only when asked and when something people care about changed.
   * The edit is already saved: a notification failure is reported, never thrown.
   */
  private async notifyIfRequested(notify: boolean, change: TimelineChange): Promise<NotificationResult> {
    if (!notify) return { status: "NOT_REQUESTED", recipients: 0 };
    if (!isNotifiable(change)) return { status: "NO_CHANGE", recipients: 0 };
    try {
      return await this.notifier.timelineChanged(change);
    } catch (error) {
      this.logError(`Timeline ${change.type.toLowerCase()} notification failed for event ${change.eventId}`, error);
      return { status: "FAILED", recipients: 0 };
    }
  }
}

/** A deletion always matters; an update matters when a NOTIFY_FIELDS field changed. */
export function isNotifiable(change: Pick<TimelineChange, "type" | "changedFields">): boolean {
  return change.type === "DELETED" || change.changedFields.some((field) => NOTIFY_FIELDS.has(field));
}

/** Editable fields whose stored value differs. An omitted optional field counts as null. */
export function changedFieldsBetween(before: TimelineRecord, after: TimelineRecord): (keyof TimelineFields)[] {
  const a = fieldsOf(before);
  const b = fieldsOf(after);
  return TRACKED_FIELDS.filter((field) => a[field] !== b[field]);
}

/** The editable fields of a stored record, with omitted optional fields as null. */
function fieldsOf(record: TimelineRecord): TimelineFields {
  return {
    title: record.title,
    place: record.place ?? null,
    notes: record.notes ?? null,
    startsAt: record.startsAt,
    endsAt: record.endsAt ?? null,
    visibility: record.visibility,
    reminderMinutes: record.reminderMinutes,
  };
}
