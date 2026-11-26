# DynamoDB table: `EventWise_Rsvp` (Feature 8)

One item per event with its RSVP settings: deadline, start time, reminder, the hosts' note, and the state of the deadline workflow. Guests' answers are stored on their own items in [`EventWise_Guests`](guests.md). API contract: [docs/api/rsvp.md](../../docs/api/rsvp.md).

## Table settings

| Setting | Value |
| --- | --- |
| Table name | `EventWise_Rsvp` (environment variable `RSVP_TABLE_NAME`) |
| Region | `us-west-2` |
| Partition key | `eventId` (String) |
| Sort key | none |
| Capacity mode | On-demand |
| Secondary indexes | none |

## Item attributes

| Attribute | Type | Notes |
| --- | --- | --- |
| `eventId` | S | Partition key; `events.event_id` as text |
| `eventName`, `eventDate`, `venue` | S / NULL | Copied from the Event API when invitations are sent, and refreshed whenever an organizer opens the Invitations page. `eventDate` is `YYYY-MM-DD` |
| `startTime` | S / NULL | `HH:MM`, 24-hour |
| `deadline` | S | ISO 8601 UTC to the second, e.g. `2026-12-01T07:59:00Z` |
| `reminderAt` | S / NULL | Same format; always before `deadline` |
| `message` | S / NULL | The hosts' note, up to 1000 characters |
| `status` | S | `OPEN` or `CLOSED` (attribute name is a DynamoDB reserved word: always use `#status`) |
| `workflowId` | S | UUID; changes on every send. Workflow steps with another ID do nothing |
| `executionArn` | S / NULL | The current Step Functions execution |
| `invitationsSentAt` | S | When invitations were last sent |
| `reminderSentAt` | S / NULL | When the reminder step last ran |
| `closedAt` | S / NULL | When the close step ran |
| `updatedAt` | S | |
| `updatedBy` | S | Cognito `sub` of the organizer who last sent invitations. Not returned by the API |

## Access patterns

| Operation | Call |
| --- | --- |
| Read settings | `GetItem` on `eventId` (consistent read) |
| Send invitations | `PutItem` (replaces the item) |
| Record the execution ARN, reminder run, close | `UpdateItem` with `workflowId = :current` |
| Guest answers | `TransactWriteItems`: `ConditionCheck` here (`#status = OPEN AND deadline > :now`) + `Update` on the guest item |

## Event deletion

The settings item is left behind when an event is deleted. Nothing can reach it, because every organizer route checks membership first, and guest links stop working once the guests are deleted with the event. A pending workflow run for that event finds its guests gone and does nothing.
