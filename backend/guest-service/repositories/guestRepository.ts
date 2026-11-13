// DynamoDB data access for guests (Feature 7).
//
// Table design: database/dynamodb/guests.md
//   Partition key: eventId (String) = events.event_id from RDS, as text
//   Sort key:      guestId (String) = UUID generated here
//
// Every method takes an eventId, so no call can read or change another event's guests.
// Event membership is NOT checked here: the route handler must verify the caller
// belongs to the event before calling this repository.

import { randomUUID } from "node:crypto";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { getDocumentClient } from "../../shared/db/dynamodb";
import type { GuestChanges, GuestFields, GuestItem, NewGuest } from "../types";

export const DEFAULT_GUESTS_TABLE_NAME = "EventWise_Guests";

/** Fields that may be written by create/update. Keys and system fields are never taken from input. */
const EDITABLE_FIELDS = [
  "firstName",
  "lastName",
  "email",
  "group",
  "plusOneAllowed",
  "mealChoice",
  "dietaryNotes",
] as const satisfies readonly (keyof GuestFields)[];

/** Fields that cannot be cleared with null. */
const REQUIRED_FIELDS: ReadonlySet<keyof GuestFields> = new Set(["firstName", "plusOneAllowed"]);

/** DynamoDB accepts at most 25 requests per BatchWriteItem call. */
const BATCH_WRITE_LIMIT = 25;
const BATCH_WRITE_MAX_ATTEMPTS = 5;

export interface GuestRepositoryOptions {
  client?: DynamoDBDocumentClient;
  tableName?: string;
  /** Injectable for tests. */
  now?: () => Date;
  newId?: () => string;
}

export class GuestRepository {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(options: GuestRepositoryOptions = {}) {
    this.client = options.client ?? getDocumentClient();
    this.tableName = options.tableName ?? process.env.GUESTS_TABLE_NAME ?? DEFAULT_GUESTS_TABLE_NAME;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
  }

  /** All guests of one event, oldest first. Follows DynamoDB pagination until done. */
  async listByEvent(eventId: string): Promise<GuestItem[]> {
    const guests: GuestItem[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const page = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "eventId = :eventId",
          ExpressionAttributeValues: { ":eventId": eventId },
          ExclusiveStartKey: startKey,
        }),
      );
      guests.push(...((page.Items ?? []) as GuestItem[]));
      startKey = page.LastEvaluatedKey;
    } while (startKey);
    return guests.sort(byCreatedAt);
  }

  /** One guest, or null if it does not exist in this event. */
  async get(eventId: string, guestId: string): Promise<GuestItem | null> {
    const result = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: { eventId, guestId } }),
    );
    return (result.Item as GuestItem | undefined) ?? null;
  }

  /** Creates a guest with a new guestId. RSVP starts as PENDING. */
  async create(eventId: string, guest: NewGuest, createdBy: string): Promise<GuestItem> {
    const timestamp = this.now().toISOString();
    const item: GuestItem = {
      eventId,
      guestId: this.newId(),
      firstName: guest.firstName,
      lastName: emptyToUndefined(guest.lastName),
      email: emptyToUndefined(guest.email),
      group: emptyToUndefined(guest.group),
      plusOneAllowed: guest.plusOneAllowed ?? false,
      mealChoice: emptyToUndefined(guest.mealChoice),
      dietaryNotes: emptyToUndefined(guest.dietaryNotes),
      rsvpStatus: "PENDING",
      createdBy,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: item,
        // Never overwrite an existing guest if a generated id ever collides.
        ConditionExpression: "attribute_not_exists(guestId)",
      }),
    );
    return stripUndefined(item);
  }

  /**
   * Applies a partial update and returns the updated guest, or null if the guest
   * does not exist in this event. A null or "" value clears an optional field.
   * Unknown keys are ignored.
   */
  async update(eventId: string, guestId: string, changes: GuestChanges): Promise<GuestItem | null> {
    const names: Record<string, string> = { "#updatedAt": "updatedAt" };
    const values: Record<string, unknown> = { ":updatedAt": this.now().toISOString() };
    const setParts = ["#updatedAt = :updatedAt"];
    const removeParts: string[] = [];

    for (const field of EDITABLE_FIELDS) {
      if (!(field in changes)) continue;
      const value = changes[field];
      if (value === undefined) continue;
      names[`#${field}`] = field;
      if (value === null || value === "") {
        if (REQUIRED_FIELDS.has(field)) throw new Error(`${field} cannot be cleared`);
        removeParts.push(`#${field}`);
      } else {
        values[`:${field}`] = value;
        setParts.push(`#${field} = :${field}`);
      }
    }

    let expression = `SET ${setParts.join(", ")}`;
    if (removeParts.length) expression += ` REMOVE ${removeParts.join(", ")}`;

    try {
      const result = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { eventId, guestId },
          UpdateExpression: expression,
          // Update only an existing guest; never create one through PATCH.
          ConditionExpression: "attribute_exists(guestId)",
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: "ALL_NEW",
        }),
      );
      return result.Attributes as GuestItem;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) return null;
      throw error;
    }
  }

  /** Deletes one guest. Returns false if it did not exist in this event. */
  async delete(eventId: string, guestId: string): Promise<boolean> {
    try {
      await this.client.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: { eventId, guestId },
          ConditionExpression: "attribute_exists(guestId)",
        }),
      );
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) return false;
      throw error;
    }
  }

  /**
   * Deletes every guest of an event (for when the event itself is deleted).
   * DynamoDB has no ON DELETE CASCADE, so this must be called explicitly.
   * Returns the number of guests deleted.
   */
  async deleteAllForEvent(eventId: string): Promise<number> {
    let deleted = 0;
    let startKey: Record<string, unknown> | undefined;
    do {
      const page = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "eventId = :eventId",
          ExpressionAttributeValues: { ":eventId": eventId },
          ProjectionExpression: "eventId, guestId",
          ExclusiveStartKey: startKey,
        }),
      );
      const keys = (page.Items ?? []) as Pick<GuestItem, "eventId" | "guestId">[];
      for (let i = 0; i < keys.length; i += BATCH_WRITE_LIMIT) {
        await this.batchDelete(keys.slice(i, i + BATCH_WRITE_LIMIT));
      }
      deleted += keys.length;
      startKey = page.LastEvaluatedKey;
    } while (startKey);
    return deleted;
  }

  /** Deletes up to 25 keys, retrying any items DynamoDB reports as unprocessed. */
  private async batchDelete(keys: Pick<GuestItem, "eventId" | "guestId">[]): Promise<void> {
    let requests = keys.map((key) => ({ DeleteRequest: { Key: { eventId: key.eventId, guestId: key.guestId } } }));
    for (let attempt = 1; requests.length > 0; attempt++) {
      if (attempt > BATCH_WRITE_MAX_ATTEMPTS) {
        throw new Error(`Could not delete ${requests.length} guests after ${BATCH_WRITE_MAX_ATTEMPTS} attempts`);
      }
      if (attempt > 1) await sleep(50 * 2 ** (attempt - 2));
      const result = await this.client.send(
        new BatchWriteCommand({ RequestItems: { [this.tableName]: requests } }),
      );
      requests = (result.UnprocessedItems?.[this.tableName] ?? []) as typeof requests;
    }
  }
}

function byCreatedAt(a: GuestItem, b: GuestItem): number {
  return a.createdAt.localeCompare(b.createdAt) || a.guestId.localeCompare(b.guestId);
}

function emptyToUndefined(value: string | null | undefined): string | undefined {
  return value === null || value === undefined || value === "" ? undefined : value;
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
