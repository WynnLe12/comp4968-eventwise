# Events API

`POST /events`, `GET /events`, `GET /events/:eventId`, and `PATCH /events/:eventId` are implemented. Existing health and auth routes are preserved.

The handler verifies a Cognito **access** token using the shared verifier. The service validates input; the repository owns parameterized SQL and a transaction containing both inserts. Ownership always comes from the verified token's `sub`.

## Local testing

1. Start the existing Docker database with `npm run db:up` from `backend`. Do not reset an existing database; the schema must already be initialized.
2. Set the existing backend `.env` values: `DB_HOST=127.0.0.1`, `DB_PORT=3307`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `COGNITO_USER_POOL_ID`, and `COGNITO_CLIENT_ID`. Use the credentials configured by your Docker Compose setup and the same Cognito pool/client as the frontend.
3. Run `npm run dev`. Obtain a current access token by signing in through the frontend. Set `$env:ACCESS_TOKEN` locally to that access token; do not commit or share tokens.
4. In PowerShell:

```powershell
$body = @{
  name = 'EventWise test event'
  template_id = $null
  event_date = '2028-02-29'
  venue = 'Garden'
  total_budget = '12500.50'
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3000/events' -Headers @{ Authorization = "Bearer $env:ACCESS_TOKEN" } -ContentType 'application/json' -Body $body
```

Expect HTTP 201 and the created event directly, including `event_id`, timestamps, and the five input fields. IDs and budgets are returned as strings to preserve SQL precision; `event_date` remains `YYYY-MM-DD`. In MySQL, check `events` and `event_members` using the returned ID: exactly one membership should have your verified Cognito sub and role `OWNER`.

Only `name` is required. `template_id`, `event_date`, and `venue` default to null; `total_budget` defaults to zero. A provided template must exist. Name/venue limits are 150/255 characters. Budget accepts a number or decimal string, between 0 and 9999999999.99, with at most two fractional digits. Dates must be real calendar dates between years 1000 and 9999. Unknown fields, including identity and ownership fields, are rejected.

Check negative cases: omit the Authorization header, use an invalid/expired token (401), supply an empty name or negative budget (400), supply a nonexistent template (400), malformed JSON (400), or a non-JSON content type (415). Oversized bodies return 413. Unexpected database failures return a generic 500 and roll back the transaction. DELETE routes remain unimplemented.

## List events

With the same local setup and a valid Cognito access token:

```powershell
Invoke-RestMethod -Method Get -Uri 'http://127.0.0.1:3000/events' -Headers @{ Authorization = "Bearer $env:ACCESS_TOKEN" } | ConvertTo-Json -Depth 5
```

Expect HTTP 200 with a direct array of event objects, each containing your `role` (`OWNER` or `CO_PLANNER`). Only your memberships are returned; identity query parameters are ignored. Dates and amounts use the same representation as creation. Events sort by date ascending, undated events last, then event ID for ties. No memberships returns `[]`.

To test isolation, create separate events while signed in as two different users, then list using each user's access token. Each must see only their own memberships. A co-planner membership added to an existing event should expose that event with `CO_PLANNER` to that user and `OWNER` to its owner. Missing/invalid/expired access tokens return 401; database failures return a generic 500. Only owners can edit through PATCH.

## Get event by ID

Use an event ID returned by creation or listing, keeping it as a string:

```powershell
$eventId = '42'
Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:3000/events/$eventId" -Headers @{ Authorization = "Bearer $env:ACCESS_TOKEN" }
```

Expect HTTP 200 with a single event object and your `role` (`OWNER` or `CO_PLANNER`). Response fields and string representations match listing. No other user's membership fields are included. User IDs in query parameters or the body cannot grant access.

Verify with an owner's token and a co-planner's token (200), then an unrelated user's token for that same event (403). Use a confirmed nonexistent event ID for 404. IDs must be positive decimal integers up to `18446744073709551615`; invalid IDs such as `0`, `-1`, `1.5`, or `18446744073709551616` return 400. Leading zeros are normalized. Missing/invalid/expired tokens return 401 before ID validation, and unexpected database failures return a generic 500. DELETE remains unimplemented.

## Update event

Using the owner's Cognito access token and an existing event ID:

```powershell
$eventId = '42'
$patch = @{ name = 'Updated event'; venue = $null; total_budget = '25000.00' } | ConvertTo-Json
Invoke-RestMethod -Method Patch -Uri "http://127.0.0.1:3000/events/$eventId" -Headers @{ Authorization = "Bearer $env:ACCESS_TOKEN" } -ContentType 'application/json' -Body $patch
```

Expect HTTP 200 with the updated event and role `OWNER`. Only supplied fields change. Supported fields are `name`, `template_id`, `event_date`, `venue`, and `total_budget`, with the same schema limits as creation. Explicit null is allowed only for template, date, and venue. Any supplied non-null template must exist. Timestamps are managed by MySQL; clients cannot set them.

Verify GET after PATCH to confirm omitted values are preserved. A co-planner or unrelated user's token returns 403 and leaves the event unchanged. A nonexistent event returns 404. Empty bodies/objects, unknown or protected properties, invalid IDs/dates/budgets, and nonexistent templates return 400; missing/invalid/expired tokens return 401. Non-JSON requests return 415 and oversized bodies return 413. Database failures return a generic 500 and roll back the update. The event and requesting membership remain locked from authorization through commit. No ownership or membership changes are supported.

## Automated tests

```powershell
npm run typecheck
npm run build
npm test
```

The default suite mocks successful token verification and database connections; it also checks invalid JWTs using the existing verifier. Public fixture pool/client IDs allow tests without real Cognito credentials. MySQL integration tests are opt-in and create uniquely named test events, cleaning up successful inserts:

```powershell
$env:EVENTWISE_MYSQL_TEST = '1'
node --env-file=.env --test dist/tests/createEvent.mysql.test.js dist/tests/listEvents.mysql.test.js dist/tests/getEvent.mysql.test.js dist/tests/updateEvent.mysql.test.js
Remove-Item Env:EVENTWISE_MYSQL_TEST
```

These confirm creation, rollback after a membership constraint failure, listing isolation and roles for two users with private and shared events, and detail access for owners/co-planners versus unrelated users or nonexistent events. Update tests also verify partial writes, owner permissions, nullable fields, template validation, and rollback after a write. No schema changes or AWS infrastructure are needed.
