-- One-time migration: add property_id to tour, tour_slot, and tour_booking,
-- scoping the tours module to a property for the first time. No backfill
-- needed -- both the local and live databases have zero rows in all three
-- tables (confirmed before writing this migration), so NOT NULL is safe
-- to add directly with no DEFAULT. Idempotent-safe via IF NOT EXISTS. Run
-- ONCE directly against an already-populated database (NOT part of the
-- normal reset pipeline).

ALTER TABLE tour         ADD COLUMN IF NOT EXISTS property_id UUID NOT NULL REFERENCES property(id);
ALTER TABLE tour_slot    ADD COLUMN IF NOT EXISTS property_id UUID NOT NULL REFERENCES property(id);
ALTER TABLE tour_booking ADD COLUMN IF NOT EXISTS property_id UUID NOT NULL REFERENCES property(id);
CREATE INDEX IF NOT EXISTS idx_tour_property         ON tour(property_id);
CREATE INDEX IF NOT EXISTS idx_tour_slot_property     ON tour_slot(property_id);
CREATE INDEX IF NOT EXISTS idx_tour_booking_property  ON tour_booking(property_id);
