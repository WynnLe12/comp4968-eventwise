# Feature 4: Expense API and payment rules

Status: proposed implementation contract for team review; endpoints are not implemented by this documentation commit.
Branch: `feature4-expense-tracking` (based on `dev`).
Scope: expense CRUD, deposit/payment recording, payment history, and category/event spending summaries.

## 1. Existing architecture and data

The current backend is a TypeScript native Node HTTP scaffold, not Express. `backend/server.ts` serves local development; the planned cloud runtime is API Gateway + Lambda. Keep business logic in `backend/expense-service/` and reuse it through local and Lambda adapters. Service directories are logical modules, not a requirement for separate deployments. Follow the shared Event API deployment boundary for RDS access.

Reuse these existing MySQL tables and view:

- `events` and `event_members`: event ownership and membership.
- `budget_categories`: category allocation and planned amount.
- `vendors`: optional expense association.
- `expenses`: description, committed amount, category, vendor and due date.
- `expense_payments`: deposits, payments and existing refunds.
- `vendor_payment_totals`: net paid totals and next unpaid due date per vendor.

No schema change is required by this commit. Existing composite foreign keys prevent expenses from referencing categories/vendors in another event. API validation must also enforce these relationships and return readable errors.

## 2. Proposed MVP policies

These policies establish a working contract; they are not evidence of prior team approval. Confirm them with the relevant owners before implementing dependent behavior.

| Topic | Proposed policy |
| --- | --- |
| Currency | Single currency per application/demo, no conversion. Confirm currency with team; do not infer it from a dollar sign. |
| Vendor | Optional, consistent with the current nullable column and vendorless seed expense. |
| Expense amount | Nonnegative, including zero, consistent with the current database constraint. |
| Payment amount | Strictly positive; cannot exceed outstanding balance. |
| Payment status | Derived from committed amount and net paid; never manually writable. |
| Due date | Optional date for the expense obligation, not a date on each recorded payment. Separate scheduled installments require separate expense obligations whose totals do not duplicate a full contract expense. |
| Expense edits | Reject a committed amount below net paid. Existing payment history remains associated with the expense. |
| Expense deletion | Explicit confirmation in UI; only expenses without payment or refund history can be deleted. Reject expenses with history with 409 HAS_PAYMENTS, even when fully paid or fully refunded. |
| Refunds | Include existing REFUND rows in all calculations/history. Creating, editing, or deleting payment/refund records is outside this MVP, except recording a new DEPOSIT or PAYMENT. |
| Actual spending | Avoid an ambiguous `actual` field. Expose committed and paid separately. Budget remaining/overrun uses committed expenses. |
| Calendar boundaries | Proposed MVP uses UTC today for overdue/month calculations, matching local DB configuration. Confirm before release if event-local dates are needed. |

Receipt uploads, automated alerts, contract extraction and the full dashboard belong to separate features.

## 3. Authentication and event access

All routes require an authenticated principal. Cloud requests use the agreed Cognito/API Gateway authorizer; handlers consume verified identity, not a user ID supplied in request JSON or an unverified header. A bearer token must be verified by the trusted boundary; merely decoding a JWT is insufficient.

For every request:

1. Validate path and query syntax.
2. Obtain the verified Cognito `sub`; missing/invalid authentication returns 401.
3. Check `(event_id, cognito_sub)` in `event_members`; OWNER and CO_PLANNER may use these expense routes. A missing membership returns 403, including an unknown event, without revealing event existence.
4. Scope every expense lookup/mutation to both event ID and expense ID. An expense not found within an authorized event returns 404.
5. Validate category and non-null vendor IDs against the authorized event before writing. Return 422 for invalid associations without revealing another event's records.

Shared authentication belongs to the security integration. Inject test principals in tests; do not ship a production identity-header bypass. The current simulated frontend sign-in is not authentication. Local protected HTTP routes need the agreed verified-identity adapter before browser integration is considered complete.

## 4. Wire conventions

