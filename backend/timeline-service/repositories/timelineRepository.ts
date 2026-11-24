// DynamoDB data access for timeline activities (Feature 13).
//
// Table design: database/dynamodb/timeline.md
//   Partition key: eventId (String) = events.event_id from RDS, as text
//   Sort key:      sk (String)      = "ITEM#<itemId>" for activities
//
// Every method takes an eventId, so no call can read or change another event's timeline.
// Event membership and field validation are NOT checked here: the service must verify the
// caller belongs to the event and validate input before calling this repository.
// Subscriber rows and reminder claims are added with the notification commits.

import { randomUUID } from "node:crypto";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { getDocumentClient } from "../../shared/db/dynamodb";
import { compareTimeline } from "../services/timelineMapper";
import {
  ITEM_SORT_KEY_PREFIX,
  REMINDER_PENDING,
  itemSortKey,
  timelineTableName,
} from "../tableDefinition";
import type {
  NewTimelineItem,
  TimelineChanges,
  TimelineFields,
  TimelineRecord,
  UpdateOutcome,
} from "../types";

/** Fields written by create/update. Keys, version and audit fields are never taken from input. */
const EDITABLE_FIELDS = [
  "title",
  "place",
  "notes",
  "startsAt",
  "endsAt",
  "visibility",
  "reminderMinutes",
] as const satisfies readonly (keyof TimelineFields)[];

/** Fields that can be cleared with null. */
const NULLABLE_FIELDS: ReadonlySet<keyof TimelineFields> = new Set(["place", "notes", "endsAt"]);

export interface TimelineRepositoryOptions {
  client?: DynamoDBDocumentClient;
  tableName?: string;
  /** Injectable for tests. */
  now?: () => Date;
  newId?: () => string;
}

export class TimelineRepository {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(options: TimelineRepositoryOptions = {}) {
    this.client = options.client ?? getDocumentClient();
    this.tableName = options.tableName ?? timelineTableName();
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
  }

