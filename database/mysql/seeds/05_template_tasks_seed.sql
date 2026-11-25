-- Default checklists per event type (Feature 12). PROVISIONAL, subject to team confirmation.
-- Local development only. RDS gets the same rows from migrations/005_tasks_checklists.sql.
-- Upserts keep IDs, so tasks already generated from these rows stay linked.
-- Due date of a generated task = event_date minus days_before_event.

USE eventwise;

INSERT INTO template_tasks (template_id, title, description, days_before_event, sort_order)
SELECT et.template_id, d.title, d.description, d.days_before_event, d.sort_order
FROM event_templates et
JOIN (
  SELECT 'wedding' AS template_key, 'Set the overall budget' AS title, 'Agree on a total and how it splits across categories.' AS description, 365 AS days_before_event, 1 AS sort_order
  UNION ALL SELECT 'wedding', 'Book the venue', NULL, 330, 2
  UNION ALL SELECT 'wedding', 'Book the photographer', NULL, 300, 3
  UNION ALL SELECT 'wedding', 'Book the caterer', NULL, 270, 4
  UNION ALL SELECT 'wedding', 'Send save-the-dates', NULL, 240, 5
  UNION ALL SELECT 'wedding', 'Book ceremony musicians', NULL, 180, 6
  UNION ALL SELECT 'wedding', 'Order wedding attire', 'Leave time for fittings and alterations.', 180, 7
  UNION ALL SELECT 'wedding', 'Send invitations', NULL, 90, 8
  UNION ALL SELECT 'wedding', 'Finalize the guest list', NULL, 60, 9
  UNION ALL SELECT 'wedding', 'Confirm the final headcount with the caterer', NULL, 14, 10
  UNION ALL SELECT 'wedding', 'Confirm vendor arrival times', NULL, 7, 11
  UNION ALL SELECT 'birthday', 'Pick a venue', NULL, 60, 1
  UNION ALL SELECT 'birthday', 'Send invitations', NULL, 30, 2
  UNION ALL SELECT 'birthday', 'Plan food and drinks', NULL, 14, 3
  UNION ALL SELECT 'birthday', 'Order the cake', NULL, 14, 4
  UNION ALL SELECT 'birthday', 'Buy decorations', NULL, 7, 5
  UNION ALL SELECT 'birthday', 'Confirm RSVPs', NULL, 3, 6
) d ON d.template_key = et.template_key
ON DUPLICATE KEY UPDATE description = d.description, days_before_event = d.days_before_event, sort_order = d.sort_order;
