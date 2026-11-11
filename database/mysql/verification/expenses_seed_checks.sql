-- Read-only fixture verification. This is not the future production summary query.
-- Fixed reference date ensures stable results after the demo date passes.
USE eventwise;
WITH payment_totals AS (
 SELECT expense_id, SUM(CASE WHEN payment_type = 'REFUND' THEN -amount ELSE amount END) AS paid
 FROM expense_payments GROUP BY expense_id
), expense_totals AS (
 SELECT e.*, COALESCE(p.paid, 0.00) AS paid,
 e.committed_amount - COALESCE(p.paid, 0.00) AS outstanding
 FROM expenses e LEFT JOIN payment_totals p ON p.expense_id = e.expense_id
), checks AS (
 SELECT 'fixture row counts' AS check_name,
 (SELECT COUNT(*) FROM expenses WHERE event_id = 400) = 7
 AND (SELECT COUNT(*) FROM expense_payments p JOIN expenses e USING (expense_id) WHERE e.event_id = 400) = 7 AS passed
 UNION ALL SELECT 'event commitments', (SELECT SUM(committed_amount) FROM expense_totals WHERE event_id = 400) = 2300.30
 UNION ALL SELECT 'event net paid', (SELECT SUM(paid) FROM expense_totals WHERE event_id = 400) = 580.30
 UNION ALL SELECT 'event outstanding', (SELECT SUM(outstanding) FROM expense_totals WHERE event_id = 400) = 1720.00
 UNION ALL SELECT 'event budget overrun', (SELECT total_budget FROM events WHERE event_id = 400) - (SELECT SUM(committed_amount) FROM expense_totals WHERE event_id = 400) = -300.30
 UNION ALL SELECT 'overdue outstanding', (SELECT SUM(outstanding) FROM expense_totals WHERE event_id = 400 AND due_date < '2026-11-11' AND outstanding > 0) = 1420.00
 UNION ALL SELECT 'due this month outstanding', (SELECT SUM(outstanding) FROM expense_totals WHERE event_id = 400 AND due_date >= '2026-11-01' AND due_date < '2026-12-01' AND outstanding > 0) = 1620.00
 UNION ALL SELECT 'due today is not overdue', (SELECT COUNT(*) FROM expense_totals WHERE expense_id = 4002 AND due_date < '2026-11-11' AND outstanding > 0) = 0
 UNION ALL SELECT 'past due but fully paid', (SELECT outstanding FROM expense_totals WHERE expense_id = 4003) = 0.00
 UNION ALL SELECT 'missing due date', (SELECT COUNT(*) FROM expense_totals WHERE expense_id = 4004 AND due_date IS NULL AND outstanding = 100.00) = 1
 UNION ALL SELECT 'zero amount', (SELECT COUNT(*) FROM expense_totals WHERE expense_id = 4005 AND committed_amount = 0 AND paid = 0) = 1
 UNION ALL SELECT 'exact cent arithmetic', (SELECT paid FROM expense_totals WHERE expense_id = 4006) = 0.30
 UNION ALL SELECT 'refund subtraction', (SELECT paid FROM expense_totals WHERE expense_id = 4007) = 80.00
 UNION ALL SELECT 'empty category exists', (SELECT COUNT(*) FROM budget_categories c LEFT JOIN expenses e ON e.category_id = c.category_id WHERE c.category_id = 4004 AND e.expense_id IS NULL) = 1
 UNION ALL SELECT 'other event separate', (SELECT SUM(committed_amount) FROM expense_totals WHERE event_id = 401) = 50.00
 UNION ALL SELECT 'vendor view matches', (SELECT COUNT(*) FROM vendor_payment_totals WHERE vendor_id = 4001 AND event_id = 400 AND paid_total = 280.00 AND next_due_date = '2026-11-01') = 1
 UNION ALL SELECT 'membership fixtures', (SELECT COUNT(*) FROM event_members WHERE event_id = 400 AND cognito_sub IN ('expense-test-owner','expense-test-planner')) = 2 AND (SELECT COUNT(*) FROM event_members WHERE event_id = 400 AND cognito_sub = 'expense-test-other-owner') = 0
)
SELECT check_name, IF(passed, 'PASS', 'FAIL') AS result FROM checks;
