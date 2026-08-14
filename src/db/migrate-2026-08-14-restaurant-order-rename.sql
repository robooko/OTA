-- One-time migration: rename the "room service" tables to "restaurant
-- order" naming, and let an order attach to a restaurant_table instead of
-- (or as well as) a booking -- room service was never really about hotel
-- rooms specifically, it's an order placed with a restaurant that happens
-- to default to room delivery. Also folds in the table_id addition from
-- the same day (never applied under the old names).
--
-- room_service_item      -> restaurant_menu_item
-- room_service_order      -> restaurant_order
-- room_service_order_item -> restaurant_order_item
--
-- Idempotent-safe: guards each rename/alter so the script can be re-run.
-- Run ONCE directly against the database (NOT part of the normal reset
-- pipeline).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'room_service_item')
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'restaurant_menu_item') THEN
    ALTER TABLE room_service_item RENAME TO restaurant_menu_item;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'room_service_order')
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'restaurant_order') THEN
    ALTER TABLE room_service_order RENAME TO restaurant_order;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'room_service_order_item')
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'restaurant_order_item') THEN
    ALTER TABLE room_service_order_item RENAME TO restaurant_order_item;
  END IF;
END $$;

ALTER TABLE restaurant_order
  ADD COLUMN IF NOT EXISTS table_id UUID REFERENCES restaurant_table(id);
ALTER TABLE restaurant_order
  ALTER COLUMN booking_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'restaurant_order_booking_or_table'
  ) THEN
    ALTER TABLE restaurant_order
      ADD CONSTRAINT restaurant_order_booking_or_table CHECK (booking_id IS NOT NULL OR table_id IS NOT NULL);
  END IF;
END $$;

ALTER INDEX IF EXISTS idx_rs_order_booking RENAME TO idx_restaurant_order_booking;
ALTER INDEX IF EXISTS idx_rs_order_guest RENAME TO idx_restaurant_order_guest;
ALTER INDEX IF EXISTS idx_room_service_item_property RENAME TO idx_restaurant_menu_item_property;
ALTER INDEX IF EXISTS idx_room_service_item_restaurant RENAME TO idx_restaurant_menu_item_restaurant;
ALTER INDEX IF EXISTS idx_room_service_order_property RENAME TO idx_restaurant_order_property;

CREATE INDEX IF NOT EXISTS idx_restaurant_order_table ON restaurant_order(table_id);
