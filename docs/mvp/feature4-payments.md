# Feature 4 commit 5: deposits, payments and history

Commit: `feat(expenses): record deposits and payments transactionally`
Branch: `feature4-expense-tracking`. Requires commits 1-4; uses existing MySQL tables.

## Routes

Both routes require the same verified Cognito identity and event membership as expense CRUD.

| Method | Path | Success |
| --- | --- | --- |
| GET | /events/{eventId}/expenses/{expenseId}/payments | 200 paginated history |
| POST | /events/{eventId}/expenses/{expenseId}/payments | 201 recorded payment + updated expense |

Example POST body:

```json
{
  "amount": "200.00",
  "paidAt": "2026-11-11",
  "paymentType": "DEPOSIT",
  "notes": "Initial deposit"
}
```

Required: amount and paidAt. paymentType defaults to PAYMENT; notes defaults to null. The date records an already-made payment, not a scheduled payment. Dates cannot be later than the server's UTC today.

Amount must be a positive decimal string with exactly two fractional digits and fit DECIMAL(12,2). Reject numeric JSON, zero/negative amounts, excessive precision, future/impossible dates, unsupported types, unknown fields and notes over 255 characters with 422. Incoming payment type may only be DEPOSIT or PAYMENT; creating refunds or editing/deleting individual payments remains outside this MVP.

Successful POST returns `{"data":{"payment":{...},"expense":{...}}}`. Payment fields: paymentId, expenseId, amount, paidAt, paymentType, notes, createdAt. The expense uses the commit 1/4 response shape with freshly calculated paidTotal, outstandingAmount, paymentStatus and isOverdue. Recording a payment updates expense.updatedAt and does not increase committedAmount.

GET accepts only limit (default 50, range 1-100) and offset (default 0, nonnegative safe integer). Unknown/repeated query parameters are rejected. It returns `{"data":[],"total":0,"limit":50,"offset":0}`. Sort order is paidAt descending, then paymentId numerically descending. Existing REFUND rows appear with a positive amount and paymentType REFUND; they subtract from net paid. A valid expense with no history returns an empty list; a missing/cross-event expense returns 404 after membership checks.

POST accepts no query parameters. Unsupported methods return 405 with Allow: GET, POST. Authentication and error envelopes are unchanged from commit 4. Missing identity returns 401; no event membership returns 403. Overpayment returns 409 / PAYMENT_EXCEEDS_BALANCE, including any positive payment on an already-paid or zero-value expense.

## Transaction guarantees

1. Verify event membership inside the database transaction.
2. Lock the parent expense with SELECT FOR UPDATE, scoped to event and expense IDs.
3. Read net payments after acquiring the lock and validate the financial invariant.
4. Validate input and reject amounts greater than outstanding.
5. Insert the payment, refresh expense.updatedAt, calculate the response, and commit together.

Expense edits/deletes from commit 4 use the same parent lock. Concurrent writers therefore cannot validate against the same stale balance. READ COMMITTED lets a waiting writer see payments committed by the preceding writer once it obtains the lock. Failure rolls back the insert and timestamp update. History reads also lock the parent to stabilize count/page reads against supported payment writers and deletions.

All future refund/payment writers must follow this locking discipline. Direct SQL writes outside the service are not covered by the API's concurrency guarantee.

Payment submission is NOT persistently idempotent: the schema has no idempotency-key store. Do not automatically retry a payment after a timeout/uncertain network result. Fetch history first to determine whether it committed. Disable the submit button while a request is in progress. Repeated valid requests within the remaining balance represent distinct payments.

## Apply and test

Extract the commit 5 archive at the repository root on feature4-expense-tracking. It updates feature code/tests and package scripts; it adds no dependencies and does not replace .env, the authentication adapter, database connection helpers or fixture seeds.

```bash
npm --prefix backend run typecheck
npm --prefix backend test
```

Expected default suite after commit 6: **29 passing tests** (23 at commit 5). No MySQL or real Cognito account is required for the default suite. It checks validation, payment math, history, access control, rollback behavior with an in-memory repository, and HTTP responses. This does not independently prove real database transactions.

Keep Node aligned with the declared repository requirement: >=22.12.0. Passing tests on Node 20 does not remove the npm engine warning or establish full project support for that version. No engine requirement is changed in this commit.

## Real MySQL regression and concurrency checks

Your successful commit 4 connection and existing commit 3 fixtures can be reused; do not reseed just to run these checks. Start Docker Desktop if necessary. Run one command at a time:

```bash
npm --prefix backend run db:up
npm --prefix backend run db:check
npm --prefix backend run test:db
npm --prefix backend run test:payments:db
node scripts/verify-expense-seed.mjs
```

The new command requires DB_CONNECTION_LIMIT >= 2 (default 5), so concurrent requests can obtain separate connections. Use the disposable local database configured in .env, not RDS/production. Fake fixture subjects are passed directly to the service; this is SQL authorization verification, not a Cognito end-to-end test.

The payment check verifies:

- Deposit + final payment, unchanged commitment and derived paid status.
- Payment history pagination and tie-breaking by numeric ID.
- Existing refund subtraction without modifying the refund fixture.
- Cross-event/nonmember rejection and zero-commitment protection.
- Exact 0.10 + 0.20 arithmetic.
- Real rollback after deliberately failing a transaction after payment insertion.
- Five races with two 60.00 payments against a 100.00 expense: exactly one succeeds, one returns PAYMENT_EXCEEDS_BALANCE, and only one payment persists.
- A race between an 80.00 payment and reduction to 50.00: exactly one succeeds, and the final commitment is never below net paid.

It creates temporary expenses/payments under reserved event 400 and cleans up only generated expense IDs from that run, including their payments. A force-terminated process can leave temporary rows; do not run it concurrently with fixture reseeding. Normal completion prints:

```text
All MySQL payment integration checks passed; temporary expenses cleaned up.
```

The final fixture verification should still print 17 PASS results. The concurrency script was prepared/typechecked but not executed against MySQL in the preparation environment; record your actual local result before marking the task complete.

If your fixtures are absent, load 03_expenses_seed.sql using the commit 3 instructions first. That seed resets reserved events 400/401, so do not run it against manually maintained data under those IDs.

## Integration boundary

Commit 6 now exposes category/event aggregates (see [summary checks](feature4-summary.md)); payment writes also supply updated per-expense totals. Payment UI/history and summary refresh remain commits 7-8. Cognito configuration and real event memberships remain shared dependencies from commit 4. Lambda deployment remains commit 9.

Trello: Implement deposit and payment recording. Record the automated and real MySQL results, link the commit/PR, and follow the team's review/merge requirement before moving to Done.
