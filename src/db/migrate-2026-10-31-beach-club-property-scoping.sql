-- One-time migration: add property_id to beach_bed and beach_booking,
-- scoping the beach club module to a property for the first time (it ran on
-- one global env API_KEY). No backfill needed -- local and live both have
-- zero rows in both tables (checked 2026-10-31), so NOT NULL is safe with no
-- DEFAULT. Bed numbers become unique per property instead of globally.
-- Idempotent-safe. Run ONCE against an already-populated database.

ALTER TABLE beach_bed     ADD COLUMN IF NOT EXISTS property_id UUID NOT NULL REFERENCES property(id) ON DELETE CASCADE;
ALTER TABLE beach_booking ADD COLUMN IF NOT EXISTS property_id UUID NOT NULL REFERENCES property(id) ON DELETE CASCADE;

ALTER TABLE beach_bed DROP CONSTRAINT IF EXISTS beach_bed_bed_number_key;
CREATE UNIQUE INDEX IF NOT EXISTS beach_bed_property_bed_number ON beach_bed(property_id, bed_number);
CREATE INDEX IF NOT EXISTS idx_beach_booking_property ON beach_booking(property_id, date);

-- UNIQUE (bed_id, date) also counted cancelled bookings, so a cancelled bed
-- could never be rebooked that day (the insert hit the constraint). Only
-- live bookings hold the bed now; the index also guards the race the
-- controller's conflict check can't.
ALTER TABLE beach_booking DROP CONSTRAINT IF EXISTS beach_booking_bed_id_date_key;
CREATE UNIQUE INDEX IF NOT EXISTS beach_booking_bed_date_live ON beach_booking(bed_id, date) WHERE status <> 'cancelled';