- Base URL is environment configuration. Route paths below omit deployment/stage prefixes.
- JSON request/response bodies use camelCase. Write requests require `Content-Type: application/json`.
- IDs are positive decimal strings to preserve MySQL BIGINT precision; never convert arbitrary IDs through JavaScript Number.
- Money is a decimal string with exactly two fractional digits, e.g. `"1000.00"`. Reject numeric JSON amounts, exponent notation, commas, currency symbols and extra decimal places.
- Stored monetary inputs fit DECIMAL(12,2): maximum `"9999999999.99"`. Aggregate output may exceed that per-row limit and remaining budget may be negative.
- Use exact decimal arithmetic or integer cents with sufficient range internally, not binary floating-point accumulation. Return all monetary outputs as decimal strings.
- Dates are valid calendar dates in `YYYY-MM-DD`; reject impossible dates. Timestamps are UTC ISO 8601 strings.
- Reject unknown writable fields, including eventId, paidTotal and paymentStatus in expense bodies.
- PATCH omission means unchanged; explicit null clears only nullable fields. Empty PATCH returns 422.
- Proposed maximum JSON body is 16 KiB; larger bodies return 413.

## 5. Routes

| Method | Path | Result |
| --- | --- | --- |
| GET | `/events/{eventId}/expenses` | 200 paginated expense list |
| POST | `/events/{eventId}/expenses` | 201 created expense |
| GET | `/events/{eventId}/expenses/summary` | 200 event and category totals |
| GET | `/events/{eventId}/expenses/{expenseId}` | 200 expense |
| PATCH | `/events/{eventId}/expenses/{expenseId}` | 200 updated expense |
| DELETE | `/events/{eventId}/expenses/{expenseId}` | 204, no body |
| GET | `/events/{eventId}/expenses/{expenseId}/payments` | 200 paginated payment history |
| POST | `/events/{eventId}/expenses/{expenseId}/payments` | 201 recorded payment and updated expense |

Match the literal `summary` route before parsing an expense ID. Known routes with unsupported methods return 405 with an Allow header; unknown routes return 404.

### List queries

Expense filters: `categoryId`, `vendorId`, `paymentStatus` (`UNPAID`, `PARTIALLY_PAID`, `PAID`), `overdue` (`true` or `false`), and `q` (trimmed text, at most 100 characters, literal case-insensitive substring in expense description or vendor name).

Pagination: `limit` integer 1-100 (default 50), `offset` nonnegative integer (default 0). Expense order: expense ID descending. Payment history accepts only limit/offset and sorts by paidAt descending, then payment ID descending. Reject unknown query keys and invalid values with 422. Filter combinations use AND. Unknown/nonmatching category/vendor filters return an empty list, never another event's records.

List envelope: `{"data": [], "total": 0, "limit": 50, "offset": 0}`. Total is the matching row count before pagination. Summary totals are for the entire event, independent of list filters/pages.

### Create an expense

`POST /events/1/expenses`

```json
{
  "categoryId": "2",
  "vendorId": "2",
  "description": "Photography package",
  "committedAmount": "1000.00",
  "dueDate": "2027-08-01"
}
```

Required: categoryId, description (trimmed, 1-255 characters), committedAmount. Optional vendorId and dueDate default to null. Category is a budget category ID, not the vendor's free-text category label. Expense notes are not accepted because the current expense table has no notes column.

201 response shape (illustrative IDs/timestamps, not a live result):

```json
{
  "data": {
    "expenseId": "10",
    "eventId": "1",
    "categoryId": "2",
    "categoryName": "Photo & Video",
    "vendorId": "2",
    "vendorName": "Lumen Photography",
    "description": "Photography package",
    "committedAmount": "1000.00",
    "paidTotal": "0.00",
    "outstandingAmount": "1000.00",
    "dueDate": "2027-08-01",
    "paymentStatus": "UNPAID",
    "isOverdue": false,
    "createdAt": "2026-11-11T21:00:00Z",
    "updatedAt": "2026-11-11T21:00:00Z"
  }
}
```

GET/PATCH use the same single-resource envelope. List data contains objects of this shape. A vendorless expense has null vendorId/vendorName.

### Edit/delete an expense

PATCH accepts any nonempty subset of categoryId, vendorId, description, committedAmount and dueDate with the create validation rules. categoryId, description and committedAmount cannot be null. Reject amount below net paid with 409. Revalidate all changed associations in the same event.

