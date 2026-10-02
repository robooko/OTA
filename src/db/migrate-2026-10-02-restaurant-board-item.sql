-- One-time migration: the in-shop board (Leroy & Lewis's yellow meats
-- board) -- what a restaurant has on today and what's sold out. Unpriced
-- (sold by weight), so not restaurant_menu_item. The website keeps the
-- copy (description, notes) in its CMS and matches rows by name; OTA owns
-- only on/off (status) and sold_out, and publishes every change on
-- property:{id}:board.
--
-- Idempotent-safe via IF NOT EXISTS. Run ONCE directly against the
-- database (NOT part of the normal reset pipeline).

CREATE TABLE IF NOT EXISTS restaurant_board_item (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   UUID          NOT NULL REFERENCES property(id),
  restaurant_id UUID          NOT NULL REFERENCES restaurant(id),
  name          VARCHAR(100)  NOT NULL,
  sold_out      BOOLEAN       NOT NULL DEFAULT false,
  position      INTEGER       NOT NULL DEFAULT 0,
  status        VARCHAR(20)   NOT NULL DEFAULT 'active'
);

CREATE INDEX IF NOT EXISTS restaurant_board_item_restaurant_idx ON restaurant_board_item (restaurant_id, position);
