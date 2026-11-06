-- Booking sources for imported OTA (Booking.com, Agoda, ...) and corporate
-- bookings, and the id a booking had in the system it was imported from.
ALTER TABLE booking DROP CONSTRAINT IF EXISTS booking_source_check;
ALTER TABLE booking ADD CONSTRAINT booking_source_check
  CHECK (source IN ('web', 'phone', 'email', 'walk_in', 'agent', 'ota', 'corporate'));
ALTER TABLE booking ADD COLUMN IF NOT EXISTS external_ref VARCHAR(100);
CREATE UNIQUE INDEX IF NOT EXISTS idx_booking_external_ref ON booking (property_id, external_ref) WHERE external_ref IS NOT NULL;
