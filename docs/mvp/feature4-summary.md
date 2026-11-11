# Feature 4 commit 6: category and event spending summaries

Commit: `feat(expenses): calculate category and event spending summaries`
Branch: `feature4-expense-tracking`. Requires commits 1-5; no schema/dependency changes.

## Endpoint

`GET /events/{eventId}/expenses/summary`

Requires verified identity and event membership, as with expense CRUD. Returns HTTP 200 with `{"data": <summary>}`. The literal summary route is matched before numeric expense IDs. It accepts no query parameters: category, date, status and pagination filters return 422. Unsupported methods return 405 with Allow: GET. Missing authentication returns 401; nonmembers return 403. It never uses filters from an expense-list request.

The production calculation date is UTC today, returned as asOfDate. Tests can inject a fixed service clock; clients cannot override it through a query parameter. The existing Cognito configuration requirement is unchanged.

## Response fields and calculations

| Field | Definition |
| --- | --- |
| eventId / asOfDate | Event ID string / UTC YYYY-MM-DD calculation date |
| eventBudget | Event total_budget |
| allocatedBudget | Sum of category planned amounts |
| unallocatedBudget | eventBudget - allocatedBudget; may be negative |
| committedTotal | Sum of expense committed amounts |
| paidTotal | Deposits + payments - refunds |
| outstandingTotal | committedTotal - paidTotal |
| remainingBudget | eventBudget - committedTotal; may be negative |
| isOverBudget | committedTotal > eventBudget |
| overdueTotal | Outstanding on expenses due strictly before asOfDate |
| dueThisMonthTotal | Outstanding due in the current UTC calendar month, including overdue dates in that month |
| expenseCount | All expenses, including zero-value commitments |
| openExpenseCount | Expenses with positive outstanding |
| dueThisMonthCount | Expenses with positive outstanding due this month |
| categories | All categories, ordered by sort_order then numeric category ID |

Every category contains categoryId, categoryName, plannedAmount, committedTotal, paidTotal, outstandingTotal, remainingBudget, isOverBudget and overdueTotal. Category remainingBudget uses its plannedAmount. IDs and monetary values are strings; counts are integers and flags are booleans.

Paid expenses, zero-value expenses and missing due dates do not contribute to overdue/month outstanding. Due today is included in this month's amount but is not overdue. An event with no categories has categories=[], zero allocated/spent amounts and remainingBudget equal to eventBudget. A category with no expenses remains in the response with zero spending.

Over-allocation and spending overrun are different: a 50.00 event with categories planned at 60.00 but no expenses has unallocatedBudget=-10.00 and isOverBudget=false.

## Consistent exact aggregation

The repository performs one nonlocking SQL SELECT with CTEs, scoped to the requested event. It first aggregates signed payments by expense, then expenses by category, then left-joins categories to the event. Multiple payment rows cannot multiply committed amounts. One statement supplies a consistent snapshot of the event budget and category/expense/payment values even though the surrounding transaction uses READ COMMITTED.

The service uses BigInt cents to combine category totals and serialize exact decimal strings. Aggregates can exceed the per-row DECIMAL(12,2) maximum without losing precision. Vendor quotes and contract totals are not added to commitments. Existing vendor_payment_totals continues to use the same refund/net-paid definition.

SQL tracks invalid individual expense balances before aggregation. Negative net paid or net paid above commitment returns a generic 500 instead of allowing bad rows to cancel each other out in an apparently valid total. No data is repaired or changed by a summary request.

## Fixed fixture expectations

At 2026-11-11 UTC, event 400 has:

| Measure | Expected |
| --- | ---: |
| Budget / allocated | 2000.00 |
| Committed | 2300.30 |
| Paid | 580.30 |
| Outstanding | 1720.00 |
| Remaining budget | -300.30 |
| Overdue outstanding | 1420.00 |
| Due this month | 1620.00 |
| Expense / open / due-this-month count | 7 / 4 / 3 |

| Category | Planned | Committed | Paid | Outstanding | Remaining |
| --- | ---: | ---: | ---: | ---: | ---: |
| Venue | 1000.00 | 1200.00 | 200.00 | 1000.00 | -200.00 |
| Supplies | 500.00 | 500.30 | 300.30 | 200.00 | -0.30 |
| Other | 500.00 | 600.00 | 80.00 | 520.00 | -100.00 |
| Empty category | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |

The fixture verifier and MySQL integration check use a fixed date. A live endpoint called later can legitimately return different overdue/month totals.

## Run checks

From the repository root after extracting the commit 6 archive:

```bash
npm --prefix backend run typecheck
npm --prefix backend test
```

Expected default suite: **29 passing tests**. This suite runs without MySQL/Cognito and tests arithmetic, empty events/categories, over-allocation, large sums, invalid invariants, authorization, and HTTP routing, including regression coverage for commits 4-5.

No new dependencies were added. Reuse commit 5's installed dependencies. The repository still requires Node >=22.12.0.

With Docker Desktop running and existing unchanged commit 3 fixtures, run these one at a time, stopping on failure:

```bash
npm --prefix backend run db:up
npm --prefix backend run db:check
npm --prefix backend run test:db
npm --prefix backend run test:payments:db
npm --prefix backend run test:summary:db
node scripts/verify-expense-seed.mjs
```

No reseeding is needed if the fixtures are already present and unchanged. Use the disposable local DB only. The new summary check creates a temporary expense in event 400 and a separate generated temporary event, then cleans up records it created. It does not reset demo fixtures. It verifies:

- Exact event/category totals, existing refunds, empty categories and vendor-view consistency.
- Event isolation and independence from expense-list pagination/status filters.
- Updated totals after creation, payment, amount/category edits and deletion.
- A category-less event, an empty category and over-allocation without spending.
- Due today, null dates and December/January boundaries using injected clocks.
- Detection of deliberately invalid payment data in its temporary event.

Expected final message:

```text
All MySQL summary integration checks passed; temporary records cleaned up.
```

The last fixture verification should still show 17 PASS results. Do not run fixture reseeding concurrently with integration checks. A force-terminated process can leave temporary data; normal completion cleans up automatically.

The MySQL integration script was typechecked but could not be executed against MySQL in the preparation environment. Run it locally and retain the actual results. Cognito sign-in and deployed RDS/API Gateway behavior are separate integration checks; these scripts pass fixture identities directly to the service.

## Scope and Trello

This commit exposes the summary API. It does not connect the prototype frontend or deploy AWS infrastructure. Frontend integration follows in commits 7-8 and cloud adapter/deployment in commit 9.

Trello card: Calculate category and event spending summaries. Add local test results and the commit/PR link; follow the team's review/merge rule before moving it to Done.
