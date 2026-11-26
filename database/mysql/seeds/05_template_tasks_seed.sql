-- Default checklists per event type (Feature 12). PROVISIONAL
-- Local development only. RDS gets the same rows from migrations/006_template_checklists.sql.
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
  UNION ALL SELECT 'baby_shower', 'Set the budget', 'Agree on a total and who is contributing.', 90, 1
  UNION ALL SELECT 'baby_shower', 'Confirm the guest list with the parents-to-be', NULL, 60, 2
  UNION ALL SELECT 'baby_shower', 'Book the venue', NULL, 60, 3
  UNION ALL SELECT 'baby_shower', 'Choose a theme', NULL, 45, 4
  UNION ALL SELECT 'baby_shower', 'Send invitations', 'Include the gift registry details.', 35, 5
  UNION ALL SELECT 'baby_shower', 'Plan the menu', NULL, 21, 6
  UNION ALL SELECT 'baby_shower', 'Plan games and activities', NULL, 14, 7
  UNION ALL SELECT 'baby_shower', 'Order the cake', NULL, 14, 8
  UNION ALL SELECT 'baby_shower', 'Buy decorations and favors', NULL, 7, 9
  UNION ALL SELECT 'baby_shower', 'Confirm RSVPs', NULL, 5, 10
  UNION ALL SELECT 'baby_shower', 'Set up a gift table and card list', 'Ask someone to note who gave what for thank-you cards.', 1, 11
  UNION ALL SELECT 'corporate', 'Define goals and the overall budget', 'Agree on objectives, audience and spending limits with stakeholders.', 180, 1
  UNION ALL SELECT 'corporate', 'Book the venue', NULL, 150, 2
  UNION ALL SELECT 'corporate', 'Confirm speakers', NULL, 120, 3
  UNION ALL SELECT 'corporate', 'Book the caterer', NULL, 90, 4
  UNION ALL SELECT 'corporate', 'Book AV and production', 'Microphones, screens, lighting and livestream if needed.', 90, 5
  UNION ALL SELECT 'corporate', 'Send invitations or open registration', NULL, 60, 6
  UNION ALL SELECT 'corporate', 'Prepare marketing materials', NULL, 45, 7
  UNION ALL SELECT 'corporate', 'Arrange travel and accommodation for speakers', NULL, 30, 8
  UNION ALL SELECT 'corporate', 'Finalize the agenda', NULL, 30, 9
  UNION ALL SELECT 'corporate', 'Confirm the final headcount with the caterer', NULL, 10, 10
  UNION ALL SELECT 'corporate', 'Print badges and signage', NULL, 7, 11
  UNION ALL SELECT 'corporate', 'Brief staff and volunteers', NULL, 2, 12
  UNION ALL SELECT 'corporate', 'Run a tech check at the venue', NULL, 1, 13
  UNION ALL SELECT 'other', 'Set the budget', NULL, 60, 1
  UNION ALL SELECT 'other', 'Book the venue', NULL, 45, 2
  UNION ALL SELECT 'other', 'Send invitations', NULL, 30, 3
  UNION ALL SELECT 'other', 'Plan food and drinks', NULL, 14, 4
  UNION ALL SELECT 'other', 'Arrange activities or entertainment', NULL, 14, 5
  UNION ALL SELECT 'other', 'Buy decorations and supplies', NULL, 7, 6
  UNION ALL SELECT 'other', 'Confirm RSVPs', NULL, 3, 7
  UNION ALL SELECT 'other', 'Confirm vendor arrival times', NULL, 2, 8
) d ON d.template_key = et.template_key
ON DUPLICATE KEY UPDATE description = d.description, days_before_event = d.days_before_event, sort_order = d.sort_order;
