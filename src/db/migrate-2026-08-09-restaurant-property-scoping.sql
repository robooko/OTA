-- One-time migration: add property_id to the restaurant module tables
-- (restaurant, restaurant_table, service_period, restaurant_reservation,
-- restaurant_seasonal_closure), mirroring how every Phase-1 core table
-- (guest, room, booking, extra, ...) already carries its own property_id
-- rather than being scoped via a parent-chain join. Backfills existing
-- rows using a confirmed name -> property mapping (there is no way to
-- derive this automatically; it was confirmed with the product owner),
-- then enforces NOT NULL. Idempotent-safe via IF NOT EXISTS on the column
-- adds/indexes; the UPDATE/backfill statements are naturally idempotent
-- (a no-op once every row already has the correct value). Run ONCE
-- directly against an already-populated database (NOT part of the normal
-- reset pipeline).

-- 1. Add nullable columns
ALTER TABLE restaurant                  ADD COLUMN IF NOT EXISTS property_id UUID REFERENCES property(id);
ALTER TABLE restaurant_table            ADD COLUMN IF NOT EXISTS property_id UUID REFERENCES property(id);
ALTER TABLE service_period              ADD COLUMN IF NOT EXISTS property_id UUID REFERENCES property(id);
ALTER TABLE restaurant_reservation      ADD COLUMN IF NOT EXISTS property_id UUID REFERENCES property(id);
ALTER TABLE restaurant_seasonal_closure ADD COLUMN IF NOT EXISTS property_id UUID REFERENCES property(id);

-- 2. Backfill restaurant.property_id by name (confirmed mapping)
UPDATE restaurant SET property_id = 'e1000000-0000-0000-0000-000000000003'
  WHERE name IN ('Bonito', 'Bimini', 'Betula', 'Barry') AND property_id IS NULL;
UPDATE restaurant SET property_id = 'e1000000-0000-0000-0000-000000000004'
  WHERE name IN ('BBYC', 'Pirates Bight') AND property_id IS NULL;

-- 3. Backfill the child tables from their restaurant
UPDATE restaurant_table rt
  SET property_id = r.property_id
  FROM restaurant r
  WHERE r.id = rt.restaurant_id AND rt.property_id IS NULL;

UPDATE service_period sp
  SET property_id = r.property_id
  FROM restaurant r
  WHERE r.id = sp.restaurant_id AND sp.property_id IS NULL;

UPDATE restaurant_seasonal_closure sc
  SET property_id = r.property_id
  FROM restaurant r
  WHERE r.id = sc.restaurant_id AND sc.property_id IS NULL;

UPDATE restaurant_reservation rr
  SET property_id = rt.property_id
  FROM restaurant_table rt
  WHERE rt.id = rr.table_id AND rr.property_id IS NULL;

-- 4. Enforce NOT NULL now that every row is backfilled. If any of these
-- fail with "column contains null values", STOP -- it means a restaurant
-- exists outside the 6 named above and needs a mapping decision before
-- proceeding (see Step 4's pre-check, which catches this earlier).
ALTER TABLE restaurant                  ALTER COLUMN property_id SET NOT NULL;
ALTER TABLE restaurant_table            ALTER COLUMN property_id SET NOT NULL;
ALTER TABLE service_period              ALTER COLUMN property_id SET NOT NULL;
ALTER TABLE restaurant_reservation      ALTER COLUMN property_id SET NOT NULL;
ALTER TABLE restaurant_seasonal_closure ALTER COLUMN property_id SET NOT NULL;

-- 5. Indexes
CREATE INDEX IF NOT EXISTS idx_restaurant_property             ON restaurant(property_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_table_property        ON restaurant_table(property_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_res_property          ON restaurant_reservation(property_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_seasonal_closure_prop ON restaurant_seasonal_closure(property_id);
CREATE INDEX IF NOT EXISTS idx_service_period_property          ON service_period(property_id);
