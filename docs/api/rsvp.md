# Invitations and RSVP API — Feature 8

Organizers set an RSVP deadline and send every guest a private RSVP link by email. Guests open the link without an account, say whether they're coming, give a meal preference and any allergies, and (if their invitation allows one) say whether their plus-one is coming. Guests who haven't answered get **one** reminder, and RSVPs close at the deadline.

Deployment: [rsvp-lambda.md](rsvp-lambda.md). Tables: [database/dynamodb/rsvp.md](../../database/dynamodb/rsvp.md) and [guests.md](../../database/dynamodb/guests.md). Code: `backend/rsvp-service/`.

## 1. How it fits together

```
Organizer ──POST /events/{id}/rsvp/invitations──▶ eventwise-rsvp (Lambda)
                                                    │ 1. checks membership via the Event API
                                                    │ 2. saves settings in EventWise_Rsvp
                                                    │ 3. starts the Step Functions workflow
                                                    │ 4. queues one email per guest ──▶ SQS ──▶ eventwise-rsvp-email-sender ──▶ SES
                                                    ▼
Step Functions eventwise-rsvp-deadline: wait until reminderAt ─▶ REMIND ─▶ wait until deadline ─▶ CLOSE
                                                     (eventwise-rsvp-deadline Lambda; reminders go through the same SQS queue)

Guest ──GET/PUT /rsvp/{token}──▶ eventwise-rsvp ──▶ EventWise_Guests (only that guest's item)
```

All three Lambdas run **outside the VPC**: they need Step Functions, which the VPC can't reach (no NAT gateway, no endpoint). They don't use MySQL. Organizer routes check membership the same way the guest Lambda does: by forwarding the organizer's access token to `GET /events/{eventId}` on the Event API. That response also gives the event name, date and venue, which are copied into the RSVP settings so the public page never needs MySQL.

## 2. Routes

All on REST API `hd63bpgxm8`, stage `prod`, Lambda proxy integration to `eventwise-rsvp`.

| Method | Path | Auth | Success |
| --- | --- | --- | --- |
| GET | `/events/{eventId}/rsvp` | Cognito | `200 { "settings": RsvpSettings \| null }` |
| POST | `/events/{eventId}/rsvp/invitations` | Cognito | `200` SendResult |
| GET | `/events/{eventId}/rsvp/links/{guestId}` | Cognito | `200 { "url": "https://…/rsvp/<token>" }` |
| GET | `/rsvp/{token}` | **none** (the token is the credential) | `200` GuestRsvp |
| PUT | `/rsvp/{token}` | **none** | `200` GuestRsvp (after saving) |

Organizer routes send `Authorization: Bearer <Cognito access token>`. Any member of the event (owner or co-planner) may use them. Write bodies must be `Content-Type: application/json` and at most 16 KiB.

### POST /events/{eventId}/rsvp/invitations

Saves the RSVP settings, (re)starts the deadline workflow, then emails every guest whose status is `UNINVITED` and who has an email address. Calling it again with new settings replaces them (and the workflow); it only emails guests who weren't invited yet, unless `includePending` is true.

```json
{
  "deadline": "2026-12-01T07:59:00.000Z",
  "startTime": "16:00",
  "reminderDaysBefore": 2,
  "message": "We can't wait to celebrate with you!",
  "includePending": false
}
```

| Field | Rules |
| --- | --- |
| `deadline` | **Required.** ISO 8601 instant, in the future, within a year, and not after the event date (compared in Vancouver time). Stored to the second in UTC |
| `startTime` | Optional `"HH:MM"` (24-hour). Events in MySQL only have a date, so the start time shown on invitations lives here |
| `reminderDaysBefore` | Optional integer 0–14 (default 0 = no reminder). The reminder time (`deadline − days`) must still be in the future |
| `message` | Optional, up to 1000 characters |
| `includePending` | Optional boolean. Also re-send to guests who were invited but haven't answered |

Response:

```json
{
  "settings": { "...": "RsvpSettings" },
  "queued": 12,
  "failed": 0,
  "skippedNoEmail": 2
}
```

- `queued`: invitation emails put on the queue; those guests are now `PENDING`.
- `failed`: emails that couldn't be queued; those guests keep their status, so sending again retries them.
- `skippedNoEmail`: guests who would have been invited but have no valid email address. The organizer can copy their link instead.

The workflow is started **before** any email is queued. If it can't start, the call returns `502 SCHEDULING_FAILED` and no emails are sent.

### RsvpSettings

```json
{
  "eventName": "Maya & Eli's Wedding",
  "eventDate": "2026-12-05",
  "venue": "The Willow House",
  "startTime": "16:00",
  "deadline": "2026-12-01T07:59:00Z",
  "reminderAt": "2026-11-29T07:59:00Z",
  "message": "We can't wait to celebrate with you!",
  "status": "OPEN",
  "invitationsSentAt": "2026-11-20T18:00:00Z",
  "reminderSentAt": null,
  "closedAt": null
}
```

`status` is `CLOSED` once the deadline has passed, even before the workflow's close step runs. `GET /events/{eventId}/rsvp` also refreshes `eventName`, `eventDate` and `venue` from the Event API, so guests see the event's current details.

### GuestRsvp (public)

