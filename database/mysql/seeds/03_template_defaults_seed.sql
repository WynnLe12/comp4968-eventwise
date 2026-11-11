-- Feature 11 MVP. PROVISIONAL defaults, subject to team confirmation.
-- Local development only. Upserts preserve IDs and never touch event-owned data.
-- Rerunning restores these named defaults; unrelated custom template categories are retained.
USE eventwise;
START TRANSACTION;

INSERT INTO event_templates (template_key, name, description) VALUES ('wedding', 'Wedding', 'Provisional budget defaults; subject to team confirmation.') ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description);

INSERT INTO template_budget_categories (template_id, name, default_percentage, sort_order) VALUES
((SELECT template_id FROM event_templates WHERE template_key = 'wedding'), 'Venue & Catering', 42.00, 1),
((SELECT template_id FROM event_templates WHERE template_key = 'wedding'), 'Photo & Video', 14.00, 2),
((SELECT template_id FROM event_templates WHERE template_key = 'wedding'), 'Attire & Beauty', 10.00, 3),
((SELECT template_id FROM event_templates WHERE template_key = 'wedding'), 'Flowers & Decor', 12.00, 4),
((SELECT template_id FROM event_templates WHERE template_key = 'wedding'), 'Music & Entertainment', 9.00, 5),
((SELECT template_id FROM event_templates WHERE template_key = 'wedding'), 'Stationery', 5.00, 6),
((SELECT template_id FROM event_templates WHERE template_key = 'wedding'), 'Other', 8.00, 7)
ON DUPLICATE KEY UPDATE default_percentage = VALUES(default_percentage), sort_order = VALUES(sort_order);

INSERT INTO event_templates (template_key, name, description) VALUES ('baby_shower', 'Baby Shower', 'Provisional budget defaults; subject to team confirmation.') ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description);

INSERT INTO template_budget_categories (template_id, name, default_percentage, sort_order) VALUES
((SELECT template_id FROM event_templates WHERE template_key = 'baby_shower'), 'Venue', 30.00, 1),
((SELECT template_id FROM event_templates WHERE template_key = 'baby_shower'), 'Food & Drinks', 28.00, 2),
((SELECT template_id FROM event_templates WHERE template_key = 'baby_shower'), 'Decorations', 18.00, 3),
((SELECT template_id FROM event_templates WHERE template_key = 'baby_shower'), 'Games & Activities', 10.00, 4),
((SELECT template_id FROM event_templates WHERE template_key = 'baby_shower'), 'Invitations & Favors', 9.00, 5),
((SELECT template_id FROM event_templates WHERE template_key = 'baby_shower'), 'Other', 5.00, 6)
ON DUPLICATE KEY UPDATE default_percentage = VALUES(default_percentage), sort_order = VALUES(sort_order);

INSERT INTO event_templates (template_key, name, description) VALUES ('birthday', 'Birthday', 'Provisional budget defaults; subject to team confirmation.') ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description);

INSERT INTO template_budget_categories (template_id, name, default_percentage, sort_order) VALUES
((SELECT template_id FROM event_templates WHERE template_key = 'birthday'), 'Venue', 35.00, 1),
((SELECT template_id FROM event_templates WHERE template_key = 'birthday'), 'Food & Drinks', 25.00, 2),
((SELECT template_id FROM event_templates WHERE template_key = 'birthday'), 'Entertainment', 15.00, 3),
((SELECT template_id FROM event_templates WHERE template_key = 'birthday'), 'Decorations', 10.00, 4),
((SELECT template_id FROM event_templates WHERE template_key = 'birthday'), 'Cake', 10.00, 5),
((SELECT template_id FROM event_templates WHERE template_key = 'birthday'), 'Other', 5.00, 6)
ON DUPLICATE KEY UPDATE default_percentage = VALUES(default_percentage), sort_order = VALUES(sort_order);

INSERT INTO event_templates (template_key, name, description) VALUES ('corporate', 'Corporate', 'Provisional budget defaults; subject to team confirmation.') ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description);

INSERT INTO template_budget_categories (template_id, name, default_percentage, sort_order) VALUES
((SELECT template_id FROM event_templates WHERE template_key = 'corporate'), 'Venue', 38.00, 1),
((SELECT template_id FROM event_templates WHERE template_key = 'corporate'), 'Catering', 22.00, 2),
((SELECT template_id FROM event_templates WHERE template_key = 'corporate'), 'Production', 15.00, 3),
((SELECT template_id FROM event_templates WHERE template_key = 'corporate'), 'Speakers & Activities', 10.00, 4),
((SELECT template_id FROM event_templates WHERE template_key = 'corporate'), 'Marketing & Materials', 10.00, 5),
((SELECT template_id FROM event_templates WHERE template_key = 'corporate'), 'Other', 5.00, 6)
ON DUPLICATE KEY UPDATE default_percentage = VALUES(default_percentage), sort_order = VALUES(sort_order);

INSERT INTO event_templates (template_key, name, description) VALUES ('other', 'Other', 'Provisional budget defaults; subject to team confirmation.') ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description);

INSERT INTO template_budget_categories (template_id, name, default_percentage, sort_order) VALUES
((SELECT template_id FROM event_templates WHERE template_key = 'other'), 'Venue', 35.00, 1),
((SELECT template_id FROM event_templates WHERE template_key = 'other'), 'Food & Drinks', 30.00, 2),
((SELECT template_id FROM event_templates WHERE template_key = 'other'), 'Activities', 15.00, 3),
((SELECT template_id FROM event_templates WHERE template_key = 'other'), 'Decorations & Supplies', 10.00, 4),
((SELECT template_id FROM event_templates WHERE template_key = 'other'), 'Other', 10.00, 5)
ON DUPLICATE KEY UPDATE default_percentage = VALUES(default_percentage), sort_order = VALUES(sort_order);

COMMIT;
