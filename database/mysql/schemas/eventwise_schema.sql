-- EventWise MySQL 8.0+ schema. Review policies with team before production.
-- Vendor changes (Feature 5): added category, contract_total, booking_status, updated_at
-- and status CHECKs; removed payment_due_date; added the vendor_payment_totals view.
CREATE DATABASE IF NOT EXISTS eventwise CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE eventwise;

CREATE TABLE event_templates (
 template_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 template_key VARCHAR(40) NOT NULL UNIQUE,
 name VARCHAR(100) NOT NULL,
 description TEXT NULL,
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE template_budget_categories (
 template_category_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 template_id BIGINT UNSIGNED NOT NULL,
 name VARCHAR(100) NOT NULL,
 default_percentage DECIMAL(5,2) NOT NULL,
 sort_order INT NOT NULL DEFAULT 0,
 UNIQUE KEY uq_template_category (template_id, name),
 CONSTRAINT fk_tbc_template FOREIGN KEY (template_id) REFERENCES event_templates(template_id) ON DELETE CASCADE,
 CONSTRAINT chk_tbc_percent CHECK (default_percentage BETWEEN 0 AND 100)
);
CREATE TABLE events (
 event_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 template_id BIGINT UNSIGNED NULL,
 name VARCHAR(150) NOT NULL,
 event_date DATE NULL,
 venue VARCHAR(255) NULL,
 total_budget DECIMAL(12,2) NOT NULL DEFAULT 0.00,
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 CONSTRAINT fk_event_template FOREIGN KEY (template_id) REFERENCES event_templates(template_id) ON DELETE SET NULL,
 CONSTRAINT chk_event_budget CHECK (total_budget >= 0)
);
CREATE TABLE event_members (
 member_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 event_id BIGINT UNSIGNED NOT NULL,
 cognito_sub VARCHAR(128) NOT NULL,
 role ENUM('OWNER','CO_PLANNER') NOT NULL,
 joined_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 -- MySQL generated unique column ensures at most one OWNER per event.
 -- VIRTUAL, not STORED: MySQL 8.0 rejects ON DELETE CASCADE on event_id when a STORED
 -- generated column is built from it (error 1215; MariaDB allows it). The unique index still works.
 owner_event_id BIGINT UNSIGNED GENERATED ALWAYS AS (CASE WHEN role = 'OWNER' THEN event_id ELSE NULL END) VIRTUAL,
 UNIQUE KEY uq_event_member (event_id, cognito_sub),
 UNIQUE KEY uq_one_owner_per_event (owner_event_id),
 KEY idx_member_user (cognito_sub, event_id),
 CONSTRAINT fk_member_event FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE
);
CREATE TABLE budget_categories (
 category_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 event_id BIGINT UNSIGNED NOT NULL,
 name VARCHAR(100) NOT NULL,
 allocation_percentage DECIMAL(5,2) NULL,
 planned_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
 sort_order INT NOT NULL DEFAULT 0,
 UNIQUE KEY uq_event_category (event_id, name),
 UNIQUE KEY uq_category_event_pair (category_id, event_id),
 CONSTRAINT fk_category_event FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE,
 CONSTRAINT chk_category_percent CHECK (allocation_percentage IS NULL OR allocation_percentage BETWEEN 0 AND 100),
 CONSTRAINT chk_category_amount CHECK (planned_amount >= 0)
);
CREATE TABLE vendors (
 vendor_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 event_id BIGINT UNSIGNED NOT NULL,
 name VARCHAR(150) NOT NULL,
 category VARCHAR(100) NULL,
 contact_name VARCHAR(150) NULL,
 email VARCHAR(254) NULL,
 phone VARCHAR(40) NULL,
 quote_amount DECIMAL(12,2) NULL,
 contract_total DECIMAL(12,2) NULL,
 booking_status ENUM('RESEARCHING','QUOTED','BOOKED','DECLINED') NOT NULL DEFAULT 'RESEARCHING',
 contract_status ENUM('NOT_STARTED','PENDING','SIGNED','CANCELLED') NOT NULL DEFAULT 'NOT_STARTED',
 notes TEXT NULL,
 -- No payment_due_date: the next due date is calculated from the vendor's expenses
 -- (see vendor_payment_totals below), so it can never disagree with them.
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 UNIQUE KEY uq_vendor_event_pair (vendor_id, event_id),
 KEY idx_vendor_event (event_id),
 CONSTRAINT fk_vendor_event FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE,
 CONSTRAINT chk_vendor_quote CHECK (quote_amount IS NULL OR quote_amount >= 0),
 CONSTRAINT chk_vendor_contract_total CHECK (contract_total IS NULL OR contract_total >= 0),
 -- Status rules that must always hold. The Event API applies the automatic
 -- changes (quote -> QUOTED, signed -> BOOKED); these reject anything that slips past it.
 CONSTRAINT chk_vendor_total_needs_contract CHECK (contract_total IS NULL OR contract_status <> 'NOT_STARTED'),
 CONSTRAINT chk_vendor_researching CHECK (booking_status <> 'RESEARCHING' OR (quote_amount IS NULL AND contract_status = 'NOT_STARTED')),
 CONSTRAINT chk_vendor_active_contract CHECK (contract_status NOT IN ('PENDING','SIGNED') OR booking_status IN ('QUOTED','BOOKED')),
 CONSTRAINT chk_vendor_signed_is_booked CHECK (contract_status <> 'SIGNED' OR booking_status = 'BOOKED')
);
CREATE TABLE expenses (
 expense_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 event_id BIGINT UNSIGNED NOT NULL,
 category_id BIGINT UNSIGNED NOT NULL,
 vendor_id BIGINT UNSIGNED NULL,
 description VARCHAR(255) NOT NULL,
 committed_amount DECIMAL(12,2) NOT NULL,
 due_date DATE NULL,
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 KEY idx_expense_event (event_id),
 KEY idx_expense_category_event (category_id, event_id),
 KEY idx_expense_vendor_event (vendor_id, event_id),
 CONSTRAINT fk_expense_event FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE,
 CONSTRAINT fk_expense_category_same_event FOREIGN KEY (category_id, event_id) REFERENCES budget_categories(category_id, event_id) ON DELETE RESTRICT,
 CONSTRAINT fk_expense_vendor_same_event FOREIGN KEY (vendor_id, event_id) REFERENCES vendors(vendor_id, event_id) ON DELETE RESTRICT,
 CONSTRAINT chk_expense_amount CHECK (committed_amount >= 0)
);
CREATE TABLE expense_payments (
 payment_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 expense_id BIGINT UNSIGNED NOT NULL,
 amount DECIMAL(12,2) NOT NULL,
 paid_at DATE NOT NULL,
 payment_type ENUM('DEPOSIT','PAYMENT','REFUND') NOT NULL DEFAULT 'PAYMENT',
 notes VARCHAR(255) NULL,
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 KEY idx_payment_expense (expense_id),
 CONSTRAINT fk_payment_expense FOREIGN KEY (expense_id) REFERENCES expenses(expense_id) ON DELETE CASCADE,
 CONSTRAINT chk_payment_positive CHECK (amount > 0)
);

-- Paid total and next due date per vendor, calculated from expenses and payments.
-- Refunds subtract. An expense is still due while its net payments are below its committed amount.
-- Used by the vendor API and the alerts feature, so both use the same definition.
CREATE VIEW vendor_payment_totals AS
SELECT
 e.vendor_id,
 e.event_id,
 SUM(COALESCE(p.net_paid, 0.00)) AS paid_total,
 MIN(CASE WHEN COALESCE(p.net_paid, 0.00) < e.committed_amount THEN e.due_date END) AS next_due_date
FROM expenses e
LEFT JOIN (
 SELECT expense_id,
  SUM(CASE WHEN payment_type = 'REFUND' THEN -amount ELSE amount END) AS net_paid
 FROM expense_payments
 GROUP BY expense_id
) p ON p.expense_id = e.expense_id
WHERE e.vendor_id IS NOT NULL
GROUP BY e.vendor_id, e.event_id;

-- Post-MVP extensions
CREATE TABLE event_invitations (
 invitation_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 event_id BIGINT UNSIGNED NOT NULL,
 email VARCHAR(254) NOT NULL,
 invited_by_sub VARCHAR(128) NOT NULL,
 token_hash CHAR(64) NOT NULL UNIQUE,
 status ENUM('PENDING','ACCEPTED','REVOKED','EXPIRED') NOT NULL DEFAULT 'PENDING',
 expires_at DATETIME NOT NULL,
 accepted_at DATETIME NULL,
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 KEY idx_invite_event (event_id),
 CONSTRAINT fk_invite_event FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE
);
CREATE TABLE tasks (
 task_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 event_id BIGINT UNSIGNED NOT NULL,
 title VARCHAR(200) NOT NULL,
 description TEXT NULL,
 due_date DATE NULL,
 is_completed BOOLEAN NOT NULL DEFAULT FALSE,
 assigned_member_id BIGINT UNSIGNED NULL,
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 KEY idx_task_event (event_id),
 CONSTRAINT fk_task_event FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE,
 CONSTRAINT fk_task_assignee FOREIGN KEY (assigned_member_id) REFERENCES event_members(member_id) ON DELETE SET NULL
);
CREATE TABLE event_documents (
 document_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 event_id BIGINT UNSIGNED NOT NULL,
 uploaded_by_sub VARCHAR(128) NOT NULL,
 -- ASCII: a unique index on VARCHAR(1024) utf8mb4 is 4096 bytes, over MySQL's 3072-byte limit (error 1071).
 -- The app generates the S3 keys, so they can stay ASCII.
 s3_object_key VARCHAR(1024) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 original_filename VARCHAR(255) NOT NULL,
 content_type VARCHAR(120) NOT NULL,
 size_bytes BIGINT UNSIGNED NOT NULL,
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE KEY uq_document_s3_key (s3_object_key),
 KEY idx_document_event (event_id),
 CONSTRAINT fk_document_event FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE
);
CREATE TABLE draft_budget_items (
 draft_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 event_id BIGINT UNSIGNED NOT NULL,
 document_id BIGINT UNSIGNED NULL,
 vendor_name VARCHAR(150) NULL,
 total_amount DECIMAL(12,2) NULL,
 deposit_amount DECIMAL(12,2) NULL,
 due_date DATE NULL,
 status ENUM('DRAFT','CONFIRMED','REJECTED') NOT NULL DEFAULT 'DRAFT',
 extracted_json JSON NULL,
 reviewed_by_sub VARCHAR(128) NULL,
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 KEY idx_draft_event (event_id),
 CONSTRAINT fk_draft_event FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE,
 CONSTRAINT fk_draft_document FOREIGN KEY (document_id) REFERENCES event_documents(document_id) ON DELETE SET NULL,
 CONSTRAINT chk_draft_total CHECK (total_amount IS NULL OR total_amount >= 0),
 CONSTRAINT chk_draft_deposit CHECK (deposit_amount IS NULL OR deposit_amount >= 0)
);

-- Initial template seeds. Budget allocation percentages are intentionally not seeded:
-- the team must approve percentages for each event type before inserting them.
INSERT INTO event_templates (template_key, name) VALUES
('wedding','Wedding'),('baby_shower','Baby Shower'),('birthday','Birthday'),
('corporate','Corporate'),('other','Other');
