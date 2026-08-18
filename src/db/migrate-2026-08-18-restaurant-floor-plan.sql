-- One-time migration: add restaurant.floor_plan, a JSONB blob holding the
-- staff-built visual table layout ({ tables: [{otaId, number, seats, x, y,
-- shape}], w, h }). Mirrors restaurant_menu_item.translations -- see
-- migrate-2026-08-18-menu-item-translations.sql. Preserves every existing
-- row; floor_plan defaults to '{}' for them.

ALTER TABLE restaurant
  ADD COLUMN IF NOT EXISTS floor_plan JSONB NOT NULL DEFAULT '{}';
