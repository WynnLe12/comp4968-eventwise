-- Feature 12: checklists and tasks.
-- MySQL >= 8.0.16 is required for enforced CHECK constraints.
--
-- 1. template_tasks: the default checklist for each event type.
-- 2. tasks: completed_at, updated_at and a link to the template task it came from.
--
-- Schema only. The checklist rows are in 006_template_checklists.sql. Run this file once:
-- the CREATE TABLE and ALTER TABLE statements fail on a database that already has them.

CREATE TABLE template_tasks (
 template_task_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 template_id BIGINT UNSIGNED NOT NULL,
 title VARCHAR(200) NOT NULL,
 description TEXT NULL,
 -- Due date = event_date minus this many days. NULL = no due date.
 days_before_event INT NULL,
 sort_order INT NOT NULL DEFAULT 0,
 UNIQUE KEY uq_template_task_title (template_id, title),
 CONSTRAINT fk_tt_template FOREIGN KEY (template_id) REFERENCES event_templates(template_id) ON DELETE CASCADE,
 CONSTRAINT chk_tt_days CHECK (days_before_event IS NULL OR days_before_event BETWEEN 0 AND 730)
);

ALTER TABLE tasks
 ADD COLUMN completed_at DATETIME NULL AFTER is_completed,
 ADD COLUMN template_task_id BIGINT UNSIGNED NULL AFTER assigned_member_id,
 ADD COLUMN updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER created_at,
 -- Generating from a template twice can't duplicate a task (NULLs don't collide).
 ADD UNIQUE KEY uq_task_template (event_id, template_task_id),
 ADD KEY idx_task_event_open (event_id, is_completed, due_date),
 ADD CONSTRAINT fk_task_template FOREIGN KEY (template_task_id) REFERENCES template_tasks(template_task_id) ON DELETE SET NULL;

-- Backfill before adding the CHECK, in case rows were marked complete without a time.
UPDATE tasks SET completed_at = created_at WHERE is_completed = TRUE AND completed_at IS NULL;
UPDATE tasks SET completed_at = NULL WHERE is_completed = FALSE;

ALTER TABLE tasks
 ADD CONSTRAINT chk_task_completed_at CHECK (
   (is_completed = FALSE AND completed_at IS NULL) OR (is_completed = TRUE AND completed_at IS NOT NULL)
 );
