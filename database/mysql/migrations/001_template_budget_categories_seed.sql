-- Approved category names, percentages and order copied exactly from
-- seeds/03_template_defaults_seed.sql. Existing template IDs are resolved by key.
-- MySQL >= 8.0.16 with InnoDB and enforced CHECK constraints is required.
-- Intended for mysql2 conn.query(sql) with multipleStatements: true.
-- No DELIMITER directive: that is a mysql CLI command, not server SQL.
-- Run one migration invocation at a time on a dedicated connection.
-- This helper routine provides rollback despite the runner not managing transactions.
-- A previous failed attempt may leave the routine; dropping it makes retry safe.
DROP PROCEDURE IF EXISTS eventwise_migration_001_template_defaults;
CREATE PROCEDURE eventwise_migration_001_template_defaults()
SQL SECURITY INVOKER
BEGIN
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    DROP TEMPORARY TABLE IF EXISTS migration_001_defaults;
    DROP TEMPORARY TABLE IF EXISTS migration_001_assertions;
    RESIGNAL;
  END;

  START TRANSACTION;
  DROP TEMPORARY TABLE IF EXISTS migration_001_defaults;
  DROP TEMPORARY TABLE IF EXISTS migration_001_assertions;
  CREATE TEMPORARY TABLE migration_001_defaults (
    template_key VARCHAR(40) NOT NULL,
    name VARCHAR(100) NOT NULL,
    default_percentage DECIMAL(5,2) NOT NULL,
    sort_order INT NOT NULL,
    PRIMARY KEY (template_key, name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
  CREATE TEMPORARY TABLE migration_001_assertions (
    check_name VARCHAR(100) NOT NULL,
    ok TINYINT NOT NULL,
    CONSTRAINT migration_001_validation_failed CHECK (ok = 1)
  ) ENGINE=InnoDB;

  INSERT INTO migration_001_defaults
    (template_key, name, default_percentage, sort_order) VALUES
  ('wedding', 'Venue & Catering', 42.00, 1),
  ('wedding', 'Photo & Video', 14.00, 2),
  ('wedding', 'Attire & Beauty', 10.00, 3),
  ('wedding', 'Flowers & Decor', 12.00, 4),
  ('wedding', 'Music & Entertainment', 9.00, 5),
  ('wedding', 'Stationery', 5.00, 6),
  ('wedding', 'Other', 8.00, 7),
  ('baby_shower', 'Venue', 30.00, 1),
  ('baby_shower', 'Food & Drinks', 28.00, 2),
  ('baby_shower', 'Decorations', 18.00, 3),
  ('baby_shower', 'Games & Activities', 10.00, 4),
  ('baby_shower', 'Invitations & Favors', 9.00, 5),
  ('baby_shower', 'Other', 5.00, 6),
  ('birthday', 'Venue', 35.00, 1),
  ('birthday', 'Food & Drinks', 25.00, 2),
  ('birthday', 'Entertainment', 15.00, 3),
  ('birthday', 'Decorations', 10.00, 4),
  ('birthday', 'Cake', 10.00, 5),
  ('birthday', 'Other', 5.00, 6),
  ('corporate', 'Venue', 38.00, 1),
  ('corporate', 'Catering', 22.00, 2),
  ('corporate', 'Production', 15.00, 3),
  ('corporate', 'Speakers & Activities', 10.00, 4),
  ('corporate', 'Marketing & Materials', 10.00, 5),
  ('corporate', 'Other', 5.00, 6),
  ('other', 'Venue', 35.00, 1),
  ('other', 'Food & Drinks', 30.00, 2),
  ('other', 'Activities', 15.00, 3),
  ('other', 'Decorations & Supplies', 10.00, 4),
  ('other', 'Other', 10.00, 5);

  -- Validate the approved source data using exact DECIMAL arithmetic.
  INSERT INTO migration_001_assertions (check_name, ok)
  SELECT 'approved_template_count', COUNT(DISTINCT template_key) = 5
  FROM migration_001_defaults;
  INSERT INTO migration_001_assertions (check_name, ok)
  SELECT CONCAT('approved_total:', template_key), SUM(default_percentage) = 100.00
  FROM migration_001_defaults GROUP BY template_key;

  -- Serialize against modifications to the five parent templates during this run.
  SELECT template_id FROM event_templates
  WHERE template_key IN ('wedding', 'baby_shower', 'birthday', 'corporate', 'other')
  ORDER BY template_id FOR UPDATE;
  INSERT INTO migration_001_assertions (check_name, ok)
  SELECT 'all_five_templates_exist', COUNT(*) = 5 FROM event_templates
  WHERE template_key IN ('wedding', 'baby_shower', 'birthday', 'corporate', 'other');

  -- Approved categories alone total 100. Preserve extra categories, but refuse
  -- to proceed if their percentages would make the resulting total exceed 100.
  INSERT INTO migration_001_assertions (check_name, ok)
  SELECT CONCAT('no_extra_allocation:', t.template_key),
         COALESCE(SUM(CASE WHEN d.name IS NULL THEN c.default_percentage ELSE 0 END), 0) = 0
  FROM event_templates AS t
  LEFT JOIN template_budget_categories AS c ON c.template_id = t.template_id
  LEFT JOIN migration_001_defaults AS d
    ON d.template_key = t.template_key AND d.name = c.name
  WHERE t.template_key IN ('wedding', 'baby_shower', 'birthday', 'corporate', 'other')
  GROUP BY t.template_key;

  -- uq_template_category(template_id, name) prevents duplicate categories.
  -- Updates preserve existing category IDs; new IDs are assigned by MySQL.
  INSERT INTO template_budget_categories
    (template_id, name, default_percentage, sort_order)
  SELECT t.template_id, d.name, d.default_percentage, d.sort_order
  FROM migration_001_defaults AS d
  JOIN event_templates AS t ON t.template_key = d.template_key
  WHERE TRUE
  ON DUPLICATE KEY UPDATE
    default_percentage = VALUES(default_percentage),
    sort_order = VALUES(sort_order);

  -- Validate actual persisted totals, including any preserved extra categories.
  INSERT INTO migration_001_assertions (check_name, ok)
  SELECT CONCAT('persisted_total:', t.template_key),
         COALESCE(SUM(c.default_percentage), 0) = 100.00
  FROM event_templates AS t
  LEFT JOIN template_budget_categories AS c ON c.template_id = t.template_id
  WHERE t.template_key IN ('wedding', 'baby_shower', 'birthday', 'corporate', 'other')
  GROUP BY t.template_key;

  DROP TEMPORARY TABLE migration_001_defaults;
  DROP TEMPORARY TABLE migration_001_assertions;

  COMMIT;
END;
CALL eventwise_migration_001_template_defaults();
DROP PROCEDURE eventwise_migration_001_template_defaults;
