-- One-time migration: add property_id to proshop_item, scoping the
-- catalogue to a property for the first time. No backfill needed --
-- both the local and live databases have zero rows (confirmed before
-- writing this migration), so NOT NULL is safe to add directly with
-- no DEFAULT. Idempotent-safe via IF NOT EXISTS. Run ONCE directly
-- against an already-populated database (NOT part of the normal reset
-- pipeline). golf_booking_item already has property_id from the golf
-- property-scoping migration -- nothing to add there.

ALTER TABLE proshop_item ADD COLUMN IF NOT EXISTS property_id UUID NOT NULL REFERENCES property(id);
CREATE INDEX IF NOT EXISTS idx_proshop_item_property ON proshop_item(property_id);
