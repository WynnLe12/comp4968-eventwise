# Event Dashboard API (Feature 10)

Status: **agreed** with Wynn (F2, Events Lambda) and Heather (F12). Owner: Khai.

One summary per event: budget vs. actual spending by category, upcoming payments,
guest RSVP counts and headcount, and task progress (proposal Feature 10).

## Route

| Method | Path | Success |
| --- | --- | --- |
| GET | `/events/{eventId}/dashboard` | 200, dashboard object |

- Runs in the **Events Lambda** (`eventwise-events`), because it reads RDS (budget,
  expenses, tasks) and DynamoDB (guests). No new AWS service is needed: the Lambda
  already has the DynamoDB gateway endpoint and `dynamodb:Query` on `EventWise_Guests`.
- Auth: `Authorization: Bearer <access token>`, same Cognito authorizer and scope as the
  other Events methods. OPTIONS stays unauthenticated (CORS preflight).
- Access: OWNER and CO_PLANNER of the event. Read-only, no request body.
- IDs and money are strings (money as decimal strings like `"1500.00"`), counts are integers.

## Response

```json
{
  "eventId": "11",
  "asOfDate": "2026-11-24",
  "budget": {
    "eventBudget": "20000.00",
    "allocatedBudget": "18000.00",
    "committedTotal": "9500.00",
    "paidTotal": "4000.00",
    "outstandingTotal": "5500.00",
    "remainingBudget": "10500.00",
    "isOverBudget": false,
    "categories": [
      {
        "categoryId": "3",
        "categoryName": "Photography",
        "plannedAmount": "3000.00",
        "committedTotal": "2500.00",
        "paidTotal": "1000.00",
        "remainingBudget": "500.00",
        "isOverBudget": false
      }
    ]
  },
  "payments": {
    "windowDays": 7,
    "overdueTotal": "800.00",
    "overdueCount": 1,
    "upcomingTotal": "1500.00",
    "upcomingCount": 2,
    "items": [
      {
        "expenseId": "7",
        "description": "Photographer deposit",
        "vendorName": "Lens Studio",
        "categoryName": "Photography",
        "dueDate": "2026-11-20",
        "outstandingAmount": "800.00",
        "isOverdue": true
      }
    ]
  },
  "guests": {
    "records": 12,
    "plusOnes": 4,
    "expectedHeadcount": 16,
    "rsvp": { "UNINVITED": 2, "PENDING": 7, "ACCEPTED": 5, "REJECTED": 2 }
  },
  "tasks": {
    "total": 10,
    "completed": 6,
    "overdue": 1,
    "percentComplete": 60,
    "nextDue": [
      { "taskId": "21", "title": "Confirm florist", "dueDate": "2026-11-26", "assigneeName": "Heather" }
    ]
  },
  "unavailable": []
}
```

### Field rules

**Budget** reuses the expense summary (`GET /events/{eventId}/expenses/summary`, see
`expenses.md` section 6), so both pages always show the same numbers.
"Actual spending" is shown two ways: `committedTotal` (amounts agreed, e.g. a signed
contract) and `paidTotal` (net deposits + payments − refunds). Categories keep the
budget page order.

**Payments** list expenses with a positive outstanding balance (committed − net paid):
- overdue: `dueDate` before `asOfDate` (due today is not overdue);
- upcoming: `dueDate` from `asOfDate` to `asOfDate + 7 days`;
- expenses without a due date are not listed.

The 7-day window and the UTC date are shared with Feature 9 (payment alerts), so a
payment that triggers an alert email is the same one shown as upcoming here.

`items` holds at most 5 entries: overdue first, then the nearest due dates.
`asOfDate` is the UTC date, the same rule as the Expenses page.

**Guests** come from DynamoDB `EventWise_Guests` (all items with this `eventId`):
`records` = guest entries, `plusOnes` = entries with `plusOneAllowed: true`,
`expectedHeadcount` = records + plusOnes (planned headcount, independent of RSVP,
same as the Guests page total). `rsvp` counts **people** per stored status: a guest with
a plus-one counts as 2, so the four counts always add up to `expectedHeadcount`. The
plus-one is assumed to follow the guest's answer until Feature 8 records whether the
plus-one is coming. The Dashboard shows `rsvp.ACCEPTED / expectedHeadcount`.

**Tasks** come from RDS `tasks` (Feature 12): `overdue` = not completed and `dueDate`
before `asOfDate`; `percentComplete` = round(completed / total × 100), `0` when there
are no tasks. `nextDue` = up to 5 open tasks with a due date, nearest first.

