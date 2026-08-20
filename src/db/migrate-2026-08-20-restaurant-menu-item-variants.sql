-- One-time migration: add variants to restaurant_menu_item. Not a fixed
-- taxonomy -- an editable, property-wide list that grows as staff add new
-- variant names (e.g. sizes, spice levels, preparation styles), same
-- pattern as allergens.
--
-- Idempotent-safe via IF NOT EXISTS. Run ONCE directly against the
-- database (NOT part of the normal reset pipeline).

ALTER TABLE restaurant_menu_item
  ADD COLUMN IF NOT EXISTS variants TEXT[] NOT NULL DEFAULT '{}';