DELETE locks the authorized expense and checks for any payment or refund rows in the same transaction. If any exist, return 409 HAS_PAYMENTS and preserve the expense and all history, regardless of the remaining balance or net paid amount. Otherwise delete the expense and return 204 with no body. A repeated DELETE returns 404. The UI must name the expense and amount and require explicit confirmation. Refresh category/event/vendor totals afterward.

### Record a deposit/payment

`POST /events/1/expenses/10/payments`

```json
{
  "amount": "200.00",
  "paidAt": "2026-11-11",
  "paymentType": "DEPOSIT",
  "notes": "Initial photography deposit"
}
```

Required: amount and paidAt. paymentType defaults to PAYMENT; accepted write values are DEPOSIT and PAYMENT. notes defaults to null, maximum 255 characters. paidAt cannot be after UTC today because this endpoint records completed payments, not scheduled obligations.

201 response contains `data.payment` and `data.expense`:

- payment: paymentId, expenseId, amount, paidAt, paymentType, notes and createdAt.
- expense: the full expense object above, now with paidTotal `"200.00"`, outstandingAmount `"800.00"`, and paymentStatus `"PARTIALLY_PAID"`.

GET payment history returns the list envelope. Existing REFUND records are returned with positive amount and paymentType REFUND; their sign is applied in calculations.

In one transaction, lock the parent expense, recheck access/ownership as appropriate, calculate current net paid, reject an excessive payment with 409, insert the payment, and calculate the returned expense state. All future payment writers and expense amount updates/deletes must use the same locking discipline. Two concurrent payments must not both spend the same outstanding balance.

No idempotency-key storage exists in the current schema. Do not automatically retry payment POSTs after an uncertain network failure; refresh history before the user decides whether to resubmit. Disable repeated submission while a request is pending. Persistent idempotency is a follow-up if automatic retries are required.

## 6. Calculations and summary

For each expense:

```text
net paid = SUM(DEPOSIT + PAYMENT - REFUND)
outstanding = committed amount - net paid
remaining category budget = planned category amount - category committed total
```

Status is PAID when net paid equals committed (including a zero-value expense), UNPAID when net paid is zero and committed is positive, otherwise PARTIALLY_PAID when net paid is between zero and committed. Supported writes preserve `0 <= net paid <= committed`. If imported data violates that invariant, report a data-integrity error rather than silently clamping or labeling it paid.

Overdue means dueDate is not null, dueDate is before UTC today, and outstanding is positive. Due today is not overdue. Due-this-month includes unpaid balances with dates in the current UTC calendar month, including overdue dates in that month. It does not sum original committed amounts for partially paid expenses.

Summaries aggregate payments per expense first, then expenses per category/event. Do not sum committed amounts over a raw expense-to-payments join. Include categories with no expenses. Vendor quote/contract totals are not added to expense commitments.

`GET /events/1/expenses/summary` returns `data` with:

| Field | Meaning |
| --- | --- |
| eventId | Requested event ID |
| asOfDate | UTC calculation date |
| eventBudget | events.total_budget |
| allocatedBudget | Sum of category planned amounts |
| unallocatedBudget | eventBudget - allocatedBudget |
| committedTotal | Sum of all expense commitments |
| paidTotal | Net deposits/payments/refunds |
| outstandingTotal | committedTotal - paidTotal |
| remainingBudget | eventBudget - committedTotal |
| isOverBudget | committedTotal > eventBudget |
| overdueTotal | Sum of outstanding on overdue expenses |
| dueThisMonthTotal | Sum of outstanding due in current month |
| expenseCount | Number of expenses |
| openExpenseCount | Number with positive outstanding |
| dueThisMonthCount | Number with positive outstanding due this month |
| categories | Array ordered by sort_order, then category ID |

Each category contains categoryId, categoryName, plannedAmount, committedTotal, paidTotal, outstandingTotal, remainingBudget, isOverBudget and overdueTotal. Category remainingBudget uses its plannedAmount, not eventBudget. Counts are JSON integers; flags are booleans; all money fields use decimal strings.

Example: category planned 1500.00, expense committed 1000.00, deposit 200.00 -> paid 200.00, outstanding 800.00, remaining category budget 500.00. Another payment of 800.00 yields PAID with remaining category budget still 500.00. A deposit must not be counted again as an additional expense commitment.

