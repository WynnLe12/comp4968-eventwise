# Timeline API contract (Feature 13) — DRAFT

Status: proposed contract for team review. This commit adds documentation only; no route is implemented yet.
Branch: `feature13-timeline` (based on `dev` at `66c6f63`).
Scope: event timeline CRUD for organizers, a read-only guest timeline, change notifications and activity reminders.
User stories: US40 build/edit the timeline, US41 guest view, US42 reminders before activities, US43 notify affected people when it changes.

The organizer page, the guest page and the notification Lambdas all build against this document. After approval, message the team before changing it, then update this file in a pull request.

## 1. Architecture

| Piece | What it does | Network |
| --- | --- | --- |
| `eventwise-timeline` Lambda | Organizer routes, guest route, change notifications | In the RDS VPC (`eventwise-lambda-sg`): membership check in RDS, DynamoDB through the gateway endpoint, SQS through `eventwise-sqs-endpoint` |
| DynamoDB `EventWise_Timeline` | Timeline items and organizer notification subscriptions | — |
| `eventwise-timeline-reminders` Lambda | Runs every 5 minutes from EventBridge Scheduler, finds due reminders, queues emails | Outside the VPC |
| SQS `eventwise-timeline-emails` (+ DLQ) | One message per email | — |
| `eventwise-timeline-email-sender` Lambda | Reads the queue, sends through SES | Outside the VPC |

The default VPC has no NAT gateway, so the timeline Lambda never calls SES or Cognito APIs directly. Guests are read from the existing `EventWise_Guests` table; the guest API is not changed.

## 2. Authentication and event access

Organizer routes (section 4) use the same rules as the Expenses, Vendors and Guests APIs:

1. API Gateway's Cognito authorizer verifies the access token (`Authorization: Bearer <access token>`).
2. The Lambda trusts only the authorizer claims: `token_use=access`, the configured pool issuer and app client ID, and a non-empty `sub`. Missing or wrong claims return 401.
3. `requireMember()` (`backend/shared/auth/requireMember.ts`) checks `event_members`. OWNER and CO_PLANNER may use every organizer route. No membership, including an unknown event, returns 403.
4. Every item lookup is scoped by both `eventId` and `itemId`. An item missing from an authorized event returns 404.

The guest route (section 5) has no authorizer. Access comes from an HMAC share token, the same pattern as `galleryShare()` in `backend/photo-service/photos.ts`, with its own secret and purpose so a gallery link can never open a timeline and the reverse.

## 3. Wire conventions

- Responses are plain JSON with no `{ "data": ... }` wrapper, like the Guests, Vendors and Events APIs.
- Request and response bodies use camelCase. Write requests require `Content-Type: application/json`. Maximum body 16 KiB (413).
- `eventId` is a positive decimal string. `itemId` is a lowercase UUID v4.
- Instants are UTC ISO 8601 strings with whole minutes, e.g. `"2026-12-05T23:00:00Z"`. Requests may send any offset (`"2026-12-05T15:00:00-08:00"`); the API stores and returns UTC. Seconds and milliseconds must be zero.
- The UI shows times in `America/Vancouver`. The API does not store a time zone.
- Unknown fields return 422, including read-only fields (`itemId`, `version`, `createdAt`, `updatedAt`).
- PATCH omission means unchanged; `null` clears a nullable field. An empty PATCH returns 422.

## 4. Organizer routes