**`unavailable`**: if guests (DynamoDB) cannot be read, the response is still 200,
`guests` is `null` and `unavailable` contains `"guests"`. The budget, payments and tasks
sections come from one database and either all load or the request fails with 500.

## Errors

Same style as the other Events Lambda routes: `{ "error": "message" }`.

| Status | When |
| --- | --- |
| 400 | Invalid `eventId` |
| 401 | Missing or invalid token |
| 403 | Caller is not a member of the event |
| 404 | Event does not exist |
| 500 | Unexpected failure |

## Decisions

- Upcoming payments window: **7 days**, same as F9 payment alerts.
- "Today" is the **UTC** date, same as the Expenses page, expense summary and F9.
- The route lives in `eventwise-events` (API Gateway resource `/events/{eventId}/dashboard`,
  GET with the Cognito authorizer and scope, OPTIONS without auth).
- Task progress reads the F12 `tasks` table directly (`is_completed`, `due_date`,
  `assigned_member_id`). Assignee names use `event_members.display_name`, like the
  Planning Team page. A task whose assignee was removed has `assigneeName: null`.
- RSVP counts use the statuses stored by the guest API: `UNINVITED`, `PENDING`,
  `ACCEPTED`, `REJECTED`. Feature 8 tells Khai before changing them.
- RSVP counts are in **people** (plus-ones included), the same rule as the Guests page
  cards, so every count adds up to the total. Agreed with Hei.

## Code

| Layer | File |
| --- | --- |
| Lambda route | `backend/event-service/lambda/events.ts` (dispatches `/events/{eventId}/dashboard`) |
| Handler | `backend/event-service/handlers/dashboardHandler.ts` |
| Service | `backend/event-service/services/dashboardService.ts` |
| RDS queries | `backend/event-service/repositories/dashboardRepository.ts` |
| Guests (DynamoDB) | `backend/guest-service/services/guestSummary.ts` |
| Frontend | `frontend/organizer/src/features/dashboard/` (`dashboardApi.ts`, `Dashboard.tsx`) |

Tests: `backend/tests/dashboard*.ts`, `backend/tests/guests/guestSummary.test.ts`,
`frontend/organizer/scripts/dashboard*.test.mjs`. The MySQL tests run with
`EVENTWISE_MYSQL_TEST=1` against a disposable local database.

## Deployment

The route ships inside `eventwise-events`. No new AWS service, environment variable or
IAM permission is needed:

- **DynamoDB:** guests are read with `dynamodb:Query`, already allowed by the inline policy
  `EventWiseEventsGuestCleanup` on `EventWise_Guests`, through the existing gateway
  endpoint `eventwise-dynamodb-endpoint`. Uses the existing `GUESTS_TABLE_NAME`.
- **RDS:** the application account needs `SELECT` on `events`, `event_members`,
  `budget_categories`, `expenses`, `expense_payments`, `vendors` and `tasks`. These are
  already read by the Events, Expenses and member routes.
- **Timeout:** if DynamoDB is unreachable, the AWS SDK retries before giving up. Keep the
  Lambda timeout at **15 seconds or more** so the rest of the dashboard still returns with
  `guests: null` instead of the whole request timing out.

### Steps

`eventwise-events` is shared by several features: always build it from up-to-date `dev`
and tell the team before uploading, or newer routes from other people can disappear.

1. Merge the dashboard PR into `dev`, then `git checkout dev && git pull`.
2. Build: `cd backend && npm run package:events` (creates `backend/build/eventwise-events.zip`).
3. Lambda → `eventwise-events` → **Upload from** `.zip file` → the zip above. Check the
   timeout under Configuration → General configuration.
4. API Gateway → `eventwise` → Resources → select `/events/{eventId}` → **Create resource**
   `dashboard`.
5. On `/events/{eventId}/dashboard` create **GET**: Lambda proxy integration →
   `eventwise-events`. In Method request set the existing Cognito authorizer and the scope
   `aws.cognito.signin.user.admin` (same as the other Events methods).
6. Create **OPTIONS** with **Authorization: NONE** (CORS preflight never sends a token),
   configured like the OPTIONS of `/events/{eventId}/members`.
7. **Deploy API** to the `prod` stage.

### Check after deploying

- Owner and co-planner of an event: Dashboard page loads (200).
- Another account: 403. A deleted event: 404.
- Numbers match the Budget, Expenses, Guests and Tasks pages for the same event.
- Older routes still work (event list, event detail, members, delete event).
- CloudWatch `/aws/lambda/eventwise-events`: no `Event dashboard failed` errors.
