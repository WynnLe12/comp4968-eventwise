-- Retain existing memberships and leave names unknown until verified.
ALTER TABLE event_members ADD COLUMN display_name VARCHAR(256) NULL DEFAULT NULL;