  /** All activities of one event in chronological order. Follows DynamoDB pagination until done. */
  async listItems(eventId: string): Promise<TimelineRecord[]> {
    const records: TimelineRecord[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const page = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "eventId = :eventId AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: { ":eventId": eventId, ":prefix": ITEM_SORT_KEY_PREFIX },
          ExclusiveStartKey: startKey,
        }),
      );
      records.push(...((page.Items ?? []) as TimelineRecord[]));
      startKey = page.LastEvaluatedKey;
    } while (startKey);
    return records.sort(compareTimeline);
  }

  /** Number of activities in an event, without reading their attributes. */
  async countItems(eventId: string): Promise<number> {
    let count = 0;
    let startKey: Record<string, unknown> | undefined;
    do {
      const page = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "eventId = :eventId AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: { ":eventId": eventId, ":prefix": ITEM_SORT_KEY_PREFIX },
          Select: "COUNT",
          ExclusiveStartKey: startKey,
        }),
      );
      count += page.Count ?? 0;
      startKey = page.LastEvaluatedKey;
    } while (startKey);
    return count;
  }

  /** One activity, or null if it does not exist in this event. */
  async getItem(eventId: string, itemId: string): Promise<TimelineRecord | null> {
    const result = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: { eventId, sk: itemSortKey(itemId) }, ConsistentRead: true }),
    );
    return (result.Item as TimelineRecord | undefined) ?? null;
  }

  /** Creates an activity with a new itemId at version 1. A reminder time marks it PENDING. */
  async createItem(eventId: string, item: NewTimelineItem, actor: string): Promise<TimelineRecord> {
    const timestamp = utcSeconds(this.now());
    const itemId = this.newId();
    const record: TimelineRecord = stripUndefined({
      eventId,
      sk: itemSortKey(itemId),
      itemId,
      title: item.title,
      place: nullToUndefined(item.place),
      notes: nullToUndefined(item.notes),
      startsAt: item.startsAt,
      endsAt: nullToUndefined(item.endsAt),
      visibility: item.visibility,
      reminderMinutes: item.reminderMinutes,
      reminderAt: nullToUndefined(item.reminderAt),
      reminderStatus: item.reminderAt ? REMINDER_PENDING : undefined,
      version: 1,
      createdBy: actor,
      updatedBy: actor,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: record,
        // Never overwrite an existing activity if a generated id ever collides.
        ConditionExpression: "attribute_not_exists(sk)",
      }),
    );
    return record;
  }

  /**
   * Applies a partial update only if the stored version equals `expectedVersion`,
   * then increments the version. Returns the record before and after the change, so
   * the service can tell what changed for notifications.
   *
   * `changes.reminderAt`: a string reschedules the reminder (PENDING again, sent mark cleared);
   * null cancels it. Omit it to leave the reminder as is.
   */
  async updateItem(
    eventId: string,
    itemId: string,
    expectedVersion: number,
    changes: TimelineChanges,
    actor: string,
  ): Promise<UpdateOutcome> {
    const names: Record<string, string> = {
      "#version": "version",
      "#updatedAt": "updatedAt",
      "#updatedBy": "updatedBy",
    };
    const values: Record<string, unknown> = {
      ":expected": expectedVersion,
      ":one": 1,
      ":updatedAt": utcSeconds(this.now()),
      ":updatedBy": actor,
    };
    const setParts = ["#version = #version + :one", "#updatedAt = :updatedAt", "#updatedBy = :updatedBy"];
    const removeParts: string[] = [];

    for (const field of EDITABLE_FIELDS) {
      if (!(field in changes)) continue;
      const value = changes[field];
      if (value === undefined) continue;
      names[`#${field}`] = field;
      if (value === null) {
        if (!NULLABLE_FIELDS.has(field)) throw new Error(`${field} cannot be cleared`);
        removeParts.push(`#${field}`);
      } else {
        values[`:${field}`] = value;
        setParts.push(`#${field} = :${field}`);
      }
    }

    if ("reminderAt" in changes && changes.reminderAt !== undefined) {
      Object.assign(names, {
        "#reminderAt": "reminderAt",
        "#reminderStatus": "reminderStatus",
        "#reminderSentAt": "reminderSentAt",
      });
      if (changes.reminderAt === null) {
        removeParts.push("#reminderAt", "#reminderStatus", "#reminderSentAt");
      } else {
        values[":reminderAt"] = changes.reminderAt;
        values[":pending"] = REMINDER_PENDING;
        setParts.push("#reminderAt = :reminderAt", "#reminderStatus = :pending");
        removeParts.push("#reminderSentAt");
      }
    }

    let expression = `SET ${setParts.join(", ")}`;
    if (removeParts.length) expression += ` REMOVE ${removeParts.join(", ")}`;

    try {
      const result = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { eventId, sk: itemSortKey(itemId) },
          UpdateExpression: expression,
          // Update only an existing activity at the version the client last read.
          ConditionExpression: "attribute_exists(sk) AND #version = :expected",
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: "ALL_OLD",
          // On a failed condition DynamoDB returns the stored item, if any, so a
          // version conflict can be told apart from a missing activity in one call.
          ReturnValuesOnConditionCheckFailure: "ALL_OLD",
        }),
      );
      const previous = result.Attributes as TimelineRecord;
      return { status: "UPDATED", previous, record: applyChanges(previous, changes, expectedVersion, values[":updatedAt"] as string, actor) };
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        return error.Item ? { status: "VERSION_CONFLICT" } : { status: "NOT_FOUND" };
      }
      throw error;
    }
  }

  /** Deletes one activity and returns it, or null if it did not exist in this event. */
  async deleteItem(eventId: string, itemId: string): Promise<TimelineRecord | null> {
    try {
      const result = await this.client.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: { eventId, sk: itemSortKey(itemId) },
          ConditionExpression: "attribute_exists(sk)",
          ReturnValues: "ALL_OLD",
        }),
      );
      return (result.Attributes as TimelineRecord | undefined) ?? null;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) return null;
      throw error;
    }
  }
}

/**
 * Builds the stored record after an update from the old record and the applied changes.
 * Returning ALL_OLD (rather than a second read) gives both versions from one write.
 */
function applyChanges(
  previous: TimelineRecord,
  changes: TimelineChanges,
  expectedVersion: number,
  updatedAt: string,
  updatedBy: string,
): TimelineRecord {
  const next: Record<string, unknown> = { ...previous };
  for (const field of EDITABLE_FIELDS) {
    if (!(field in changes) || changes[field] === undefined) continue;
    if (changes[field] === null) delete next[field];
    else next[field] = changes[field];
  }
  if ("reminderAt" in changes && changes.reminderAt !== undefined) {
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
  next.updatedAt = updatedAt;
  next.updatedBy = updatedBy;
  return next as unknown as TimelineRecord;
}

/** ISO 8601 UTC without milliseconds, e.g. "2026-11-24T05:12:44Z". */
export function utcSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function nullToUndefined<T>(value: T | null | undefined): T | undefined {
  return value === null || value === undefined ? undefined : value;
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
