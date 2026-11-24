import type { CreateTableCommandInput } from "@aws-sdk/client-dynamodb";

// Layout of the EventWise_Timeline table (Feature 13). See database/dynamodb/timeline.md
// and docs/api/timeline.md. Used to create the same table in DynamoDB Local.
//
// One table holds two kinds of rows for an event, told apart by the sort key:
//   ITEM#<itemId>             a timeline activity
//   SUBSCRIBER#<cognito sub>  an organizer who wants timeline emails

export const DEFAULT_TIMELINE_TABLE_NAME = "EventWise_Timeline";

/** Sparse index of activities still waiting for their reminder email. */
export const REMINDER_INDEX_NAME = "ReminderIndex";

/** Only value stored in `reminderStatus`; the attribute is removed once the reminder is claimed. */
export const REMINDER_PENDING = "PENDING";

const ITEM_PREFIX = "ITEM#";
const SUBSCRIBER_PREFIX = "SUBSCRIBER#";

export const itemSortKey = (itemId: string): string => `${ITEM_PREFIX}${itemId}`;
export const subscriberSortKey = (sub: string): string => `${SUBSCRIBER_PREFIX}${sub}`;

/** Prefix for a Query that returns only an event's activities (begins_with on `sk`). */
export const ITEM_SORT_KEY_PREFIX = ITEM_PREFIX;
/** Prefix for a Query that returns only an event's subscribers. */
export const SUBSCRIBER_SORT_KEY_PREFIX = SUBSCRIBER_PREFIX;

export function timelineTableName(env: NodeJS.ProcessEnv = process.env): string {
  return env.TIMELINE_TABLE_NAME?.trim() || DEFAULT_TIMELINE_TABLE_NAME;
}

export function timelineTableDefinition(tableName: string): CreateTableCommandInput {
  return {
    TableName: tableName,
    AttributeDefinitions: [
      { AttributeName: "eventId", AttributeType: "S" },
      { AttributeName: "sk", AttributeType: "S" },
      { AttributeName: "reminderStatus", AttributeType: "S" },
      { AttributeName: "reminderAt", AttributeType: "S" },
    ],
    KeySchema: [
      { AttributeName: "eventId", KeyType: "HASH" },
      { AttributeName: "sk", KeyType: "RANGE" },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: REMINDER_INDEX_NAME,
        KeySchema: [
          { AttributeName: "reminderStatus", KeyType: "HASH" },
          { AttributeName: "reminderAt", KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "ALL" },
      },
    ],
    BillingMode: "PAY_PER_REQUEST",
  };
}
