-- Feature 4 fixtures: disposable local/test databases only.
-- Reserved fixture events: 400, 401; categories/vendors/expenses: 4001-4010.
-- Independent of 01/02: never deletes or changes their events, vendors or expenses.
-- Repeatable: resets ONLY the reserved events. Do not use these IDs for manual data.
-- Dates are deterministic; verification uses 2026-11-11, not the wall clock.
USE eventwise;
START TRANSACTION;
DELETE FROM expenses WHERE event_id IN (400, 401);
DELETE FROM events WHERE event_id IN (400, 401);

INSERT INTO events (event_id, name, event_date, total_budget) VALUES
 (400, 'Feature 4 expense test event', '2027-01-15', 2000.00),
 (401, 'Feature 4 isolation test event', '2027-02-15', 100.00);
INSERT INTO event_members (event_id, cognito_sub, role) VALUES
 (400, 'expense-test-owner', 'OWNER'),
 (400, 'expense-test-planner', 'CO_PLANNER'),
 (401, 'expense-test-other-owner', 'OWNER');
INSERT INTO budget_categories (category_id, event_id, name, planned_amount, sort_order) VALUES
 (4001, 400, 'Venue', 1000.00, 1),
 (4002, 400, 'Supplies', 500.00, 2),
 (4003, 400, 'Other', 500.00, 3),
 (4004, 400, 'Empty category', 0.00, 4),
 (4010, 401, 'Other event category', 100.00, 1);
INSERT INTO vendors (vendor_id, event_id, name) VALUES
 (4001, 400, 'Expense fixture vendor'),
 (4010, 401, 'Other event fixture vendor');
INSERT INTO expenses
 (expense_id, event_id, category_id, vendor_id, description, committed_amount, due_date) VALUES
 (4001, 400, 4001, 4001, 'Overdue partial payment and category overrun', 1200.00, '2026-11-10'),
 (4002, 400, 4002, NULL, 'Due today, unpaid', 200.00, '2026-11-11'),
 (4003, 400, 4002, NULL, 'Past due date, fully paid', 300.00, '2026-11-01'),
 (4004, 400, 4003, NULL, 'No due date, unpaid', 100.00, NULL),
 (4005, 400, 4003, NULL, 'Zero commitment', 0.00, '2026-11-01'),
 (4006, 400, 4002, NULL, 'Exact cents with multiple payments', 0.30, '2026-11-12'),
 (4007, 400, 4003, 4001, 'Deposit with refund', 500.00, '2026-11-01'),
 (4010, 401, 4010, 4010, 'Other event must stay separate', 50.00, '2026-11-01');
INSERT INTO expense_payments (expense_id, amount, paid_at, payment_type, notes) VALUES
 (4001, 200.00, '2026-11-01', 'DEPOSIT', NULL),
 (4003, 100.00, '2026-10-01', 'DEPOSIT', NULL),
 (4003, 200.00, '2026-11-01', 'PAYMENT', NULL),
 (4006, 0.10, '2026-11-01', 'DEPOSIT', NULL),
 (4006, 0.20, '2026-11-02', 'PAYMENT', NULL),
 (4007, 100.00, '2026-10-01', 'DEPOSIT', NULL),
 (4007, 20.00, '2026-11-02', 'REFUND', 'Refund reduces net paid to 80.00');
COMMIT;
