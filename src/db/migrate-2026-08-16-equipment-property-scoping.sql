-- One-time migration: adds property_id to equipment and equipment_hire,
-- scoping the module to a property for the first time. No backfill
-- needed -- both tables have zero rows on both local and live
-- (confirmed before writing this migration), so NOT NULL is safe to
-- add directly with no DEFAULT. Idempotent-safe via IF NOT EXISTS.

ALTER TABLE equipment      ADD COLUMN IF NOT EXISTS property_id UUID NOT NULL REFERENCES property(id);
ALTER TABLE equipment_hire ADD COLUMN IF NOT EXISTS property_id UUID NOT NULL REFERENCES property(id);
CREATE INDEX IF NOT EXISTS idx_equipment_property      ON equipment(property_id);
CREATE INDEX IF NOT EXISTS idx_equipment_hire_property ON equipment_hire(property_id);
