-- One-time migration: add restaurant_id to restaurant_order. Orders had no
-- direct link to a restaurant (only booking_id/table_id/guest_id), so
-- "this restaurant's orders" wasn't queryable without indirecting through
-- table_id or line items. Mirrors restaurant_menu_item.restaurant_id.
--
-- No existing rows in restaurant_order on local or live (confirmed before
-- writing this — the table has never had a creation UI), so the column can
-- go straight to NOT NULL, no backfill needed.
--
-- Idempotent-safe via IF NOT EXISTS. Run ONCE directly against the
-- database (NOT part of the normal reset pipeline).

ALTER TABLE restaurant_order
  ADD COLUMN IF NOT EXISTS restaurant_id UUID NOT NULL REFERENCES restaurant(id);

CREATE INDEX IF NOT EXISTS idx_restaurant_order_restaurant ON restaurant_order(restaurant_id);
