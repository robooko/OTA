-- Restaurant and tables for Bonito
-- Run after schema.sql (and seed.sql, for consistent ordering with other seed files)
-- Note: the restaurant module has no property_id yet (out of scope for the
-- multi-property Phase 1 plan), so this data is unscoped like the rest of
-- the restaurant/spa/tours/etc. modules.
--
-- Availability is computed on demand (no time_slot grid to seed) from the
-- restaurant's service_period row(s) plus its own slot_interval_minutes/
-- default_duration_minutes columns, set below.

WITH new_restaurant AS (
  INSERT INTO restaurant (name, description, phone, slot_interval_minutes, default_duration_minutes, closed_days)
  VALUES (
    'Bonito',
    'Bonito''s signature restaurant, serving fresh local produce with seasonal tasting menus.',
    '+1-555-0199',
    15, 90, '{7}'
  )
  RETURNING id
), new_period AS (
  INSERT INTO service_period (restaurant_id, start_time, end_time)
  SELECT new_restaurant.id, '19:00', '22:30'
  FROM new_restaurant
)
INSERT INTO restaurant_table (restaurant_id, table_number, seats, location)
SELECT new_restaurant.id, t.table_number, t.seats, t.location
FROM new_restaurant, (VALUES
  ('T1', 2, 'Indoor'),
  ('T2', 2, 'Indoor'),
  ('T3', 4, 'Indoor'),
  ('T4', 4, 'Terrace'),
  ('T5', 6, 'Terrace')
) AS t(table_number, seats, location);
