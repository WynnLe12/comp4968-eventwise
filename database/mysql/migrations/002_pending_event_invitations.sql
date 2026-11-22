-- MySQL 8.0. Run once on the selected EventWise database, with invitation writes paused.
-- Preflight and reconcile active duplicates as described in docs/api/events-lambda.md.
-- Expire elapsed pending rows before applying the ALTER. The unique index intentionally
-- rejects any remaining duplicates rather than choosing a winner or deleting history.
ALTER TABLE event_invitations
  ADD COLUMN pending_email VARCHAR(254) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin
    GENERATED ALWAYS AS (CASE WHEN status = 'PENDING' THEN LOWER(TRIM(email)) END) VIRTUAL,
  ADD UNIQUE KEY uq_invite_pending_email (event_id, pending_email),
  ADD KEY idx_invite_active (event_id, status, expires_at);
