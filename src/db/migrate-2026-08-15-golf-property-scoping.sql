-- One-time migration: add property_id to golf_course, tee_time,
-- golf_booking, and golf_booking_item, scoping the golf module to a
-- property for the first time. No backfill needed -- both the local
-- and live databases have zero rows in all four tables (confirmed
-- before writing this migration), so NOT NULL is safe to add directly
-- with no DEFAULT. Idempotent-safe via IF NOT EXISTS. Run ONCE
-- directly against an already-populated database (NOT part of the
-- normal reset pipeline).

ALTER TABLE golf_course       ADD COLUMN IF NOT EXISTS property_id UUID NOT NULL REFERENCES property(id);
ALTER TABLE tee_time          ADD COLUMN IF NOT EXISTS property_id UUID NOT NULL REFERENCES property(id);
ALTER TABLE golf_booking      ADD COLUMN IF NOT EXISTS property_id UUID NOT NULL REFERENCES property(id);
ALTER TABLE golf_booking_item ADD COLUMN IF NOT EXISTS property_id UUID NOT NULL REFERENCES property(id);
CREATE INDEX IF NOT EXISTS idx_golf_course_property       ON golf_course(property_id);
CREATE INDEX IF NOT EXISTS idx_tee_time_property          ON tee_time(property_id);
CREATE INDEX IF NOT EXISTS idx_golf_booking_property      ON golf_booking(property_id);
CREATE INDEX IF NOT EXISTS idx_golf_booking_item_property ON golf_booking_item(property_id);
