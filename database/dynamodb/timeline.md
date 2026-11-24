# DynamoDB table: `EventWise_Timeline` (Feature 13)

Stores each event's timeline activities and the organizers who want timeline emails.
Events and members stay in RDS MySQL; guests stay in `EventWise_Guests`.
API contract: [docs/api/timeline.md](../../docs/api/timeline.md).

## Table settings

| Setting | Value |
| --- | --- |
| Table name | `EventWise_Timeline` |
| Region | `us-west-2` |
| Partition key | `eventId` (String) |
| Sort key | `sk` (String) |
| Capacity mode | On-demand |
| Global secondary index | `ReminderIndex`: partition key `reminderStatus` (String), sort key `reminderAt` (String), projection All |

- `eventId` is `events.event_id` from RDS, stored as text (`"42"`), the same as the guests table.
- The application reads the table name from `TIMELINE_TABLE_NAME` (default `EventWise_Timeline`).

## Row types

The sort key tells the two row types apart:

| `sk` | Row |
| --- | --- |
| `ITEM#<itemId>` | One timeline activity. `itemId` is a UUID from `crypto.randomUUID()` |
| `SUBSCRIBER#<cognito sub>` | One organizer who opted in to timeline emails |

### Activity attributes

Optional attributes are left out of the item when empty, never stored as null.

| Attribute | Type | Required | Notes |
| --- | --- | --- | --- |
| `eventId` | S | yes | Partition key |
| `sk` | S | yes | `ITEM#<itemId>` |
| `itemId` | S | yes | Also kept as its own attribute so the mapper needs no string parsing |
| `title` | S | yes | 1–120 characters |
| `place` | S | no | Up to 160 characters |
| `notes` | S | no | Up to 500 characters |
| `startsAt` | S | yes | UTC ISO 8601, whole minutes, e.g. `2026-12-05T23:00:00Z` |
| `endsAt` | S | no | After `startsAt` |
| `visibility` | S | yes | `GUESTS` or `TEAM` |
| `reminderMinutes` | N | yes | `0`, `15`, `60` or `1440` |
| `reminderAt` | S | no | `startsAt − reminderMinutes`; absent when there is no future reminder |
| `reminderStatus` | S | no | `PENDING` only while a reminder is waiting; removed when it is claimed. Keeps `ReminderIndex` sparse |
| `reminderSentAt` | S | no | When the reminder was claimed |
| `version` | N | yes | Starts at 1, +1 on every update; used for optimistic locking |
| `createdBy` / `updatedBy` | S | yes | Cognito `sub`. Not returned by the API |
| `createdAt` / `updatedAt` | S | yes | ISO 8601 UTC |

Example activity:

```json
{
  "eventId": "42",
  "sk": "ITEM#3b1f0c2e-8d4a-4f6b-9e21-7a5c2d9e0f13",
  "itemId": "3b1f0c2e-8d4a-4f6b-9e21-7a5c2d9e0f13",
  "title": "Ceremony begins",
  "place": "Garden ceremony",
  "startsAt": "2026-12-05T23:00:00Z",
  "endsAt": "2026-12-05T23:30:00Z",
  "visibility": "GUESTS",
  "reminderMinutes": 60,
  "reminderAt": "2026-12-05T22:00:00Z",
  "reminderStatus": "PENDING",
  "version": 1,
  "createdBy": "a1b2c3d4-0000-0000-0000-000000000000",
  "updatedBy": "a1b2c3d4-0000-0000-0000-000000000000",
  "createdAt": "2026-11-24T05:12:44Z",
  "updatedAt": "2026-11-24T05:12:44Z"
}
```

### Subscriber attributes

| Attribute | Type | Notes |
| --- | --- | --- |
| `eventId` | S | Partition key |
| `sk` | S | `SUBSCRIBER#<cognito sub>` |
| `sub` | S | Cognito `sub` of the organizer |
| `email` | S | Verified email from the organizer's ID token, lowercased |
| `subscribedAt` | S | ISO 8601 UTC |

Subscribers are re-checked against `event_members` before each send, so a removed co-planner stops receiving emails even if the row remains.

## Access patterns

| Operation | DynamoDB call |
| --- | --- |
| List an event's activities | `Query` on `eventId` with `begins_with(sk, "ITEM#")`; sorted by `startsAt` in the service (at most 100 per event) |
| Get / update / delete one activity | `GetItem` / `UpdateItem` / `DeleteItem` on `eventId` + `ITEM#<itemId>` |
| List an event's subscribers | `Query` on `eventId` with `begins_with(sk, "SUBSCRIBER#")` |
| Subscribe / unsubscribe | `PutItem` / `DeleteItem` on `eventId` + `SUBSCRIBER#<sub>` |
| Find due reminders | `Query` on `ReminderIndex` where `reminderStatus = "PENDING"` and `reminderAt <= now` |
| Claim a reminder | `UpdateItem` that removes `reminderStatus` with condition `reminderStatus = "PENDING" AND reminderAt = :seen` |
| Delete an event's rows | `Query` on `eventId`, then `BatchWriteItem` in chunks of 25 (not wired to event deletion yet) |

Every activity call includes `eventId`, so one event's timeline can never be read through another event.
Writes use conditions: create requires the key not to exist, update requires the stored `version`, delete requires the row to exist.

`startsAt` is not a key, so moving an activity never changes its key. The list is sorted in the service rather than by the table.

## Local development

From `backend/`, with Docker Desktop running and `DYNAMODB_ENDPOINT=http://127.0.0.1:8000` in `.env`:

```sh
npm run ddb:up                      # start DynamoDB Local (shared with the guests table)
npm run ddb:create-timeline-table   # create EventWise_Timeline + ReminderIndex; safe to run again
```

The script refuses to run unless `DYNAMODB_ENDPOINT` points at this machine, so it never creates or changes the AWS table.

## Creating the AWS table (console)

DynamoDB → Tables → Create table, in `us-west-2`:

1. Table name `EventWise_Timeline`; partition key `eventId` (String); sort key `sk` (String).
2. Table settings → Customize settings → Capacity mode **On-demand**.
3. Secondary indexes → Create global index: partition key `reminderStatus` (String), sort key `reminderAt` (String), name `ReminderIndex`, projection **All**.
4. Create. The Lambda roles need access to the table ARN and `<table ARN>/index/ReminderIndex`.