| Method | Path | Body | Success |
| --- | --- | --- | --- |
| GET | `/events/{eventId}/timeline` | none | 200, [TimelineList](#timelinelist) |
| POST | `/events/{eventId}/timeline` | [editable fields](#editable-fields), `title` and `startsAt` required | 201, the created [TimelineItem](#timelineitem), `Location` header |
| PATCH | `/events/{eventId}/timeline/{itemId}` | changed fields + `version`, optional `notify` | 200, [UpdateResult](#updateresult) |
| DELETE | `/events/{eventId}/timeline/{itemId}?notify=true` | none | 204, no body |
| GET | `/events/{eventId}/timeline/share` | none | 200, [ShareLink](#sharelink) |
| GET | `/events/{eventId}/timeline/subscription` | none | 200, [Subscription](#subscription) |
| PUT | `/events/{eventId}/timeline/subscription` | `{ "idToken": "<Cognito ID token>" }` | 200, [Subscription](#subscription) |
| DELETE | `/events/{eventId}/timeline/subscription` | none | 204, no body |

Every resource also has an unauthenticated OPTIONS method returning 204 with CORS headers.

### Editable fields

| Field | Type | Rules |
| --- | --- | --- |
| `title` | string | Required on POST. Trimmed, 1–120 characters |
| `place` | string \| null | Trimmed, at most 160 characters; empty string becomes `null` |
| `notes` | string \| null | At most 500 characters. Shown to guests only when `visibility` is `GUESTS` |
| `startsAt` | instant | Required on POST |
| `endsAt` | instant \| null | Must be after `startsAt` |
| `visibility` | `"GUESTS"` \| `"TEAM"` | Default `GUESTS`. `TEAM` items (vendor setup, staff calls) are never shown to guests |
| `reminderMinutes` | `0` \| `15` \| `60` \| `1440` | Default `60`. `0` means no reminder |

An event may hold at most 100 items (409 `TIMELINE_FULL`).

### TimelineItem

```json
{
  "eventId": "42",
  "itemId": "3b1f0c2e-8d4a-4f6b-9e21-7a5c2d9e0f13",
  "title": "Ceremony begins",
  "place": "Garden ceremony",
  "notes": null,
  "startsAt": "2026-12-05T23:00:00Z",
  "endsAt": "2026-12-05T23:30:00Z",
  "visibility": "GUESTS",
  "reminderMinutes": 60,
  "reminderAt": "2026-12-05T22:00:00Z",
  "reminderSent": false,
  "version": 3,
  "createdAt": "2026-11-24T05:12:44Z",
  "updatedAt": "2026-11-25T18:03:10Z"
}
```

`reminderAt` is `startsAt − reminderMinutes`, or `null` when `reminderMinutes` is `0` or that time has already passed when the item is saved. `version` starts at 1 and increases on every PATCH.

### TimelineList

```json
{ "eventId": "42", "items": [ /* TimelineItem, ordered */ ] }
```

Items are ordered by `startsAt`, then `title`, then `itemId`, so ties are stable. The list has no paging (100-item limit).

### UpdateResult

PATCH must include the `version` the client last read. A different stored version returns 409 `VERSION_CONFLICT`, so an owner and a co-planner editing at once cannot silently overwrite each other; the client reloads and retries.

`notify` (boolean, default `false`) is a request flag, not a stored field.

```json
{
  "item": { /* TimelineItem */ },
  "changedFields": ["startsAt", "place"],
  "notification": { "status": "QUEUED", "recipients": 14 }
}
```

| `notification.status` | Meaning |
| --- | --- |
| `NOT_REQUESTED` | `notify` was false |
| `NO_CHANGE` | Only `notes` or `reminderMinutes` changed, or nothing changed |
| `NO_RECIPIENTS` | Nobody affected has an email address |
| `QUEUED` | One SQS message per recipient was accepted |
| `FAILED` | The edit was saved, but queueing failed. Saving is never rolled back because email failed |

DELETE with `?notify=true` follows the same rules but returns 204; the outcome is written to CloudWatch logs without recipient addresses.

### ShareLink

```json
{ "share": "42-<43-character signature>", "url": "https://<app origin>/timeline/42-<signature>" }
```

The token is `"<eventId>-" + base64url(HMAC-SHA256(TIMELINE_SHARE_SECRET, "eventwise-timeline:<eventId>"))`. It does not expire; rotating `TIMELINE_SHARE_SECRET` invalidates every link. The URL origin comes from `GUEST_APP_ORIGIN`.

### Subscription

Organizers opt in to timeline emails from the Timeline page. Because `event_members` has no email column and the VPC cannot reach Cognito, the browser sends the user's Cognito **ID token** once. The Lambda verifies it offline against the bundled `backend/certs/cognito-jwks.json` and accepts it only when:

- signature, issuer, `aud` (app client ID), `token_use=id` and expiry are valid;
- its `sub` equals the access token's `sub`;
- `email_verified` is `true`.

The stored email is the token's `email`, lowercased. The ID token itself is never stored or logged.

```json
{ "subscribed": true, "email": "maya@example.com" }
```

GET returns `{ "subscribed": false, "email": null }` when there is no subscription. Removing a member from the event (F2) does not delete the row; recipients are re-checked against `event_members` before each send (section 7).

## 5. Guest route

| Method | Path | Success |
| --- | --- | --- |
| GET | `/guest-timeline/{share}` | 200, GuestTimeline |

```json
{
  "event": { "name": "Maya & Eli's Wedding", "eventDate": "2026-12-05", "venue": "The Willow House" },
  "items": [
    { "itemId": "3b1f0c2e-…", "title": "Ceremony begins", "place": "Garden ceremony", "notes": null,
      "startsAt": "2026-12-05T23:00:00Z", "endsAt": "2026-12-05T23:30:00Z" }
  ]
}
```

- Only `GUESTS` items, ordered as in section 4. No `visibility`, reminder, version or audit fields.
- An invalid, tampered or gallery token returns 404 `NOT_FOUND`, the same as an unknown event, so tokens can't be probed.
- Response header `Cache-Control: no-store`. Proposed: API Gateway throttling on this route (e.g. 10 requests/second).

The frontend route is `/timeline/:share` in the organizer app, next to `/gallery/:share`, and skips the organizer session check.

## 6. Storage (DynamoDB `EventWise_Timeline`)

| Key | Value |
| --- | --- |
| Partition key `eventId` (S) | Event ID |
| Sort key `sk` (S) | `ITEM#<itemId>` or `SUBSCRIBER#<cognito sub>` |
| GSI `ReminderIndex` | PK `reminderStatus` (S), SK `reminderAt` (S); projection ALL |
| Billing | On-demand |

`reminderStatus` is set to `PENDING` only while a future reminder is waiting, so the index stays sparse. Mapping to and from API JSON happens only in the mapper; `sk` and `reminderStatus` are never returned.

Writes use condition expressions: POST requires the key not to exist, PATCH requires the stored `version`, DELETE requires the item to exist.

## 7. Notifications

### Who is affected

| Item visibility | Recipients |
| --- | --- |
| `TEAM` | Subscribed organizers of the event |
| `GUESTS` | Subscribed organizers + guests in `EventWise_Guests` with an `email` and `rsvpStatus` not `DECLINED` |

When a PATCH changes `visibility`, recipients are the union of the audiences before and after, so guests learn an activity was removed from their schedule. Before sending, subscribers are filtered to current `event_members`. Addresses are deduplicated case-insensitively.

### What triggers an email

| Event | Trigger | Fields that count as a change |
| --- | --- | --- |
| Change (US43) | PATCH with `notify: true`, or DELETE with `?notify=true` | `title`, `place`, `startsAt`, `endsAt`, `visibility` |
| Reminder (US42) | Reminder Lambda finds `reminderAt <= now` | — |

A reminder is sent once per item. A PATCH that changes `startsAt` or `reminderMinutes` recalculates `reminderAt` and sets `reminderStatus` back to `PENDING`, so the moved activity gets a new reminder. Deleting an item removes its pending reminder.

The reminder Lambda claims each due item with a conditional update that removes `reminderStatus` only if it is still `PENDING` with the same `reminderAt`. Overlapping runs therefore cannot send the same reminder twice. Reminders are accurate to about 5 minutes.

### SQS message

One message per recipient on `eventwise-timeline-emails`:

```json
{
  "type": "TIMELINE_CHANGED",
  "to": "guest@example.com",
  "eventName": "Maya & Eli's Wedding",
  "change": "UPDATED",
  "changedFields": ["startsAt"],
  "item": { "title": "Ceremony begins", "place": "Garden ceremony",
            "startsAt": "2026-12-05T23:30:00Z", "endsAt": null },
  "timelineUrl": "https://<app origin>/timeline/42-<signature>"
}
```

`type` is `TIMELINE_CHANGED` (with `change` = `UPDATED` or `DELETED`) or `TIMELINE_REMINDER` (no `change` fields). TEAM items link organizers to the app's Timeline page instead of the guest URL. The sender formats times in `America/Vancouver`.

Message bodies contain email addresses and share links: keep them out of logs, enable queue encryption, and restrict queue access to the three timeline roles. Failed sends go to the DLQ after 3 receives.

SES is in sandbox: only verified addresses receive mail. Demo guests must use verified team addresses.

## 8. Errors

Same envelope as the other APIs:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Check the submitted fields.", "fields": { "endsAt": "Must be after the start time." } } }
```

| HTTP | Code | Use |
| --- | --- | --- |
| 400 | BAD_REQUEST | Malformed JSON, path ID or query |
| 401 | UNAUTHENTICATED | Missing or invalid access-token claims; invalid ID token on PUT subscription |
| 403 | FORBIDDEN | Not a member of the event |
| 403 | EMAIL_NOT_VERIFIED | ID token's email is not verified |
| 404 | NOT_FOUND | Unknown route, item not in the event, invalid share token |
| 405 | METHOD_NOT_ALLOWED | Unsupported method on a known route |
| 409 | VERSION_CONFLICT | PATCH `version` does not match the stored item |
| 409 | TIMELINE_FULL | Event already has 100 items |
| 413 | PAYLOAD_TOO_LARGE | Body over 16 KiB |
| 415 | UNSUPPORTED_MEDIA_TYPE | Write without `application/json` |
| 422 | VALIDATION_ERROR | Field rules, unknown fields, empty PATCH |
| 500 | INTERNAL_ERROR | Unexpected error; details only in logs |

## 9. Configuration

| Variable | Used by | Value |
| --- | --- | --- |
| `TIMELINE_TABLE_NAME` | all three | `EventWise_Timeline` |
| `GUESTS_TABLE_NAME` | timeline, reminders | `EventWise_Guests` |
| `TIMELINE_SHARE_SECRET` | timeline, reminders | At least 32 random bytes; never committed |
| `TIMELINE_EMAIL_QUEUE_URL` | timeline, reminders | Queue URL |
| `GUEST_APP_ORIGIN` | timeline, reminders | Organizer app origin (localhost now, Amplify later) |
| `TIMELINE_CORS_ORIGIN` | timeline | Exact browser origin |
| `SES_FROM_ADDRESS` | sender | Verified SES identity |
| `DB_SECRET_ARN`, `DB_HOST`, `DB_NAME`, `DB_PORT` | timeline | Same as the Events Lambda |
| `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID` | timeline | Same as the Events Lambda |
| `COGNITO_JWKS_FILE` | timeline | Optional. Defaults to the packaged `certs/cognito-jwks.json` (Cognito's public signing keys) |

## 10. Out of scope

Per-guest or per-group targeting, SMS or push notifications, recurring activities, calendar (.ics) export, editing a sent reminder, and a separate guest-portal app. The empty `frontend/guest-portal` folder is not used.

## 11. Acceptance examples

- An owner and a co-planner can create, edit and delete items; a signed-in non-member gets 403 on every organizer route.
- An item ID from another event returns 404, even for a member of that other event.
- Items with the same `startsAt` always come back in the same order.
- Two PATCHes sent with the same `version`: the first succeeds, the second gets 409 `VERSION_CONFLICT`.
- The guest URL shows `GUESTS` items only, works signed out, and a photo-gallery token returns 404.
- Moving an item from 4:00 PM to 4:30 PM with `notify: true` queues one email per affected address and resets its reminder; editing only `notes` queues nothing.
- A `TEAM` item never emails guests. Changing an item from `GUESTS` to `TEAM` with `notify: true` emails guests once.
- Two reminder runs overlapping on the same due item send one reminder.
- An SQS failure on PATCH still saves the edit and returns `notification.status: "FAILED"`.
