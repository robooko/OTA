-- One-time migration: add restaurant.menu_category_order, the category names
-- of its menu in display order. The menu lists categories in this order
-- (unlisted ones after, by name), then items by position within each -- see
-- migrate-2026-11-03-menu-item-position.sql. Defaults to '{}', so existing
-- menus keep their by-name category order until someone reorders them.

ALTER TABLE restaurant
  ADD COLUMN IF NOT EXISTS menu_category_order TEXT[] NOT NULL DEFAULT '{}';
