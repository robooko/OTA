-- AI phone receptionist (controllers/voice.js): a Twilio number per property
-- answers calls and files them as event inquiries. Phone callers often give
-- no email, so event_inquiry.email becomes optional; `source` tells calls
-- apart from web enquiries. Safe to run twice.
--   node scripts/run-migration.js src/db/migrate-2026-10-17-phone-receptionist.sql

ALTER TABLE event_inquiry ALTER COLUMN email DROP NOT NULL;
ALTER TABLE event_inquiry ADD COLUMN IF NOT EXISTS source VARCHAR(10) NOT NULL DEFAULT 'web'
  CHECK (source IN ('web', 'phone'));

-- voice_number is the Twilio number (E.164) that rings this property; set by
-- us when the number is bought, never by a property admin, so one venue
-- can't claim another's line. Calls are routed by the dialled number.
ALTER TABLE property ADD COLUMN IF NOT EXISTS voice_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE property ADD COLUMN IF NOT EXISTS voice_number VARCHAR(20) UNIQUE;
ALTER TABLE property ADD COLUMN IF NOT EXISTS voice_transfer_number VARCHAR(20);
