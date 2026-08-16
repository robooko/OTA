-- One-time migration: creates event_inquiry_message, a new table, so
-- there's no backfill concern -- CREATE TABLE IF NOT EXISTS is
-- inherently idempotent-safe.

CREATE TABLE IF NOT EXISTS event_inquiry_message (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_inquiry_id  UUID NOT NULL REFERENCES event_inquiry(id),
  direction         VARCHAR(10) NOT NULL CHECK (direction IN ('outbound', 'inbound')),
  body              TEXT NOT NULL,
  resend_email_id   TEXT,
  created_at        TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_event_inquiry_message_inquiry ON event_inquiry_message(event_inquiry_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_inquiry_message_resend_id
  ON event_inquiry_message(resend_email_id) WHERE resend_email_id IS NOT NULL;
