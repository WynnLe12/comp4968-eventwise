# Feature 4 fixture setup (commit 3)

These fixtures support later expense API tests. They do not implement the API or prove authorization is enforced.

## Load on a disposable local database

From the repository root, with Docker Desktop running:

```bash
npm --prefix backend run db:up
npm --prefix backend run db:seed -- 03_expenses_seed.sql
node scripts/verify-expense-seed.mjs
```

This seed is independent of the base/vendor seeds. It resets only reserved fixture events 400 and 401, including their related records. Do not create manual data under these IDs. No database-volume reset is required. It contains a transaction so a failed insert rolls back its resets. The database schema must already be installed by the normal Docker setup.

Repeat the last two commands to verify rerun behavior. Expected result: 17 PASS checks after each run. Payment auto-increment IDs may change; match fixture payments by expense ID and values, not generated payment IDs.

The existing all-seed command runs 01, 02, then 03 in filename order. Unlike loading only 03, loading all seeds also resets demo events 1 and 2 through the existing scripts. This commit leaves their fixtures unchanged. Existing vendors, expenses and payment examples remain reusable; no copies of them are created here.

## Reserved data

| Kind | IDs / identities |
| --- | --- |
| Main event | 400 |
| Other event | 401 |
| Main categories | 4001-4004 |
| Other category | 4010 |
| Vendors | 4001 and 4010 |
| Main expenses | 4001-4007 |
| Other expense | 4010 |
| Main owner / co-planner | expense-test-owner / expense-test-planner |
| Other owner | expense-test-other-owner |

Cognito subs are fake fixture identities. Use injected test principals in future tests; do not turn these names into a production login bypass. Future authenticated end-to-end tests need real test users.

## Expected totals

All dates below use a fixed reference of **2026-11-11 UTC**. A live UI using today's date can show different overdue/month totals later. Do not change fixtures every day; control the clock in automated tests.

| Main event 400 measure | Expected |
| --- | ---: |
| Budget / allocated budget | 2000.00 |
| Expense count | 7 |
| Payment row count (including refund) | 7 |
| Committed | 2300.30 |
| Net paid | 580.30 |
| Outstanding | 1720.00 |
| Remaining budget | -300.30 |
| Overdue outstanding | 1420.00 |
| Outstanding due in November | 1620.00 |
| Vendor 4001 net paid | 280.00 |
| Vendor 4001 next due date | 2026-11-01 |

| Category | Planned | Committed | Paid | Outstanding | Remaining |
| --- | ---: | ---: | ---: | ---: | ---: |
| Venue | 1000.00 | 1200.00 | 200.00 | 1000.00 | -200.00 |
| Supplies | 500.00 | 500.30 | 300.30 | 200.00 | -0.30 |
| Other | 500.00 | 600.00 | 80.00 | 520.00 | -100.00 |
| Empty category | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |

Event 401 has one 50.00 unpaid expense, a 100.00 budget and no payments. It must never contribute to event 400 totals.

Cases: partial overdue payment; unpaid due today; past date but fully paid; no due date; zero commitment; 0.10 + 0.20 exact cents; existing refund subtraction; vendorless expense; empty category; category/event overrun; separate event/member fixtures.

## Validation boundaries

The verifier is read-only and exits nonzero on SQL errors or any failed check. It uses the existing local Docker connection convention, not DB_* variables or RDS. The SQL uses exact MySQL DECIMAL sums and aggregates payments before expenses.

Future API tests still need to verify cross-event request rejection, unauthorized users, invalid associations, overpayment, simultaneous writes, edits, and deletion. Fixtures and a membership row check alone do not establish those behaviors. Never use seeded test events on production databases.
