// DynamoDB access for Feature 8.
//
//   EventWise_Rsvp    one settings item per event (partition key eventId). database/dynamodb/rsvp.md
//   EventWise_Guests  the guest list (eventId + guestId). This service only touches the RSVP
//                     attributes; database/dynamodb/guests.md lists them.
//
// Every guest call includes eventId, so one event's guests can't be reached through another.

import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { getDocumentClient } from "../../shared/db/dynamodb";
import type { EventSnapshot, GuestKey, GuestRecord, RsvpResponse, RsvpSettings } from "../types";

export const DEFAULT_RSVP_TABLE = "EventWise_Rsvp";
export const DEFAULT_GUESTS_TABLE = "EventWise_Guests";

type Client = Pick<DynamoDBDocumentClient, "send">;

/** Result of saving a guest's response. */
export type SaveResponseResult = "SAVED" | "CLOSED" | "GUEST_NOT_FOUND";

function isConditionFailure(error: unknown): boolean {
  return error instanceof Error && error.name === "ConditionalCheckFailedException";
}

export class RsvpRepository {
  private readonly client: Client;
  private readonly rsvpTable: string;
  private readonly guestsTable: string;

  constructor(options: { client?: Client; rsvpTable?: string; guestsTable?: string } = {}) {
    this.client = options.client ?? getDocumentClient();
    this.rsvpTable = options.rsvpTable ?? process.env.RSVP_TABLE_NAME ?? DEFAULT_RSVP_TABLE;
    this.guestsTable = options.guestsTable ?? process.env.GUESTS_TABLE_NAME ?? DEFAULT_GUESTS_TABLE;
  }

  // --- Settings (EventWise_Rsvp) -------------------------------------------------------

  async getSettings(eventId: string): Promise<RsvpSettings | null> {
    const result = await this.client.send(new GetCommand({
      TableName: this.rsvpTable, Key: { eventId }, ConsistentRead: true,
    }));
    return (result.Item as RsvpSettings | undefined) ?? null;
  }

  async putSettings(settings: RsvpSettings): Promise<void> {
    await this.client.send(new PutCommand({ TableName: this.rsvpTable, Item: settings }));
  }

  /** Records the workflow execution, unless invitations were re-sent in the meantime. */
  async setExecutionArn(eventId: string, workflowId: string, executionArn: string): Promise<void> {
    try {
      await this.client.send(new UpdateCommand({
        TableName: this.rsvpTable,
        Key: { eventId },
        UpdateExpression: "SET executionArn = :arn",
        ConditionExpression: "workflowId = :workflowId",
        ExpressionAttributeValues: { ":arn": executionArn, ":workflowId": workflowId },
      }));
    } catch (error) {
      if (!isConditionFailure(error)) throw error;
    }
  }

  /** Keeps the event name/date/venue shown to guests in step with the Event API. */
  async refreshSnapshot(eventId: string, snapshot: EventSnapshot): Promise<void> {
    try {
      await this.client.send(new UpdateCommand({
        TableName: this.rsvpTable,
        Key: { eventId },
        UpdateExpression: "SET eventName = :name, eventDate = :date, venue = :venue",
        ConditionExpression: "attribute_exists(eventId)",
        ExpressionAttributeValues: { ":name": snapshot.eventName, ":date": snapshot.eventDate, ":venue": snapshot.venue },
      }));
    } catch (error) {
      if (!isConditionFailure(error)) throw error;
    }
  }

  /** Notes on the settings that the reminder run happened (shown to organizers). */
  async recordReminderRun(eventId: string, workflowId: string, at: string): Promise<void> {
    try {
      await this.client.send(new UpdateCommand({
        TableName: this.rsvpTable,
        Key: { eventId },
        UpdateExpression: "SET reminderSentAt = :at",
        ConditionExpression: "workflowId = :workflowId",
        ExpressionAttributeValues: { ":at": at, ":workflowId": workflowId },
      }));
    } catch (error) {
      if (!isConditionFailure(error)) throw error;
    }
  }

