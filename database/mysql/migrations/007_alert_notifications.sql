-- Feature 9: Payment and budget alert notification tracking for deduplication.
-- Records every payment due-date alert and category budget overrun alert sent to
-- an event owner via SNS so repeated daily schedules do not send duplicate emails.
--
-- Deduplication semantics:
--   PAYMENT_DUE:    dedupe_key = 'due:<YYYY-MM-DD>'
--                   Re-notifies only if the expense due date changes to a new date
--                   that enters the 7-day window.
--   BUDGET_OVERRUN: dedupe_key = 'overrun:<planned_amount>:<committed_total>'
--                   Re-notifies only if spending or planned budget changes while
--                   still over budget.

CREATE TABLE IF NOT EXISTS alert_notifications (
  notification_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  event_id BIGINT UNSIGNED NOT NULL,
  owner_sub VARCHAR(128) NOT NULL,
  alert_type ENUM('PAYMENT_DUE', 'BUDGET_OVERRUN') NOT NULL,
  entity_id BIGINT UNSIGNED NOT NULL,
  dedupe_key VARCHAR(128) NOT NULL,
  alert_date DATE NOT NULL,
  details_snapshot VARCHAR(255) NOT NULL,
  sns_message_id VARCHAR(128) NULL,
  sent_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_alert_dedupe (event_id, alert_type, entity_id, dedupe_key),
  KEY idx_alert_event_date (event_id, alert_date),
  CONSTRAINT fk_alert_event FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE
);
