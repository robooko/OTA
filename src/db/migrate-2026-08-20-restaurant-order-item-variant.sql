-- One-time migration: add variant to restaurant_order_item. Menu items can
-- carry selectable variants (restaurant_menu_item.variants, e.g. cooking
-- style), but there was nowhere to record which one a guest picked at order
-- time -- the kitchen would see "Eggs Your Way x1" with no way to know
-- Scrambled vs Fried vs Poached was ordered.
--
-- Idempotent-safe via IF NOT EXISTS. Run ONCE directly against the
-- database (NOT part of the normal reset pipeline).

ALTER TABLE restaurant_order_item
  ADD COLUMN IF NOT EXISTS variant VARCHAR(100);
