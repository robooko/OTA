-- One-time migration: add allergens to restaurant_menu_item. Not a fixed
-- taxonomy (e.g. the 14 EU allergens) -- an editable, property-wide list
-- that grows as staff add new allergen names, same pattern as category.
--
-- Idempotent-safe via IF NOT EXISTS. Run ONCE directly against the
-- database (NOT part of the normal reset pipeline).

ALTER TABLE restaurant_menu_item
  ADD COLUMN IF NOT EXISTS allergens TEXT[] NOT NULL DEFAULT '{}';
