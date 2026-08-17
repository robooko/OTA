-- One-time migration: add event_inquiry.restaurant_id, an optional FK to
-- restaurant. A property can have multiple restaurants, so an inquiry may
-- know upfront which one it's for (set by the inquiry source) while still
-- allowing NULL for inquiries that don't specify one. Nullable, so no
-- backfill needed for existing rows.

ALTER TABLE event_inquiry
  ADD COLUMN IF NOT EXISTS restaurant_id UUID REFERENCES restaurant(id);