```json
{
  "event": { "eventName": "Maya & Eli's Wedding", "eventDate": "2026-12-05", "venue": "The Willow House", "startTime": "16:00" },
  "message": "We can't wait to celebrate with you!",
  "deadline": "2026-12-01T07:59:00Z",
  "closed": false,
  "guest": {
    "firstName": "Sofia",
    "lastName": "Martinez",
    "plusOneAllowed": true,
    "rsvpStatus": "PENDING",
    "mealChoice": null,
    "plusOneAttending": null,
    "respondedAt": null
  }
}
```

It never includes the guest's email, other guests, or anything about the event beyond the fields above.

### PUT /rsvp/{token}

```json
{ "attending": true, "mealChoice": "Vegetarian, nut allergy", "plusOneAttending": true }
```

| Field | Rules |
| --- | --- |
| `attending` | **Required** boolean. Sets `rsvpStatus` to `ACCEPTED` or `REJECTED` |
| `mealChoice` | Optional, up to 200 characters. The form's single **Meal preference** field, which also asks for any allergies. Empty or null clears it |
| `plusOneAttending` | Optional boolean. `true` is only allowed when the guest's `plusOneAllowed` is true. Always stored as `false` when `attending` is false |

Any other field in the body (including `dietaryNotes`) is ignored: the guest's `dietaryNotes` belongs to organizers and an RSVP never changes it.

Guests can change their answer any number of times until the deadline. The save is a DynamoDB transaction that also checks the event's RSVPs are still open, so an answer can't slip in after closing.

## 3. RSVP links

```
https://<app>/rsvp/<eventId>.<guestId>.<signature>
signature = base64url(HMAC-SHA256(RSVP_LINK_SECRET, "eventwise-rsvp:<eventId>:<guestId>"))
```

- The signature covers both IDs, so one guest's link can't read or change another guest, or a guest of another event.
- Nothing is stored per link and no index is needed: the IDs are the guest table key.
- A deleted guest's link stops working. Rotating `RSVP_LINK_SECRET` breaks every link already sent.
- Invalid, tampered or other-event links, deleted guests, and events without RSVP settings all return the same `404`, so links can't be probed.
- Links don't expire on their own; after the deadline they show the guest's answer read-only.
- Responses include `Referrer-Policy: no-referrer`, and the page fetches with `referrerPolicy: "no-referrer"`, so the token never leaks to other sites.

## 4. Reminders and closing

`POST …/invitations` starts one Step Functions execution with `{ eventId, workflowId, reminderAt, deadline }`:

1. **WaitForReminder** until `reminderAt` (skipped when null).
2. **SendReminders**: the deadline Lambda (`action: "REMIND"`) emails each guest who is still `PENDING`, has an email and has never been reminded. Before queueing, it sets `reminderSentAt` on the guest with a condition (`rsvpStatus = PENDING AND attribute_not_exists(reminderSentAt)`), so a guest is reminded **at most once**, even if the step is retried or invitations are re-sent. A reminder that couldn't be queued is released and the step fails, and Step Functions retries only those.
3. **WaitForDeadline** until `deadline`.
4. **CloseRsvps** (`action: "CLOSE"`) sets the settings' `status` to `CLOSED`.

Re-sending invitations stores a new `workflowId`, starts a new execution and stops the old one. Every step first checks that its `workflowId` is still current, so an old execution that wasn't stopped does nothing.

## 5. Errors

Same `ApiError` shape as the other APIs:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Check the highlighted fields.", "fields": { "deadline": "The RSVP deadline must be in the future." } } }
```

| Status | `code` | When |
| --- | --- | --- |
| 400 | `BAD_REQUEST` | Malformed JSON or not an object |
| 401 | `UNAUTHENTICATED` | Organizer route without valid Cognito access-token claims, or the Event API rejected the token |
| 403 | `FORBIDDEN` | Not a member of the event (also for an invalid or missing event ID) |
| 404 | `NOT_FOUND` | Invalid RSVP link, deleted guest, no RSVP settings yet, or unknown `guestId` on the links route |
| 405 | `METHOD_NOT_ALLOWED` | Wrong method for the resource (`Allow` header lists the right ones) |
| 409 | `RSVP_CLOSED` | Answer sent after the deadline or after the workflow closed RSVPs |
| 413 | `PAYLOAD_TOO_LARGE` | Body over 16 KiB |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Write body without `Content-Type: application/json` |
| 422 | `VALIDATION_ERROR` | A field breaks the rules above (`fields` names it) |
| 502 | `UPSTREAM_ERROR` | The Event API couldn't be reached |
| 502 | `SCHEDULING_FAILED` | The workflow couldn't start; no invitations were sent |
| 500 | `INTERNAL_ERROR` | Anything unexpected, including a missing setting (the log names the setting, never its value) |

## 6. Emails

One SQS message per guest (`backend/rsvp-service/notifications/messages.ts`): `type` (`RSVP_INVITATION` or `RSVP_REMINDER`), `to`, `guestName`, `eventName`, `eventDate`, `startTime`, `venue`, `deadline`, `message` and `rsvpUrl`. The sender rejects messages that don't match (they go to the DLQ) and only accepts `rsvpUrl`s on `/rsvp/` paths. The deadline is shown in Vancouver time. Logs contain counts and message IDs only, never addresses or links.

## 7. Headcount

An accepted guest who says their plus-one isn't coming now counts as 1 **Accepted** and 1 **Rejected** on the Guests page and the dashboard. Every other plus-one follows the guest's answer. The status counts still add up to the planned headcount (`backend/guest-service/services/guestSummary.ts`, `frontend/organizer/src/features/guests/guestHeadcount.ts`).