The existing vendor view must remain consistent: refunds subtract from paid_total; next_due_date is the earliest non-null due date among expenses with positive outstanding. A fully paid expense does not contribute a due date.

## 7. Errors

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Check the submitted fields.",
    "fields": {
      "committedAmount": "Use a nonnegative decimal string with two decimal places."
    }
  }
}
```

`fields` is optional. This envelope applies to new expense routes; existing /health and unrelated scaffold errors need not change in this commit.

| HTTP | Code | Use |
| --- | --- | --- |
| 400 | BAD_REQUEST | Malformed JSON or malformed path ID |
| 401 | UNAUTHENTICATED | Missing/invalid verified identity |
| 403 | FORBIDDEN | No event membership |
| 404 | NOT_FOUND | Unknown route or expense absent from authorized event |
| 405 | METHOD_NOT_ALLOWED | Unsupported method on known route |
| 409 | PAYMENT_EXCEEDS_BALANCE | Payment greater than outstanding |
| 409 | AMOUNT_BELOW_PAID | Expense edit would put committed below net paid |
| 409 | HAS_PAYMENTS | Expense has payment or refund history and cannot be deleted |
| 413 | PAYLOAD_TOO_LARGE | Body exceeds agreed limit |
| 415 | UNSUPPORTED_MEDIA_TYPE | Write body is not application/json |
| 422 | VALIDATION_ERROR | Invalid fields, query, or same-event associations |
| 500 | INTERNAL_ERROR | Unexpected failure or invalid stored financial invariant |
| 503 | SERVICE_UNAVAILABLE | Temporary database unavailability |

Do not expose SQL, credentials, stack traces, tokens or other events' record details. Roll back failed transactions. Unknown internal failures return generic messages and are logged server-side.

## 8. Integration dependencies and fixtures

- Event/budget owner: selected event ID, category-list endpoint and planned amounts. Consume their agreed contract rather than creating duplicate event/category APIs.
- Vendor owner: vendor-list contract, nullable vendor policy and shared fixture ownership.
- Security owner: verified principal adapter and shared event membership checks.
- Cloud owner: Event API Lambda packaging, authorized API Gateway routes, RDS networking and secret configuration. Local HTTP routing is not proof of cloud completion.
- Frontend: replace expensesSeed and hardcoded totals, use expenseId as row key, show real loading/errors, and invalidate/refetch lists, payment history and summaries after writes/event changes. Clear stale event data and ignore stale responses after switching events.

Existing seeds run in filename order. `01_base_seed.sql` creates two events and membership/category fixtures. `02_vendors_seed.sql` creates vendors plus expense/payment fixtures and deletes all expenses for events 1 and 2 when rerun. Coordinate before splitting fixtures into a new file; do not duplicate rows or invalidate vendor expected totals. Seed resets are for disposable local/test databases only.

## 9. Acceptance examples for later implementation

- Authorized owner/co-planner can manage their event; another event's user cannot read or mutate it.
- Expense/category/vendor IDs cannot be mixed across events; nested payment routes check expense ownership.
- 1000.00 commitment + 200.00 deposit + 800.00 payment yields paid 1000.00, outstanding 0.00 and PAID.
- Two competing payments whose total exceeds the balance cannot both succeed.
- An existing 1000.00 deposit and 150.00 refund yield net paid 850.00.
- Multiple payments never multiply committed summary totals.
- An expense amount cannot be reduced below net paid; category/vendor edits remain event-scoped.
- Delete removes associated payments and updates event/category/vendor results.
- No-vendor, no-due-date, zero-amount and empty-category cases work.
- Overdue tests use a fixed calculation date; due today, null dates and fully paid expenses are not overdue.
- 0.10 plus 0.20 remains exactly 0.30; money and IDs survive serialization without precision loss.
- Committed spending above planned budget produces a negative remaining budget and an over-budget flag.
- List pagination/filtering does not change event summary totals.
- Reload shows persisted records; switching events never displays the previous event's results.
- Local and Lambda adapters implement the same contract; deployed authentication is verified before MVP sign-off.

## 10. Commit boundary

Commit 1 adds only this document. It does not create endpoints, change SQL, install packages, configure AWS or implement authentication. Later commits implement and test the contract, incorporating any team-approved policy revisions before dependent code.
