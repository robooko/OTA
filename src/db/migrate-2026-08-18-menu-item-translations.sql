-- One-time migration: add restaurant_menu_item.translations, a JSONB
-- key/value column (language code -> { name, description }) for
-- multi-language menu items. Mirrors restaurant_reservation.metadata --
-- see migrate-2026-07-23-restaurant-reservation-metadata.sql. Preserves
-- every existing row; translations defaults to '{}' for them.

ALTER TABLE restaurant_menu_item
  ADD COLUMN IF NOT EXISTS translations JSONB NOT NULL DEFAULT '{}';
