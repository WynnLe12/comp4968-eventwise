# Feature 4 commit 4: event-scoped expense CRUD

Commit: `feat(expenses): add event-scoped CRUD with access checks`
Branch: `feature4-expense-tracking`; based on commits 1-3.

## Implemented

| Method | Path | Success |
| --- | --- | --- |
| GET | /events/{eventId}/expenses | 200 list + total/limit/offset |
| POST | /events/{eventId}/expenses | 201 expense + Location header |
| GET | /events/{eventId}/expenses/{expenseId} | 200 expense |
| PATCH | /events/{eventId}/expenses/{expenseId} | 200 updated expense |
| DELETE | /events/{eventId}/expenses/{expenseId} | 204 without body |

List filters: categoryId, vendorId, paymentStatus, overdue, q, limit and offset. Only the list endpoint accepts query parameters. Search matches literal text, including percent/underscore characters. Results sort by expense ID descending. Repeated or unknown query keys are rejected.

Money and BIGINT IDs use strings. Financial calculations use integer cents with BigInt. The repository uses parameterized SQL, event-scoped lookups, membership checks and transactions. Payment rows are pre-aggregated to avoid duplicating commitments. Existing refund rows reduce net paid. Writes validate category/vendor membership, and updates cannot lower commitment below net paid.

Membership rows and association rows are held with shared locks; expense mutation locks the expense row. Commit 5's payment writers must acquire the same parent expense lock before calculating/updating payments. Delete cascades to payment rows under the existing schema. Database errors do not disclose SQL or credentials in API responses.

The current transaction isolation is READ COMMITTED. Count/list reads are scoped to the same event but are not a frozen pagination snapshot across concurrent changes. Refresh if records change during paging.

The local HTTP server reuses the feature service. Lambda packaging is still commit 9. Payment-write/history endpoints are commit 5; category/event summaries are commit 6. `/expenses/summary` is reserved and currently returns 404. Frontend integration is later; this commit does not change the expense screen.

## Apply and install

Extract the commit 4 archive at the repository root. It updates package files, server.ts, README.md and .env.example and adds feature code/tests/docs. Preserve any teammate changes when replacing shared files. It does not replace .env, db/check.ts, pool.ts or the existing fixtures.

```bash
npm --prefix backend ci
npm --prefix backend run typecheck
npm --prefix backend test
```

The corrected test command remains `npm run build && cd dist && node --test`.
Expected default result: 15 passing tests. No MySQL or real Cognito account is required for this default suite. Service tests use an in-memory repository; HTTP tests inject an authenticator inside test code. This proves behavior at those boundaries, not live RDS/Cognito integration.

## MySQL check (run separately)

Fix any existing db:check connection failure before this step. Start Docker Desktop and use your disposable local database configured in .env:

```bash
npm --prefix backend run db:up
npm --prefix backend run db:check
npm --prefix backend run db:seed -- 03_expenses_seed.sql
node scripts/verify-expense-seed.mjs
npm --prefix backend run test:db
```

Run one command at a time; stop if a command fails. Loading 03 resets only reserved fixture events 400/401 and their records; it is unnecessary if you already have the unchanged fixtures loaded. The integration check inserts a temporary expense and payment under event 400, checks CRUD, filtering, exact amounts, forbidden cross-event references, reductions below paid and payment cascade deletion, then cleans up its temporary expense. It does not reset demo events 1/2. Run it against disposable local data only, never production.

Expected final integration message:

```text
MySQL expense CRUD checks passed (including access, associations, filters, precision and payment cascade).
```

This check passes known fixture identities directly to the service. It verifies SQL membership enforcement, not Cognito sign-in. MySQL integration must be run on the developer machine; it was not run in the preparation environment because Docker/MySQL was unavailable.

## Real local API authentication

Coordinate with the shared security owner before configuring these existing Cognito resources in repository-root .env:

```dotenv
COGNITO_USER_POOL_ID=your_actual_user_pool_id
COGNITO_CLIENT_ID=your_actual_app_client_id
```

Do not paste the placeholders literally. No AWS resource is created by this commit. `aws-jwt-verify` checks access-token signatures, expiry, issuer/user pool, client ID and token use. The local server fetches the pool's signing keys, so it needs network access to Cognito. The local adapter can be replaced with the team's shared verified-identity adapter once available.

The token's real sub must have an OWNER or CO_PLANNER row in event_members for the requested event. Commit 3's fake subs are not real Cognito accounts and cannot be used for browser login. Have the event/security owner provision a real test membership rather than weakening authentication or using a request header as identity.

Responses: missing/invalid bearer token -> 401; bearer token supplied but Cognito configuration absent -> 503; valid principal without event membership -> 403; expense absent within an authorized event -> 404. No authorization bypass is enabled by NODE_ENV or any request header.

Start the server:

```bash
npm --prefix backend run dev
```

An unauthenticated request should fail closed even before database access:

```bash
curl -i http://127.0.0.1:3000/events/400/expenses
```

Expected: HTTP 401. Successful manual API calls require an actual access token and corresponding database membership. Do not commit or share access tokens.

Example JSON POST body (choose IDs from the authorized event):

```json
{
  "categoryId": "4001",
  "vendorId": null,
  "description": "Example expense",
  "committedAmount": "25.00",
  "dueDate": "2027-01-15"
}
```

## Review checklist

- [ ] Default 15 tests, typecheck and build pass.
- [ ] db:check succeeds locally.
- [ ] Commit 3 fixture verification succeeds.
- [ ] MySQL CRUD integration check passes locally.
- [ ] Shared security owner agrees on verified-identity integration.
- [ ] Real Cognito + membership smoke test completed when that shared dependency is ready.
- [ ] PR references the Feature 4 card and describes remaining frontend/cloud dependencies.

Keep the task In-Progress until its required integration checks and team review are complete. A green mocked test suite does not mean the deployed feature is finished.
