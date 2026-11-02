-- Room baskets: a website checkout that never got paid (see src/lib/roomBaskets.js).
-- Reuses the shop basket reminder settings and opt-out list.
ALTER TABLE booking ADD COLUMN IF NOT EXISTS website_checkout BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE booking ADD COLUMN IF NOT EXISTS basket_reminder_sent_at TIMESTAMPTZ;
ALTER TABLE booking ADD COLUMN IF NOT EXISTS basket_reminder_resend_email_id VARCHAR(255);
CREATE INDEX IF NOT EXISTS idx_booking_website_checkout ON booking (property_id, created_at) WHERE website_checkout;
