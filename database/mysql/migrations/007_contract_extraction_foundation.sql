-- MySQL 8.0. Apply once to the selected EventWise database after migration 006.
-- For mysql2 conn.query(sql) with multipleStatements enabled; no CLI preprocessing.
-- Pause document/draft writes while applying. DDL implicitly commits in MySQL.
-- Nullable additions preserve legacy drafts and F6 uploads. Existing fingerprints
-- remain unknown until trusted backend code reads and hashes the original bytes.
-- No vendor, expense or payment records are created or modified by this migration.

-- Fail before any table changes rather than deleting or merging duplicate drafts.
DROP PROCEDURE IF EXISTS eventwise_migration_007_preflight;
CREATE PROCEDURE eventwise_migration_007_preflight()
SQL SECURITY INVOKER
BEGIN
 IF EXISTS (
   SELECT 1 FROM draft_budget_items WHERE document_id IS NOT NULL
   GROUP BY event_id, document_id HAVING COUNT(*) > 1
 ) THEN
   SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Migration 007: reconcile duplicate document drafts before applying';
 END IF;
END;
CALL eventwise_migration_007_preflight();
DROP PROCEDURE eventwise_migration_007_preflight;

-- F6 may store repeated uploads; F15 deduplicates their drafts using the hash.
ALTER TABLE event_documents
 ADD COLUMN content_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
 ADD KEY idx_document_content (event_id, content_sha256),
 ADD CONSTRAINT chk_document_content_hash CHECK (content_sha256 IS NULL OR REGEXP_LIKE(content_sha256, '^[0-9a-f]{64}$', 'c'))
;

ALTER TABLE draft_budget_items
 ADD COLUMN description VARCHAR(255) NULL,
 ADD COLUMN category_id BIGINT UNSIGNED NULL,
 ADD COLUMN vendor_id BIGINT UNSIGNED NULL,
 ADD COLUMN save_action ENUM('CREATE_EXPENSE','UPDATE_EXPENSE') NOT NULL DEFAULT 'CREATE_EXPENSE',
 ADD COLUMN target_expense_id BIGINT UNSIGNED NULL,
 -- Audit ID intentionally survives expense deletion; confirmed drafts cannot be reused.
 ADD COLUMN confirmed_expense_id BIGINT UNSIGNED NULL,
 ADD COLUMN content_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
 ADD COLUMN currency_code VARCHAR(3) CHARACTER SET ascii COLLATE ascii_bin NULL,
 ADD COLUMN version BIGINT UNSIGNED NOT NULL DEFAULT 1,
 ADD COLUMN created_by_sub VARCHAR(128) NULL,
 ADD COLUMN updated_by_sub VARCHAR(128) NULL,
 ADD COLUMN confirmed_at DATETIME(6) NULL,
 ADD COLUMN updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
 ADD UNIQUE KEY uq_draft_event_pair (draft_id, event_id),
 -- Rejected drafts retain these claims; reopen the draft rather than creating another.
 ADD UNIQUE KEY uq_draft_document (event_id, document_id),
 ADD UNIQUE KEY uq_draft_content (event_id, content_sha256),
 ADD KEY idx_draft_review (event_id, status, updated_at),
 -- Draft selections may disappear before review. Confirmation must revalidate
 -- category, vendor and target-expense membership in the draft's event.
 ADD CONSTRAINT fk_draft_category FOREIGN KEY (category_id) REFERENCES budget_categories(category_id) ON DELETE SET NULL,
 ADD CONSTRAINT fk_draft_vendor FOREIGN KEY (vendor_id) REFERENCES vendors(vendor_id) ON DELETE SET NULL,
 ADD CONSTRAINT fk_draft_target_expense FOREIGN KEY (target_expense_id) REFERENCES expenses(expense_id) ON DELETE SET NULL,
 ADD CONSTRAINT chk_draft_content_hash CHECK (content_sha256 IS NULL OR REGEXP_LIKE(content_sha256, '^[0-9a-f]{64}$', 'c')),
 ADD CONSTRAINT chk_draft_currency CHECK (currency_code IS NULL OR REGEXP_LIKE(currency_code, '^[A-Z]{3}$', 'c')),
 ADD CONSTRAINT chk_draft_version CHECK (version >= 1)
;

-- One row per extraction attempt. Manual entry does not require an extraction job.
CREATE TABLE contract_extraction_jobs (
 job_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 event_id BIGINT UNSIGNED NOT NULL,
 draft_id BIGINT UNSIGNED NOT NULL,
 -- The worker may apply suggestions only if this reviewed version is still current.
 draft_version BIGINT UNSIGNED NOT NULL,
 requested_by_sub VARCHAR(128) NOT NULL,
 status ENUM('QUEUED','PROCESSING','SUCCEEDED','FAILED','CANCELLED') NOT NULL DEFAULT 'QUEUED',
 provider VARCHAR(64) NULL,
 provider_job_id VARCHAR(255) NULL,
 workflow_execution_arn VARCHAR(2048) CHARACTER SET ascii COLLATE ascii_bin NULL,
 result_json JSON NULL,
 -- Persist only sanitized errors, never credentials or the contract text.
 error_code VARCHAR(64) NULL,
 error_message VARCHAR(500) NULL,
 started_at DATETIME(6) NULL,
 completed_at DATETIME(6) NULL,
 created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
 updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
 -- A virtual key allows retries after completion, with only one active job per draft.
 active_draft_id BIGINT UNSIGNED GENERATED ALWAYS AS
   (CASE WHEN status IN ('QUEUED','PROCESSING') THEN draft_id ELSE NULL END) VIRTUAL,
 UNIQUE KEY uq_extraction_request (request_id),
 UNIQUE KEY uq_extraction_active_draft (active_draft_id),
 KEY idx_extraction_draft (draft_id, event_id),
 KEY idx_extraction_event (event_id, status, created_at),
 CONSTRAINT fk_extraction_draft_same_event FOREIGN KEY (draft_id, event_id)
   REFERENCES draft_budget_items(draft_id, event_id) ON DELETE CASCADE,
 CONSTRAINT chk_extraction_draft_version CHECK (draft_version >= 1)
);