  /** Closes RSVPs if this workflow run is still the current one. Returns false for a stale run. */
  async close(eventId: string, workflowId: string, at: string): Promise<boolean> {
    try {
      await this.client.send(new UpdateCommand({
        TableName: this.rsvpTable,
        Key: { eventId },
        UpdateExpression: "SET #status = :closed, closedAt = :at",
        ConditionExpression: "workflowId = :workflowId",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":closed": "CLOSED", ":at": at, ":workflowId": workflowId },
      }));
      return true;
    } catch (error) {
      if (isConditionFailure(error)) return false;
      throw error;
    }
  }

  // --- Guests (EventWise_Guests) -------------------------------------------------------

  async listGuests(eventId: string): Promise<GuestRecord[]> {
    const guests: GuestRecord[] = [];
    let lastKey: Record<string, unknown> | undefined;
    do {
      const page = await this.client.send(new QueryCommand({
        TableName: this.guestsTable,
        KeyConditionExpression: "eventId = :eventId",
        ExpressionAttributeValues: { ":eventId": eventId },
        ExclusiveStartKey: lastKey,
      }));
      guests.push(...((page.Items ?? []) as GuestRecord[]));
      lastKey = page.LastEvaluatedKey;
    } while (lastKey);
    return guests;
  }

  async getGuest(key: GuestKey): Promise<GuestRecord | null> {
    const result = await this.client.send(new GetCommand({
      TableName: this.guestsTable, Key: { eventId: key.eventId, guestId: key.guestId }, ConsistentRead: true,
    }));
    return (result.Item as GuestRecord | undefined) ?? null;
  }

  /**
   * After an invitation email is queued: an UNINVITED guest becomes PENDING; a PENDING guest
   * (re-sent invitation) stays PENDING. A guest who answered in the meantime is left alone.
   */
  async markInvited(key: GuestKey, at: string): Promise<boolean> {
    try {
      await this.client.send(new UpdateCommand({
        TableName: this.guestsTable,
        Key: { eventId: key.eventId, guestId: key.guestId },
        UpdateExpression: "SET rsvpStatus = :pending, invitedAt = :at, updatedAt = :at",
        ConditionExpression: "attribute_exists(guestId) AND (rsvpStatus IN (:uninvited, :pending) OR attribute_not_exists(rsvpStatus))",
        ExpressionAttributeValues: { ":pending": "PENDING", ":uninvited": "UNINVITED", ":at": at },
      }));
      return true;
    } catch (error) {
      if (isConditionFailure(error)) return false;
      throw error;
    }
  }

  /**
   * Claims the guest's one reminder before it is queued. Only a PENDING guest who has never
   * been reminded can be claimed, so overlapping or retried runs can't remind anyone twice.
   */
  async claimReminder(key: GuestKey, at: string): Promise<boolean> {
    try {
      await this.client.send(new UpdateCommand({
        TableName: this.guestsTable,
        Key: { eventId: key.eventId, guestId: key.guestId },
        UpdateExpression: "SET reminderSentAt = :at",
        ConditionExpression: "attribute_exists(guestId) AND rsvpStatus = :pending AND attribute_not_exists(reminderSentAt)",
        ExpressionAttributeValues: { ":pending": "PENDING", ":at": at },
      }));
      return true;
    } catch (error) {
      if (isConditionFailure(error)) return false;
      throw error;
    }
  }

  /** Undoes a claim whose email couldn't be queued, so a retry can send it. */
  async releaseReminder(key: GuestKey, at: string): Promise<void> {
    try {
      await this.client.send(new UpdateCommand({
        TableName: this.guestsTable,
        Key: { eventId: key.eventId, guestId: key.guestId },
        UpdateExpression: "REMOVE reminderSentAt",
        ConditionExpression: "reminderSentAt = :at",
        ExpressionAttributeValues: { ":at": at },
      }));
    } catch (error) {
      if (!isConditionFailure(error)) throw error;
    }
  }

  /**
   * Saves a guest's RSVP in one transaction that also checks the event's RSVPs are still
   * open (status OPEN and deadline later than now), so a response can't slip in after closing.
   */
  async saveResponse(key: GuestKey, response: RsvpResponse, now: string): Promise<SaveResponseResult> {
    const names: Record<string, string> = { "#status": "rsvpStatus" };
    const values: Record<string, unknown> = {
      ":status": response.attending ? "ACCEPTED" : "REJECTED",
      ":plusOne": response.plusOneAttending,
      ":now": now,
    };
    const set = ["#status = :status", "plusOneAttending = :plusOne", "rsvpRespondedAt = :now", "updatedAt = :now"];
    const remove: string[] = [];
    for (const field of ["mealChoice", "dietaryNotes"] as const) {
      if (response[field] === null) remove.push(field);
      else {
        set.push(`${field} = :${field}`);
        values[`:${field}`] = response[field];
      }
    }

    try {
      await this.client.send(new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: this.rsvpTable,
              Key: { eventId: key.eventId },
              ConditionExpression: "#settingsStatus = :open AND deadline > :now",
              ExpressionAttributeNames: { "#settingsStatus": "status" },
              ExpressionAttributeValues: { ":open": "OPEN", ":now": now },
            },
          },
          {
            Update: {
              TableName: this.guestsTable,
              Key: { eventId: key.eventId, guestId: key.guestId },
              UpdateExpression: `SET ${set.join(", ")}${remove.length ? ` REMOVE ${remove.join(", ")}` : ""}`,
              ConditionExpression: "attribute_exists(guestId)",
              ExpressionAttributeNames: names,
              ExpressionAttributeValues: values,
            },
          },
        ],
      }));
      return "SAVED";
    } catch (error) {
      if (error instanceof Error && error.name === "TransactionCanceledException") {
        const reasons = (error as Error & { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? [];
        if (reasons[0]?.Code === "ConditionalCheckFailed") return "CLOSED";
        if (reasons[1]?.Code === "ConditionalCheckFailed") return "GUEST_NOT_FOUND";
      }
      throw error;
    }
  }
}
