-- Apply after migration 002. Existing invitations keep their original status and token hash.
-- The envelope stores the authenticated ciphertext of the original acceptance URL.
ALTER TABLE event_invitations
  ADD COLUMN email_envelope BLOB NULL,
  ADD COLUMN email_claim_id CHAR(36) NULL,
  ADD COLUMN email_claim_until DATETIME(6) NULL,
  ADD COLUMN email_queued_at DATETIME(6) NULL;
