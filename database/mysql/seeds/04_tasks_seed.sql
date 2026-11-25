-- Tasks seed (Feature 12). LOCAL DEVELOPMENT AND TESTS ONLY.
-- Needs 01_base_seed.sql (events 1-2 and their members).
--
-- Event 1 (Maya & Eli's Wedding):
--   task 1  completed, completed_at set, unassigned
--   task 2  open, assigned to user-eli (CO_PLANNER)
--   task 3  open, no due date, unassigned
--   task 4  open, assigned to user-maya (OWNER)
--   Expected progress: { total: 4, completed: 1, open: 3, percentComplete: 25 }
-- Event 2 (Sam's 30th Birthday):
--   task 5  open, assigned to user-sam (OWNER of event 2). Never counted for event 1.
--
-- Member IDs come from 01_base_seed.sql without explicit IDs, so they're looked up by sub.

USE eventwise;

-- Reset this file's rows.
DELETE FROM tasks WHERE event_id IN (1, 2);

INSERT INTO tasks (task_id, event_id, title, description, due_date, is_completed, completed_at, assigned_member_id) VALUES
 (1, 1, 'Book the venue', 'Deposit paid, contract signed.', '2026-12-01', TRUE, '2026-11-20 17:30:00', NULL),
 (2, 1, 'Send save-the-dates', NULL, '2027-02-01', FALSE, NULL,
     (SELECT member_id FROM event_members WHERE event_id = 1 AND cognito_sub = 'user-eli')),
 (3, 1, 'Choose the wedding cake', NULL, NULL, FALSE, NULL, NULL),
 (4, 1, 'Book ceremony musicians', 'String quartet or acoustic duo.', '2027-03-20', FALSE, NULL,
     (SELECT member_id FROM event_members WHERE event_id = 1 AND cognito_sub = 'user-maya')),
 (5, 2, 'Order the birthday cake', NULL, '2027-02-20', FALSE, NULL,
     (SELECT member_id FROM event_members WHERE event_id = 2 AND cognito_sub = 'user-sam'));
