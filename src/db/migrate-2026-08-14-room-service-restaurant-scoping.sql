-- One-time migration: add property_id to room_service_item and
-- room_service_order (previously unscoped -- one shared property-wide
-- menu/order list, same gap golf and the old spa tables had), and
-- restaurant_id to room_service_item so a menu item can optionally
-- belong to a specific restaurant (mirrors spa_treatment.spa_id --
-- "room service" is modeled as belonging to a restaurant, not a
-- separate parallel system).
--
-- No existing rows in either table on local or live (confirmed before
-- writing this), so property_id can go straight to NOT NULL -- no
-- nullable -> backfill -> NOT NULL sequence needed, unlike the
-- restaurant/spa property-scoping migrations which had real data to
-- preserve. restaurant_id stays nullable indefinitely: not every menu
-- item needs to belong to a specific restaurant.
--
-- Idempotent-safe via IF NOT EXISTS. Run ONCE directly against the
-- database (NOT part of the normal reset pipeline).

ALTER TABLE room_service_item
  ADD COLUMN IF NOT EXISTS property_id UUID NOT NULL REFERENCES property(id);
ALTER TABLE room_service_item
  ADD COLUMN IF NOT EXISTS restaurant_id UUID REFERENCES restaurant(id);
ALTER TABLE room_service_order
  ADD COLUMN IF NOT EXISTS property_id UUID NOT NULL REFERENCES property(id);

CREATE INDEX IF NOT EXISTS idx_room_service_item_property    ON room_service_item(property_id);
CREATE INDEX IF NOT EXISTS idx_room_service_item_restaurant  ON room_service_item(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_room_service_order_property   ON room_service_order(property_id);
