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
