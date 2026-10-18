-- The AI receptionist answers texts too (controllers/sms.js), on the same
-- number as calls. Texts are filed as event inquiries with source 'sms'.
-- A call carries its conversation in Twilio's action URL; a text has
-- nowhere to, so sms_thread keeps it per property and guest number. A thread
-- idle for a day starts afresh (and is charged again). Safe to run twice.
--   node scripts/run-migration.js src/db/migrate-2026-10-18-sms-receptionist.sql

ALTER TABLE event_inquiry DROP CONSTRAINT IF EXISTS event_inquiry_source_check;
ALTER TABLE event_inquiry ADD CONSTRAINT event_inquiry_source_check CHECK (source IN ('web', 'phone', 'sms'));

CREATE TABLE IF NOT EXISTS sms_thread (
  property_id UUID        NOT NULL REFERENCES property(id) ON DELETE CASCADE,
  phone       VARCHAR(20) NOT NULL,
  turns       JSONB       NOT NULL DEFAULT '[]',
  inquiry_id  UUID        REFERENCES event_inquiry(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id, phone)
);
