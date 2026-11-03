-- One-time migration: add restaurant_menu_item.sold_out. A sold-out item stays
-- on the menu (guests see it marked sold out) but orders for it are refused.
-- Separate from status, where 'inactive' means deleted.

ALTER TABLE restaurant_menu_item
  ADD COLUMN IF NOT EXISTS sold_out BOOLEAN NOT NULL DEFAULT false;
