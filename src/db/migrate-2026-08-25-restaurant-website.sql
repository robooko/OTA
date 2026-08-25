-- One-time migration: let a restaurant point at one of its property's
-- websites (property_website). The dashboard's per-table QR codes encode
-- `{website.url}/?restaurant_id=…&table_id=…` when set, and the bare table
-- id when not -- so nothing changes for existing restaurants (NULL).
--
-- Idempotent-safe via IF NOT EXISTS.

ALTER TABLE restaurant
  ADD COLUMN IF NOT EXISTS website_id UUID REFERENCES property_website(id);
