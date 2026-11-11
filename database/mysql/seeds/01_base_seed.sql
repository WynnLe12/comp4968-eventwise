-- Base seed: the shared events, members and budget categories that the feature
-- seeds (02_..., 03_...) build on. LOCAL DEVELOPMENT AND TESTS ONLY.
--
-- Event 1: Maya & Eli's Wedding (the main demo event)
-- Event 2: Sam's 30th Birthday (a second event, for testing that events stay separate)
--
-- Members (fake Cognito subs; on RDS they must be real test users' subs):
--   user-maya  OWNER of event 1
--   user-eli   CO_PLANNER of event 1
--   user-sam   OWNER of event 2 only, so user-sam gets 403 on event 1
--
-- Budget categories: 1-7 belong to event 1, 8-9 to event 2.
--
-- Replace these stand-ins with the owning teams' data (Features 1 and 3) when they
-- have their own seeds.

USE eventwise;

-- Reset. Expenses go first: their RESTRICT foreign keys block the cascade from
-- events (a known schema issue). Deleting an expense also deletes its payments,
-- and deleting an event removes its members, categories, vendors and other rows.
DELETE FROM expenses WHERE event_id IN (1, 2);
DELETE FROM events   WHERE event_id IN (1, 2);

INSERT INTO events (event_id, template_id, name, event_date, venue, total_budget) VALUES
 (1, (SELECT template_id FROM event_templates WHERE template_key = 'wedding'),
     'Maya & Eli''s Wedding', '2027-09-18', 'The Willow House', 35000.00),
 (2, (SELECT template_id FROM event_templates WHERE template_key = 'birthday'),
     'Sam''s 30th Birthday', '2027-03-06', NULL, 3000.00);

INSERT INTO event_members (event_id, cognito_sub, role) VALUES
 (1, 'user-maya', 'OWNER'),
 (1, 'user-eli',  'CO_PLANNER'),
 (2, 'user-sam',  'OWNER');

INSERT INTO budget_categories (category_id, event_id, name, planned_amount, sort_order) VALUES
 (1, 1, 'Venue & Catering',      14700.00, 1),
 (2, 1, 'Photo & Video',          4900.00, 2),
 (3, 1, 'Attire & Beauty',        3500.00, 3),
 (4, 1, 'Flowers & Decor',        4200.00, 4),
 (5, 1, 'Music & Entertainment',  3150.00, 5),
 (6, 1, 'Stationery',             1750.00, 6),
 (7, 1, 'Other',                  2800.00, 7),
 (8, 2, 'Food',                   1500.00, 1),
 (9, 2, 'Entertainment',           900.00, 2);
