-- The id an order had in the system it was imported from
-- (POST /api/restaurant-orders/import); re-imports skip it.
ALTER TABLE restaurant_order ADD COLUMN IF NOT EXISTS external_ref VARCHAR(100);
CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurant_order_external_ref ON restaurant_order (property_id, external_ref) WHERE external_ref IS NOT NULL;
