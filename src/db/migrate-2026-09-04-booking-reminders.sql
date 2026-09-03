-- Pre-visit reminders (spa appointments + restaurant reservations), email
-- and SMS. Same shape as migrate-2026-09-01-spa-review-requests.sql (a
-- property-level opt-in switch, a send-record on the booking row, and a
-- per-contact opt-out), run "before" instead of "after" and across two
-- modules sharing one property-level config.
--
-- Idempotent via IF NOT EXISTS.

ALTER TABLE property
  ADD COLUMN IF NOT EXISTS reminder_enabled      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reminder_email_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS reminder_sms_enabled   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reminder_hours_before  INT NOT NULL DEFAULT 24;

ALTER TABLE spa_appointment
  ADD COLUMN IF NOT EXISTS reminder_sent_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reminder_email_resend_id TEXT,
  ADD COLUMN IF NOT EXISTS reminder_sms_sid         TEXT,
  ADD COLUMN IF NOT EXISTS reminder_attempts        SMALLINT NOT NULL DEFAULT 0;

ALTER TABLE restaurant_reservation
  ADD COLUMN IF NOT EXISTS reminder_sent_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reminder_email_resend_id TEXT,
  ADD COLUMN IF NOT EXISTS reminder_sms_sid         TEXT,
  ADD COLUMN IF NOT EXISTS reminder_attempts        SMALLINT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_spa_appointment_reminder_pending
  ON spa_appointment (property_id, appointment_date)
  WHERE reminder_sent_at IS NULL AND status = 'confirmed';

CREATE INDEX IF NOT EXISTS idx_restaurant_reservation_reminder_pending
  ON restaurant_reservation (property_id, reservation_date)
  WHERE reminder_sent_at IS NULL AND status = 'confirmed';

-- Per-channel: a guest can opt out of reminder texts (a "STOP" reply is the
-- expectation on SMS) without silencing reminder emails, and vice versa.
CREATE TABLE IF NOT EXISTS reminder_opt_out (
  property_id UUID NOT NULL REFERENCES property(id),
  channel     VARCHAR(10) NOT NULL,
  contact     VARCHAR(255) NOT NULL, -- lower-cased email, or E.164 phone
  created_at  TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (property_id, channel, contact),
  CONSTRAINT reminder_opt_out_channel_check CHECK (channel IN ('email', 'sms'))
);
