-- Restaurants and tables for Bimini, Betula, and Barry
-- Run after schema.sql (and seed.sql/seed-restaurant-bonito.sql, for consistent
-- ordering with other seed files)
-- Note: the restaurant module has no property_id yet (out of scope for the
-- multi-property Phase 1 plan), so this data is unscoped like the rest of
-- the restaurant/spa/tours/etc. modules.
--
-- Availability is computed on demand (no time_slot grid to seed) from each
-- restaurant's service_period row(s) plus its own slot_interval_minutes/
-- default_duration_minutes columns, set below.

WITH new_restaurant AS (
  INSERT INTO restaurant (name, description, phone, slot_interval_minutes, default_duration_minutes)
  VALUES (
    'Bimini',
    'A relaxed seafood shack serving the day''s catch with beachfront views.',
    '+1-555-0201',
    15, 75
  )
  RETURNING id
), new_period AS (
  INSERT INTO service_period (restaurant_id, start_time, end_time)
  SELECT new_restaurant.id, '12:00', '15:00'
  FROM new_restaurant
)
INSERT INTO restaurant_table (restaurant_id, table_number, seats, location)
SELECT new_restaurant.id, t.table_number, t.seats, t.location
FROM new_restaurant, (VALUES
  ('T1', 2, 'Beachfront'),
  ('T2', 2, 'Beachfront'),
  ('T3', 4, 'Indoor'),
  ('T4', 4, 'Indoor')
) AS t(table_number, seats, location);

WITH new_restaurant AS (
  INSERT INTO restaurant (name, description, phone, slot_interval_minutes, default_duration_minutes)
  VALUES (
    'Betula',
    'A casual European bistro with a seasonal small-plates menu.',
    '+1-555-0202',
    15, 75
  )
  RETURNING id
), new_tables AS (
  INSERT INTO restaurant_table (restaurant_id, table_number, seats, location)
  SELECT new_restaurant.id, t.table_number, t.seats, t.location
  FROM new_restaurant, (VALUES
    ('T1', 2, 'Indoor'),
    ('T2', 2, 'Indoor'),
    ('T3', 4, 'Indoor'),
    ('T4', 4, 'Terrace')
  ) AS t(table_number, seats, location)
), new_period AS (
  INSERT INTO service_period (restaurant_id, start_time, end_time)
  SELECT new_restaurant.id, '17:30', '23:00'
  FROM new_restaurant
)
INSERT INTO restaurant_seasonal_closure (restaurant_id, start_month, start_day, end_month, end_day)
SELECT new_restaurant.id, sc.start_month, sc.start_day, sc.end_month, sc.end_day
FROM new_restaurant, (VALUES
  (4, 15, 5, 25),
  (10, 1, 11, 25)
) AS sc(start_month, start_day, end_month, end_day);

WITH new_restaurant AS (
  INSERT INTO restaurant (name, description, phone, slot_interval_minutes, default_duration_minutes)
  VALUES (
    'Barry',
    'A steakhouse and grill specialising in charcoal-fired cuts and cocktails.',
    '+1-555-0203',
    15, 90
  )
  RETURNING id
), new_period AS (
  INSERT INTO service_period (restaurant_id, start_time, end_time)
  SELECT new_restaurant.id, '17:30', '23:00'
  FROM new_restaurant
)
INSERT INTO restaurant_table (restaurant_id, table_number, seats, location)
SELECT new_restaurant.id, t.table_number, t.seats, t.location
FROM new_restaurant, (VALUES
  ('T1', 2, 'Indoor'),
  ('T2', 4, 'Indoor'),
  ('T3', 4, 'Indoor'),
  ('T4', 6, 'Terrace'),
  ('T5', 6, 'Terrace')
) AS t(table_number, seats, location);
